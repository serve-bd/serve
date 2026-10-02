"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { serviceInOrg } from "@/server/services/access";
import { branchesSupported, branchScrubEngines, createBranch, enqueueBranchJob, maxBranches } from "@/server/databases/branches";
import { logActivity } from "@/server/activity";
import { branchNamePattern } from "@/lib/database-branches";

const nameSchema = z.string().trim().toLowerCase().regex(branchNamePattern, "Use lowercase letters, digits and dashes, up to 30 characters, like feature-login");

async function branchInOrg(id: string, orgId: string) {
  const [branch] = await db.select().from(schema.databaseBranch).where(eq(schema.databaseBranch.id, id));
  if (!branch) throw new UserError("Branch not found.");
  const { service } = await serviceInOrg(branch.serviceId, orgId);
  return { branch, service };
}

/**
 * The clean-up SQL branches made with "hide personal data" run on their copy (for example, replace
 * emails and names, delete sessions). Null removes it.
 */
export async function saveBranchCleanupSql(serviceId: string, sql: string | null) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (!service.database || !branchesSupported(service)) throw new UserError("Branches are available for database services.");
    if (!branchScrubEngines.has(service.database.engine)) throw new UserError("Clean-up SQL is available for PostgreSQL, MySQL, MariaDB and ClickHouse.");
    const clean = z
      .string()
      .max(64_000, "Keep the SQL under 64 KB.")
      .nullable()
      .parse(sql?.trim() || null);
    await db
      .update(schema.service)
      .set({ database: { ...service.database, branchCleanupSql: clean }, updatedAt: new Date() })
      .where(eq(schema.service.id, service.id));
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "database.branch-cleanup",
      targetType: "service",
      targetId: service.id,
      message: clean ? `Changed the branch clean-up SQL of ${service.name}` : `Removed the branch clean-up SQL of ${service.name}`,
    });
    return null;
  });
}

export async function createDatabaseBranch(serviceId: string, rawName: string, opts: { hidePersonalData?: boolean; sourceBranchId?: string | null } = {}) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (!branchesSupported(service) || !service.database) throw new UserError("Branches are available for database services.");
    if (service.status !== "running") throw new UserError(`${service.name} is not running. Start it to branch its data.`);
    const name = nameSchema.parse(rawName);
    const existing = await db.select({ name: schema.databaseBranch.name }).from(schema.databaseBranch).where(eq(schema.databaseBranch.serviceId, service.id));
    if (existing.some((b) => b.name === name)) throw new UserError(`A branch named ${name} exists already.`);
    // Each branch is a full copy of the data; Redis and Valkey have 15 spare database numbers.
    const max = maxBranches(service.database.engine);
    if (existing.length >= max) throw new UserError(`A database can have up to ${max} branches. Delete one first.`);
    // A copy of another branch: one of this database's own, with its data in place.
    let source: typeof schema.databaseBranch.$inferSelect | null = null;
    if (opts.sourceBranchId) {
      [source] = await db
        .select()
        .from(schema.databaseBranch)
        .where(and(eq(schema.databaseBranch.id, opts.sourceBranchId), eq(schema.databaseBranch.serviceId, service.id)));
      if (!source) throw new UserError("That branch is not there any more.");
      if (source.previewServiceId) throw new UserError("Branches of pull request previews cannot be copied.");
      if (source.status !== "ready") throw new UserError(`Branch ${source.name} is not ready. Try again when it is.`);
    }
    // A copy of a branch with personal data hidden hides it too: a reset after the source is gone copies the main data.
    const hide = !!opts.hidePersonalData || !!source?.scrubbed;
    if (hide && !service.database.branchCleanupSql?.trim()) throw new UserError("Add the clean-up SQL first: it is what hides the personal data.");
    const branch = await createBranch(service, name, { userId: ctx.user.id, scrubbed: hide, sourceBranchId: source?.id ?? null });
    await enqueueBranchJob({ branchId: branch.id, op: "create" }, service.id);
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "database.branch",
      targetType: "service",
      targetId: service.id,
      message: `Started branch ${name} of ${service.name}${source ? ` from branch ${source.name}` : ""}${hide ? " with personal data hidden" : ""}`,
    });
    return { id: branch.id };
  });
}

export async function resetDatabaseBranch(id: string) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { branch, service } = await branchInOrg(id, ctx.org.id);
    if (branch.status === "creating" || branch.status === "resetting" || branch.status === "deleting") throw new UserError("This branch is busy. Try again when it is ready.");
    if (service.status !== "running") throw new UserError(`${service.name} is not running. Start it to copy its data.`);
    await db.update(schema.databaseBranch).set({ status: "resetting", error: null, updatedAt: new Date() }).where(eq(schema.databaseBranch.id, id));
    await enqueueBranchJob({ branchId: id, op: "reset" }, service.id);
    return null;
  });
}

export async function deleteDatabaseBranch(id: string) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { branch, service } = await branchInOrg(id, ctx.org.id);
    await db
      .update(schema.databaseBranch)
      .set({ status: "deleting", updatedAt: new Date() })
      .where(and(eq(schema.databaseBranch.id, id)));
    await enqueueBranchJob({ branchId: id, op: "delete" }, service.id);
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "database.branch-deleted",
      targetType: "service",
      targetId: service.id,
      message: `Deleted branch ${branch.name} of ${service.name}`,
    });
    return null;
  });
}
