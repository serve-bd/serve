"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { serviceInOrg } from "@/server/services/access";
import { branchesSupported, createBranch, enqueueBranchJob, maxBranches } from "@/server/databases/branches";
import { logActivity } from "@/server/activity";
import { branchNamePattern } from "@/lib/database-branches";

const nameSchema = z.string().trim().toLowerCase().regex(branchNamePattern, "Use lowercase letters, digits and dashes, up to 30 characters, like feature-login");

async function branchInOrg(id: string, orgId: string) {
  const [branch] = await db.select().from(schema.databaseBranch).where(eq(schema.databaseBranch.id, id));
  if (!branch) throw new UserError("Branch not found.");
  const { service } = await serviceInOrg(branch.serviceId, orgId);
  return { branch, service };
}

export async function createDatabaseBranch(serviceId: string, rawName: string) {
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
    const branch = await createBranch(service, name, { userId: ctx.user.id });
    await enqueueBranchJob({ branchId: branch.id, op: "create" }, service.id);
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "database.branch",
      targetType: "service",
      targetId: service.id,
      message: `Started branch ${name} of ${service.name}`,
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
