import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { env } from "@/server/env";
import { newId } from "@/server/id";
import { randomSecret, sha256 } from "@/server/crypto";
import { getSetting, updateSettings } from "@/server/settings";
import { hostDashboardUrl, serverCliPlan, serverCliTokens } from "@/lib/server-cli";

/*
 * The CLI on the Serve host itself needs no `serve login`: the worker keeps <dataDir>/cli.json
 * with a token of an admin of the Root organization. Root on the host already controls Serve
 * (the database, the Docker socket), so the file adds no exposure. It is readable by its owner only.
 */

export const SERVER_CLI_TOKEN = "Server CLI";

export type ServerCliFile = {
  url: string;
  publicUrl: string | null;
  token: string;
  organization: { id: string; name: string };
  user: { name: string; email: string };
};

export const serverCliPath = () => path.join(env.dataDir, "cli.json");

async function readFile(file: string): Promise<Partial<ServerCliFile> | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Partial<ServerCliFile>;
  } catch {
    return null;
  }
}

/**
 * Written to a temporary file first, so a reader never sees half a file. The name is random and
 * the file must be new ("wx"), so nothing already at that path (a symlink) is written through.
 */
async function writeFile(file: string, content: ServerCliFile) {
  const tmp = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Writes or refreshes cli.json. Returns a line for the worker log. Never throws: a data directory
 * that cannot be written only means the host CLI needs `serve login`.
 */
export async function ensureServerCli(): Promise<string> {
  try {
    // One at a time: two workers at once (an update starting the new one early) would each make a token.
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('serve:server-cli'))`);
      return writeServerCli();
    });
  } catch (e) {
    return `Server CLI: could not write ${serverCliPath()}: ${(e as Error).message}`;
  }
}

async function writeServerCli(): Promise<string> {
  const file = serverCliPath();
  try {
    const rootId = await getSetting("rootOrganizationId");
    const [org] = rootId ? await db.select({ id: schema.organization.id, name: schema.organization.name }).from(schema.organization).where(eq(schema.organization.id, rootId)) : [];
    const admins = org
      ? await db
          .select({ userId: schema.member.userId })
          .from(schema.member)
          .where(and(eq(schema.member.organizationId, org.id), inArray(schema.member.role, ["owner", "admin"])))
          .orderBy(asc(schema.member.createdAt))
      : [];
    const saved = await readFile(file);
    const columns = { id: schema.apiToken.id, userId: schema.apiToken.userId, expiresAt: schema.apiToken.expiresAt };
    const [fileToken] =
      org && typeof saved?.token === "string"
        ? await db
            .select(columns)
            .from(schema.apiToken)
            .where(and(eq(schema.apiToken.tokenHash, sha256(saved.token)), eq(schema.apiToken.organizationId, org.id)))
        : [];
    const storedId = await getSetting("serverCliTokenId");
    const [stored] = storedId ? await db.select(columns).from(schema.apiToken).where(eq(schema.apiToken.id, storedId)) : [];
    const { current, retire } = serverCliTokens(storedId, stored ?? null, fileToken ?? null);
    const plan = serverCliPlan(
      current,
      admins.map((a) => a.userId),
    );
    // Only Serve's own token is ever revoked, by its id.
    const revoke = async (keep: string | null) => {
      if (retire && retire !== keep) await db.delete(schema.apiToken).where(eq(schema.apiToken.id, retire));
    };

    if (plan.action === "none" || !org) {
      // No admin yet (a fresh install): nothing to write until someone signs up.
      if (saved) await fs.rm(file, { force: true });
      await revoke(null);
      if (storedId) await updateSettings({ serverCliTokenId: null });
      return "Server CLI: no admin yet, cli.json not written";
    }

    let token = saved?.token as string;
    let tokenId = plan.action === "keep" ? plan.tokenId : "";
    let userId = plan.action === "keep" ? current!.userId : plan.userId;
    if (plan.action === "create") {
      token = `srv_${randomSecret(30)}`;
      tokenId = newId();
      userId = plan.userId;
      await db.insert(schema.apiToken).values({
        id: tokenId,
        organizationId: org.id,
        userId,
        name: SERVER_CLI_TOKEN,
        tokenHash: sha256(token),
        prefix: token.slice(0, 10),
        scopes: ["admin"],
        projectIds: null,
        expiresAt: null,
      });
    }
    const [user] = await db.select({ name: schema.user.name, email: schema.user.email }).from(schema.user).where(eq(schema.user.id, userId));
    const { publicBaseUrl } = await import("@/server/git/github-app");
    const publicUrl = (await publicBaseUrl().catch(() => "")) || null;
    const content: ServerCliFile = {
      url: hostDashboardUrl(process.env, publicUrl),
      publicUrl,
      token,
      organization: { id: org.id, name: org.name },
      user: { name: user?.name ?? "", email: user?.email ?? "" },
    };
    if (plan.action === "create" || JSON.stringify(saved) !== JSON.stringify(content)) {
      try {
        await writeFile(file, content);
      } catch (e) {
        // The token would be useless without the file; the one in use stays.
        if (plan.action === "create") await db.delete(schema.apiToken).where(eq(schema.apiToken.id, tokenId));
        throw e;
      }
    }
    if (storedId !== tokenId) await updateSettings({ serverCliTokenId: tokenId });
    // The token it replaces goes once the file holds the new one: one live Server CLI token.
    await revoke(tokenId);
    return plan.action === "create" ? `Server CLI: new token for ${user?.email ?? userId} written to ${file}` : "Server CLI: token still valid";
  } catch (e) {
    return `Server CLI: could not write ${file}: ${(e as Error).message}`;
  }
}
