import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { type DeployRules, freezeState, freezeUntil, needsApproval } from "@/lib/deploy-rules";
import type { DeploymentTrigger } from "@/server/db/schema";

/** What a project's deploy rules say about a deploy about to be queued. */
export type DeployGate = { kind: "run" } | { kind: "frozen"; message: string } | { kind: "approve" };

/**
 * Rollbacks (a way back when something broke) and a new service's first deploy are never held.
 * Databases are left out too: their deploys follow settings and certificates, not code.
 */
const HELD: DeploymentTrigger[] = ["manual", "redeploy", "webhook", "deploy-hook", "api"];

export async function deployGate(serviceId: string, trigger: DeploymentTrigger, userId: string | null | undefined): Promise<DeployGate> {
  if (!HELD.includes(trigger)) return { kind: "run" };
  const [row] = await db
    .select({
      type: schema.service.type,
      environmentId: schema.service.environmentId,
      parent: schema.service.parentServiceId,
      rules: schema.project.deployRules,
      organizationId: schema.project.organizationId,
    })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(eq(schema.service.id, serviceId));
  // Preview deployments follow their pull request, wherever the rules apply.
  if (!row?.rules || row.type === "database" || row.parent) return { kind: "run" };
  const rules: DeployRules = row.rules;
  const freeze = freezeState(rules, row.environmentId);
  if (freeze.frozen) {
    const why = freeze.reason ? ` (${freeze.reason})` : "";
    return { kind: "frozen", message: `Deploys are frozen${why} ${freezeUntil(freeze, rules.freeze?.timezone || "UTC")}.` };
  }
  if (!needsApproval(rules, row.environmentId)) return { kind: "run" };
  // Someone who can approve deploys starts their own right away.
  if (userId && (await canApprove(row.organizationId, userId))) return { kind: "run" };
  return { kind: "approve" };
}

export async function canApprove(organizationId: string, userId: string) {
  const { memberAccess } = await import("@/server/permissions");
  return !!(await memberAccess(organizationId, userId))?.permissions.has("deploys.approve");
}

/** A newer deploy waiting for approval replaces the older ones of the same service. */
export async function supersedeWaiting(serviceId: string, exceptId: string) {
  await db
    .update(schema.deployment)
    .set({ status: "superseded", finishedAt: new Date(), logs: "Skipped: a newer deployment is waiting for approval.\n" })
    .where(and(eq(schema.deployment.serviceId, serviceId), eq(schema.deployment.status, "waiting"), ne(schema.deployment.id, exceptId)));
}
