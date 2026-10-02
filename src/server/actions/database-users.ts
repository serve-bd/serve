"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { ForbiddenError, requirePermission } from "@/server/auth";
import { cannotMessage, type Permission } from "@/lib/permissions";
import { db, schema } from "@/server/db";
import { decrypt, decryptOrNull, encrypt, randomPassword } from "@/server/crypto";
import { logActivity } from "@/server/activity";
import { newId } from "@/server/id";
import { serviceInOrg } from "@/server/services/access";
import { serverOf } from "@/server/servers/context";
import { execCommand } from "@/server/services/exec";
import { databaseContainer } from "@/server/databases/container";
import { databaseCreds, databaseUrl } from "@/server/databases/options";
import { engines } from "@/server/databases/engines";
import { PASSWORD_PATTERN } from "@/server/databases/password";
import { databasePublicEndpoint } from "@/server/databases/public-url";
import { isSystemUser, parseListing, USERNAME_PATTERN, userScripts, usersSupported } from "@/server/databases/users";
import type { DatabaseUserAccess } from "@/server/db/schema";
import { privateHost } from "@/lib/hostname";

type Service = typeof schema.service.$inferSelect;

/** A permission plus seeing secrets: these steps hand out a login to the data. */
async function requireBoth(permission: Permission) {
  const ctx = await requirePermission(permission);
  if (!ctx.can("variables.view-secrets")) throw new ForbiddenError(cannotMessage("variables.view-secrets"));
  return ctx;
}

const accessSchema = z.enum(["read", "readwrite", "owner"]);
const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_PATTERN, "Use lowercase letters, digits and underscores, starting with a letter, up to 32 characters, like app_reader");
const passwordSchema = z
  .string()
  .trim()
  .regex(PASSWORD_PATTERN, "Use 12 to 128 letters, numbers, dots, dashes, underscores or tildes.")
  .optional()
  .or(z.literal("").transform(() => undefined));

export type DatabaseUserRow = {
  username: string;
  /** Serve set its access or password (from the Users page). */
  managed: boolean;
  /** Serve has its password, so its connection URL can be shown. */
  knowsPassword: boolean;
  /** Serve's own login, a branch's login or one of the engine's: not changed here. */
  protectedReason: string | null;
  access: DatabaseUserAccess | null;
  databases: string[];
  createdAt: string | null;
};

async function databaseService(serviceId: string, orgId: string) {
  const { service } = await serviceInOrg(serviceId, orgId);
  if (service.type !== "database" || !service.database) throw new UserError("Not a database.");
  if (!usersSupported(service.database)) throw new UserError("Users are available for PostgreSQL, MySQL, MariaDB and MongoDB.");
  return service as Service & { database: NonNullable<Service["database"]> };
}

/** Runs a user script inside the database container; passwords never show in errors. */
async function runScript(service: Service, script: string, secrets: string[]) {
  if (service.status !== "running") throw new UserError(`${service.name} is not running. Start it to manage its users.`);
  const { docker } = await serverOf(service);
  let res;
  try {
    const container = await databaseContainer(docker, service);
    res = await execCommand(container.id, script, { docker, timeoutSeconds: 120 });
  } catch (e) {
    throw new UserError(`Could not reach the database container: ${(e as Error).message}`);
  }
  let output = res.output;
  for (const s of secrets) if (s) output = output.replaceAll(s, "***");
  if (res.timedOut) throw new UserError("The database did not answer within 2 minutes.");
  if (res.exitCode !== 0) {
    const detail = output.trim().split("\n").slice(-3).join(" ");
    throw new UserError(`The database refused the change${detail ? `: ${detail}` : "."}`);
  }
  return output;
}

function scriptsFor(service: Service & { database: NonNullable<Service["database"]> }) {
  const mainPassword = decrypt(service.database.password);
  return { scripts: userScripts(service.database.engine, databaseCreds(service.database, mainPassword)), mainPassword };
}

async function protectedReasons(service: Service & { database: NonNullable<Service["database"]> }) {
  const branches = await db
    .select({ username: schema.databaseBranch.username, name: schema.databaseBranch.name })
    .from(schema.databaseBranch)
    .where(eq(schema.databaseBranch.serviceId, service.id));
  return (username: string): string | null => {
    if (username === service.database.username) return "Serve's own login";
    const branch = branches.find((b) => b.username === username);
    if (branch) return `Login of branch ${branch.name}`;
    if (isSystemUser(service.database.engine, username)) return "Built into the database";
    return null;
  };
}

