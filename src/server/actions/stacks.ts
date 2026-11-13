"use server";

import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { logActivity } from "@/server/activity";
import { projectInOrg } from "@/server/services/access";
import { STACK_FILE } from "@/lib/stack";
import type { DeploymentTrigger } from "@/server/db/schema";
import { applyStack } from "@/server/stacks/apply";
import { planStack, type StackPlan, stackServices } from "@/server/stacks/plan";
import { cancelStackRun, runView, startStackRun } from "@/server/stacks/run";

const inputSchema = z.object({
  text: z.string().min(1, `Paste ${STACK_FILE}`),
  values: z.record(z.string(), z.string()).optional(),
  files: z.record(z.string(), z.string()).optional(),
  folder: z.string().max(200).optional(),
});
const optionsSchema = z.object({
  force: z.boolean().default(false),
  removeOrphans: z.boolean().default(false),
  /** Deploy services that did not change too. */
  redeploy: z.boolean().default(false),
  dashboard: z.boolean().default(false),
  /** Make the changes without deploying them. */
  noDeploy: z.boolean().default(false),
  trigger: z.enum(["manual", "api", "cli"]).default("manual"),
});

export type StackInputData = z.input<typeof inputSchema>;
export type StackOptionsData = z.input<typeof optionsSchema>;

async function environmentOf(environmentId: string, orgId: string) {
  const [env] = await db.select().from(schema.environment).where(eq(schema.environment.id, environmentId));
  if (!env) throw new UserError("Environment not found.");
  await projectInOrg(env.projectId, orgId);
  return env;
}

const problems = (plan: StackPlan) => {
  if (plan.needs.files.length) return `${STACK_FILE} names files that were not sent: ${plan.needs.files.join(", ")}.`;
  return plan.errors.length ? `${STACK_FILE} has ${plan.errors.length === 1 ? "a problem" : "problems"}:\n${plan.errors.map((e) => `  ${e}`).join("\n")}` : null;
};

/** What `up` would do, changing nothing. */
export async function planStackAction(environmentId: string, input: StackInputData, options: StackOptionsData = {}) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const env = await environmentOf(environmentId, ctx.org.id);
    const opts = optionsSchema.parse(options);
    const { plan } = await planStack({ organizationId: ctx.org.id, projectId: env.projectId, environmentId }, inputSchema.parse(input), opts);
    return plan;
  });
}

/**
 * Creates and updates the stack's services, then deploys them wave by wave (unless noDeploy).
 * Folders the CLI uploads are listed in `uploads`: the run waits for them.
 */
export async function upStack(environmentId: string, input: StackInputData, options: StackOptionsData = {}) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const opts = optionsSchema.parse(options);
    if (!opts.noDeploy && !ctx.can("services.deploy")) throw new UserError("Deploying the stack needs the right to deploy services. Use noDeploy to only make the changes.");
    const env = await environmentOf(environmentId, ctx.org.id);
    const planCtx = { organizationId: ctx.org.id, projectId: env.projectId, environmentId };
    const { plan, resolved } = await planStack(planCtx, inputSchema.parse(input), opts);
    const problem = problems(plan);
    if (problem) throw new UserError(problem);
    const applied = await applyStack({ ...planCtx, userId: ctx.user.id }, plan, resolved, opts);
    await logActivity({
      userId: ctx.user.id,
      projectId: env.projectId,
      action: "stack.applied",
      targetType: "environment",
      targetId: environmentId,
      message: `Applied stack ${plan.stack}: ${applied.filter((a) => a.action === "create").length} created, ${applied.filter((a) => a.action === "update").length} changed`,
    });
    if (opts.noDeploy) return { plan, services: applied, runId: null as string | null };
    const rows = await stackServices(environmentId, plan.stack as string);
    const parts = applied.map((a) => {
      const p = plan.services.find((s) => s.key === a.key);
      const row = rows.find((r) => r.id === a.serviceId);
      const stale = !row || ["idle", "failed", "crashed", "stopped"].includes(row.status);
      return {
        key: a.key,
        serviceId: a.serviceId,
        wave: p?.wave ?? 0,
        needs: p?.needs ?? [],
        // A folder is sent on every up: its files may have changed, so it always deploys.
        deploy: opts.redeploy || a.action !== "unchanged" || stale || !!a.upload,
        upload: !!a.upload,
      };
    });
    const runId = await startStackRun(environmentId, plan.stack as string, parts, { userId: ctx.user.id, trigger: opts.trigger as DeploymentTrigger });
    return { plan, services: applied, runId };
  });
}

