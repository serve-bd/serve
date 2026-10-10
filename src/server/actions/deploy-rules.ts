"use server";

import { cannotMessage } from "@/lib/permissions";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { logActivity } from "@/server/activity";
import { enqueue } from "@/server/queue";
import { queueCommitStatus } from "@/server/git/commit-status";
import { projectInOrg, serviceInOrg } from "@/server/services/access";
import { type DeployRules, freezeState, freezeUntil, validTime } from "@/lib/deploy-rules";

const time = z.string().refine(validTime, "Use a time like 22:00.");

const rulesSchema = z.object({
  approval: z.object({ enabled: z.boolean(), environmentIds: z.array(z.string().max(64)).max(100) }),
  freeze: z.object({
    now: z.object({ until: z.string().datetime().nullable(), reason: z.string().trim().max(200).nullable() }).nullable(),
    windows: z.array(z.object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7), start: time, end: time })),
    timezone: z.string().max(64),
    environmentIds: z.array(z.string().max(64)).max(100),
  }),
});

/** Save a project's deploy rules: which environments wait for approval, and when deploys are frozen. */
export async function saveDeployRules(projectId: string, input: z.input<typeof rulesSchema>) {
  return act(async () => {
    const ctx = await requirePermission("projects.manage");
    const project = await projectInOrg(projectId, ctx.org.id);
    const data = rulesSchema.parse(input);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: data.freeze.timezone });
    } catch {
      throw new UserError("Pick a time zone from the list.");
    }
    const envs = await db.select({ id: schema.environment.id }).from(schema.environment).where(eq(schema.environment.projectId, projectId));
    const known = (ids: string[]) => ids.filter((id) => envs.some((e) => e.id === id));
    const before = project.deployRules?.freeze?.now ?? null;
    // Who may approve decides which deploys wait, as for a service's own approval.
    const approvalBefore = project.deployRules?.approval;
    const approvalAfter = { enabled: data.approval.enabled, environmentIds: known(data.approval.environmentIds) };
    const sameApproval =
      !!approvalBefore?.enabled === approvalAfter.enabled &&
      known(approvalBefore?.environmentIds ?? [])
        .sort()
        .join() === [...approvalAfter.environmentIds].sort().join();
    if (!sameApproval && !ctx.can("deploys.approve")) throw new UserError(cannotMessage("deploys.approve"));
    const rules: DeployRules = {
      approval: approvalAfter,
      freeze: {
        // Turned on now keeps the moment it started; still on keeps it as it was.
        now: data.freeze.now ? { since: before?.since ?? new Date().toISOString(), until: data.freeze.now.until, reason: data.freeze.now.reason || null } : null,
        windows: data.freeze.windows,
        timezone: data.freeze.timezone,
        environmentIds: known(data.freeze.environmentIds),
      },
    };
    await db.update(schema.project).set({ deployRules: rules }).where(eq(schema.project.id, projectId));
    if (!!before !== !!rules.freeze?.now)
      await logActivity({
        userId: ctx.user.id,
        organizationId: ctx.org.id,
        projectId,
        action: rules.freeze?.now ? "deploys.frozen" : "deploys.unfrozen",
        message: rules.freeze?.now ? `Froze deploys of ${project.name}` : `Ended the deploy freeze of ${project.name}`,
      });
    return null;
  });
}

async function waitingDeployment(deploymentId: string, organizationId: string) {
  const [dep] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, deploymentId));
  if (!dep) throw new UserError("Deployment not found.");
  const { service } = await serviceInOrg(dep.serviceId, organizationId);
  if (dep.status !== "waiting") throw new UserError("This deployment is not waiting for approval anymore.");
  return { dep, service };
}

/** Let a deployment that waits for approval go ahead. A freeze still holds it back. */
export async function approveDeployment(deploymentId: string) {
  return act(async () => {
    const ctx = await requirePermission("deploys.approve");
    const { dep, service } = await waitingDeployment(deploymentId, ctx.org.id);
    const [project] = await db.select({ rules: schema.project.deployRules }).from(schema.project).where(eq(schema.project.id, service.projectId));
    const freeze = freezeState(project?.rules, service.environmentId);
    if (freeze.frozen) throw new UserError(`Deploys are frozen ${freezeUntil(freeze, project?.rules?.freeze?.timezone || "UTC")}. Approve it once the freeze ends.`);
    const [approved] = await db
      .update(schema.deployment)
      .set({ status: "queued", approvedBy: ctx.user.id, approvedAt: new Date() })
      .where(and(eq(schema.deployment.id, dep.id), eq(schema.deployment.status, "waiting")))
      .returning({ id: schema.deployment.id });
    if (!approved) throw new UserError("This deployment is not waiting for approval anymore.");
    await queueCommitStatus(dep.id);
    await enqueue("deploy", { deploymentId: dep.id }, { concurrencyKey: `service:${service.id}` });
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "deploy.approved",
      targetType: "service",
      targetId: service.id,
      message: `Approved a deployment of ${service.name}`,
    });
    return null;
  });
}

/** Turn down a deployment that waits for approval, optionally saying why. */
export async function rejectDeployment(deploymentId: string, reason?: string | null) {
  return act(async () => {
    const ctx = await requirePermission("deploys.approve");
    const { dep, service } = await waitingDeployment(deploymentId, ctx.org.id);
    const who = ctx.user.name || ctx.user.email;
    const why = z.string().trim().max(500, "Keep the reason under 500 characters.").nullish().parse(reason);
    const text = why ? `Rejected by ${who}: ${why.replace(/[.\s]+$/, "")}.` : `Rejected by ${who}.`;
    await db
      .update(schema.deployment)
      .set({ status: "cancelled", finishedAt: new Date(), error: text, logs: `${text}\n` })
      .where(and(eq(schema.deployment.id, dep.id), eq(schema.deployment.status, "waiting")));
    await queueCommitStatus(dep.id);
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "deploy.rejected",
      targetType: "service",
      targetId: service.id,
      message: `Rejected a deployment of ${service.name}`,
    });
    return null;
  });
}

/**
 * A service's own approval: always wait, never wait, or follow the project (null). Only someone who
 * can approve deploys may change it, or a developer could take their service out of the rule.
 */
export async function setServiceApproval(serviceId: string, mode: "always" | "never" | null) {
  return act(async () => {
    const ctx = await requirePermission("deploys.approve");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type === "database") throw new UserError("Database deploys never wait for approval.");
    const value = mode === "always" || mode === "never" ? mode : null;
    await db.update(schema.service).set({ deployApproval: value }).where(eq(schema.service.id, serviceId));
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "deploy.approval",
      targetType: "service",
      targetId: service.id,
      message:
        value === "always"
          ? `Made deploys of ${service.name} wait for approval`
          : value === "never"
            ? `Let deploys of ${service.name} skip approval`
            : `Made deploys of ${service.name} follow the project's approval rule`,
    });
    return null;
  });
}