async function listing(service: Service & { database: NonNullable<Service["database"]> }) {
  const { scripts, mainPassword } = scriptsFor(service);
  const found = parseListing(service.database.engine, await runScript(service, scripts.list(), [mainPassword]));
  // Branch databases belong to their branches (a reset replaces them): not offered for access.
  const branches = await db.select({ database: schema.databaseBranch.database }).from(schema.databaseBranch).where(eq(schema.databaseBranch.serviceId, service.id));
  return { ...found, databases: found.databases.filter((d) => !branches.some((b) => b.database === d)) };
}

/** A login the Users page may change: it exists, and it is not Serve's, a branch's or the engine's. */
async function changeable(service: Service & { database: NonNullable<Service["database"]> }, rawName: string) {
  const username = usernameSchema.parse(rawName);
  const reason = (await protectedReasons(service))(username);
  if (reason) throw new UserError(`${username} is not changed here (${reason}).`);
  const { users, databases } = await listing(service);
  if (!users.includes(username)) throw new UserError(`There is no user named ${username} in ${service.name}.`);
  return { username, databases };
}

function checkDatabases(chosen: string[], available: string[]) {
  const list = [...new Set(chosen)];
  if (!list.length) throw new UserError("Choose at least one database.");
  const unknown = list.filter((d) => !available.includes(d));
  if (unknown.length) throw new UserError(`There is no database named ${unknown[0]}.`);
  return list;
}

/** The logins inside a database, with the access Serve gave the ones it made. */
export async function listDatabaseUsers(serviceId: string) {
  return act(async () => {
    const ctx = await requirePermission("projects.view");
    const service = await databaseService(serviceId, ctx.org.id);
    const [{ users, databases }, rows, reasonOf] = await Promise.all([
      listing(service),
      db.select().from(schema.databaseUser).where(eq(schema.databaseUser.serviceId, service.id)),
      protectedReasons(service),
    ]);
    const out: DatabaseUserRow[] = users.map((username) => {
      const row = rows.find((r) => r.username === username);
      return {
        username,
        managed: !!row,
        knowsPassword: !!row?.password,
        protectedReason: reasonOf(username),
        access: row?.access ?? null,
        databases: row?.databases ?? [],
        createdAt: row?.createdAt.toISOString() ?? null,
      };
    });
    // Logins this page manages first, then the ones it only shows.
    const rank = (u: DatabaseUserRow) => (u.protectedReason ? 2 : u.managed ? 0 : 1);
    out.sort((a, b) => rank(a) - rank(b) || a.username.localeCompare(b.username));
    return { users: out, databases, mainDatabase: service.database.database };
  });
}

export async function createDatabaseUser(serviceId: string, input: { username: string; password?: string; access: DatabaseUserAccess; databases: string[] }) {
  return act(async () => {
    // A new login hands out access to the data, like seeing its password.
    const ctx = await requireBoth("services.manage");
    const service = await databaseService(serviceId, ctx.org.id);
    const username = usernameSchema.parse(input.username);
    const access = accessSchema.parse(input.access);
    const password = passwordSchema.parse(input.password ?? "") ?? randomPassword(32);
    const reason = (await protectedReasons(service))(username);
    if (reason) throw new UserError(`The name ${username} is taken (${reason}).`);
    const { users, databases: available } = await listing(service);
    if (users.includes(username)) throw new UserError(`A user named ${username} exists already.`);
    const databases = checkDatabases(input.databases, available);
    const { scripts, mainPassword } = scriptsFor(service);
    await runScript(service, scripts.create(username, password, access, databases), [mainPassword, password]);
    // A row left from a login removed outside Serve is replaced.
    await db
      .insert(schema.databaseUser)
      .values({ id: newId(), serviceId: service.id, username, password: encrypt(password), access, databases, createdBy: ctx.user.id })
      .onConflictDoUpdate({
        target: [schema.databaseUser.serviceId, schema.databaseUser.username],
        set: { password: encrypt(password), access, databases, createdBy: ctx.user.id, createdAt: new Date(), updatedAt: new Date() },
      });
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "database.user-created",
      targetType: "service",
      targetId: service.id,
      message: `Added user ${username} to ${service.name} (${ACCESS_LABEL[access]} on ${databases.join(", ")})`,
    });
    return { username, ...(await userUrls(service, ctx.org.id, username, password, databases[0])) };
  });
}