/** The stacks of an environment, with their services and last run. */
export async function stackStatus(environmentId: string, name?: string | null) {
  return act(async () => {
    const ctx = await requirePermission("projects.view");
    await environmentOf(environmentId, ctx.org.id);
    const rows = await db
      .select({
        id: schema.service.id,
        name: schema.service.name,
        type: schema.service.type,
        status: schema.service.status,
        stackName: schema.service.stackName,
        stackKey: schema.service.stackKey,
      })
      .from(schema.service)
      .where(and(eq(schema.service.environmentId, environmentId), isNotNull(schema.service.stackName)));
    const names = [...new Set(rows.map((r) => r.stackName as string))].filter((n) => !name || n === name).sort();
    if (name && !names.length) throw new UserError(`No stack named ${name} in this environment.`);
    return Promise.all(
      names.map(async (stack) => {
        const [run] = await db
          .select()
          .from(schema.stackRun)
          .where(and(eq(schema.stackRun.environmentId, environmentId), eq(schema.stackRun.stackName, stack)))
          .orderBy(desc(schema.stackRun.createdAt))
          .limit(1);
        return {
          name: stack,
          services: rows.filter((r) => r.stackName === stack).map(({ stackName: _s, ...r }) => r),
          lastRun: run ? runView(run) : null,
        };
      }),
    );
  });
}

export async function stackRun(runId: string) {
  return act(async () => {
    const ctx = await requirePermission("projects.view");
    const [run] = await db.select().from(schema.stackRun).where(eq(schema.stackRun.id, runId));
    if (!run) throw new UserError("Run not found.");
    await environmentOf(run.environmentId, ctx.org.id);
    return runView(run);
  });
}

/**
 * Removes a stack's services. `volumes`: their data goes too (databases included); without it the
 * volumes stay and a database made again with the same name can start on them.
 */
export async function downStack(environmentId: string, name: string, volumes: boolean, password?: string | null) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const env = await environmentOf(environmentId, ctx.org.id);
    const services = await stackServices(environmentId, name);
    if (!services.length) throw new UserError(`No stack named ${name} in this environment.`);
    const running = await db
      .select()
      .from(schema.stackRun)
      .where(and(eq(schema.stackRun.environmentId, environmentId), eq(schema.stackRun.stackName, name), eq(schema.stackRun.status, "running")));
    for (const run of running) await cancelStackRun(run);
    const { deleteService } = await import("@/server/actions/services");
    const removed: string[] = [];
    // Apps first, databases last: what uses a database stops before it goes.
    const order = [...services].sort((a, b) => Number(a.type === "database") - Number(b.type === "database"));
    for (const s of order) {
      const r = await deleteService(s.id, volumes, password);
      if (!r.ok) throw new UserError(`${s.name}: ${r.error}${removed.length ? ` (removed before it: ${removed.join(", ")})` : ""}`);
      removed.push(s.name);
    }
    await logActivity({
      userId: ctx.user.id,
      projectId: env.projectId,
      action: "stack.removed",
      targetType: "environment",
      targetId: environmentId,
      message: `Removed stack ${name}: ${removed.join(", ")}${volumes ? " with their volumes" : ""}`,
    });
    return { removed };
  });
}

/**
 * An environment's services (or one stack's, or the ones named) as a serve-compose.yml with the
 * files it names. Values of variables only with `values`, which needs the right to see secrets.
 */
export async function exportStackAction(environmentId: string, opts: { stack?: string | null; services?: string[]; values?: boolean } = {}) {
  return act(async () => {
    const ctx = await requirePermission("projects.view");
    if (opts.values && !ctx.can("variables.view-secrets")) throw new UserError("Exporting variable values needs the right to view secrets. Export without values.");
    const env = await environmentOf(environmentId, ctx.org.id);
    const [project] = await db.select({ name: schema.project.name }).from(schema.project).where(eq(schema.project.id, env.projectId));
    const { exportStack } = await import("@/server/stacks/export");
    return exportStack(environmentId, { stack: opts.stack, services: opts.services, values: !!opts.values, name: opts.stack ?? project?.name ?? "stack" });
  });
}