export async function changeDatabaseUserPassword(serviceId: string, rawName: string, rawPassword?: string) {
  return act(async () => {
    const ctx = await requireBoth("services.manage");
    const service = await databaseService(serviceId, ctx.org.id);
    const { username } = await changeable(service, rawName);
    const password = passwordSchema.parse(rawPassword ?? "") ?? randomPassword(32);
    const { scripts, mainPassword } = scriptsFor(service);
    await runScript(service, scripts.setPassword(username, password), [mainPassword, password]);
    // A login made outside Serve is remembered from now on, with its grants left as they are.
    const [row] = await db
      .insert(schema.databaseUser)
      .values({ id: newId(), serviceId: service.id, username, password: encrypt(password), access: null, databases: [], createdBy: ctx.user.id })
      .onConflictDoUpdate({ target: [schema.databaseUser.serviceId, schema.databaseUser.username], set: { password: encrypt(password), updatedAt: new Date() } })
      .returning();
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "database.user-password",
      targetType: "service",
      targetId: service.id,
      message: `Changed the password of user ${username} in ${service.name}`,
    });
    return { username, ...(await userUrls(service, ctx.org.id, username, password, row?.databases[0] ?? service.database.database)) };
  });
}

export async function setDatabaseUserAccess(serviceId: string, rawName: string, rawAccess: DatabaseUserAccess, chosen: string[]) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const service = await databaseService(serviceId, ctx.org.id);
    const { username, databases: available } = await changeable(service, rawName);
    const access = accessSchema.parse(rawAccess);
    const databases = checkDatabases(chosen, available);
    const { scripts, mainPassword } = scriptsFor(service);
    await runScript(service, scripts.setAccess(username, access, databases), [mainPassword]);
    await db
      .insert(schema.databaseUser)
      .values({ id: newId(), serviceId: service.id, username, password: null, access, databases, createdBy: ctx.user.id })
      .onConflictDoUpdate({ target: [schema.databaseUser.serviceId, schema.databaseUser.username], set: { access, databases, updatedAt: new Date() } });
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "database.user-access",
      targetType: "service",
      targetId: service.id,
      message: `Changed the access of user ${username} in ${service.name} to ${ACCESS_LABEL[access]} on ${databases.join(", ")}`,
    });
    return null;
  });
}

export async function deleteDatabaseUser(serviceId: string, rawName: string) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const service = await databaseService(serviceId, ctx.org.id);
    const { username } = await changeable(service, rawName);
    const { scripts, mainPassword } = scriptsFor(service);
    await runScript(service, scripts.remove(username), [mainPassword]);
    await db.delete(schema.databaseUser).where(and(eq(schema.databaseUser.serviceId, service.id), eq(schema.databaseUser.username, username)));
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "database.user-deleted",
      targetType: "service",
      targetId: service.id,
      message: `Deleted user ${username} from ${service.name}`,
    });
    return null;
  });
}

/** Connection URLs of a login Serve made, with the password it stored. */
export async function databaseUserUrls(serviceId: string, rawName: string) {
  return act(async () => {
    const ctx = await requireBoth("projects.view");
    const service = await databaseService(serviceId, ctx.org.id);
    const username = usernameSchema.parse(rawName);
    const [row] = await db
      .select()
      .from(schema.databaseUser)
      .where(and(eq(schema.databaseUser.serviceId, service.id), eq(schema.databaseUser.username, username)));
    const password = row ? decryptOrNull(row.password) : null;
    if (!row || !password) throw new UserError("Serve does not know the password of this user. Change its password to get a URL.");
    return { username, ...(await userUrls(service, ctx.org.id, username, password, row.databases[0] ?? service.database.database)) };
  });
}

const ACCESS_LABEL: Record<DatabaseUserAccess, string> = { read: "read only", readwrite: "read and write", owner: "full access" };

async function userUrls(service: Service & { database: NonNullable<Service["database"]> }, orgId: string, username: string, password: string, database: string) {
  const cfg = { ...service.database, username, database };
  const creds = { ...databaseCreds(service.database, password), username, database };
  const privateUrl = databaseUrl(cfg, creds, privateHost(service), engines[cfg.engine].port);
  const endpoint = await databasePublicEndpoint(service, orgId);
  const publicUrl = endpoint ? databaseUrl(cfg, creds, endpoint.host, endpoint.port, { public: true, verified: endpoint.verified }) : null;
  return { password, privateUrl, publicUrl };
}
