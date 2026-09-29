"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireOrg, requireOrgAdmin } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decrypt, encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { Cloudflare, type CfDnsRecord, type CfSslMode } from "@/server/cloudflare/api";
import { generateSshKey, listRepositories, verifyGitToken, type RemoteRepo } from "@/server/git/providers";
import { listRemoteBranches, normalizeRepoUrl } from "@/server/deploy/git";
import { logActivity } from "@/server/activity";
import { sendToChannel, type NotifyEvent } from "@/server/notify";
import { s3Test } from "@/server/backups/s3";
import type { GitProviderType, NotificationKind } from "@/server/db/schema";

/* -------------------------------------------------------------------------- */
/*                                 Cloudflare                                 */
/* -------------------------------------------------------------------------- */

async function cfAccount(orgId: string, accountId: string) {
  const [row] = await db
    .select()
    .from(schema.cloudflareAccount)
    .where(and(eq(schema.cloudflareAccount.id, accountId), eq(schema.cloudflareAccount.organizationId, orgId)));
  if (!row) throw new UserError("Cloudflare account not found.");
  return new Cloudflare(decrypt(row.apiToken), row.originCaKey ? decrypt(row.originCaKey) : null);
}

export async function connectCloudflare(input: { name: string; apiToken: string; originCaKey?: string }) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const token = z.string().trim().min(20, "Paste a Cloudflare API token").parse(input.apiToken);
    const cf = new Cloudflare(token);
    try {
      await cf.verifyToken();
    } catch (e) {
      throw new UserError(`Cloudflare rejected the token: ${(e as Error).message}`);
    }
    const zones = await cf.zones().catch(() => []);
    if (!zones.length) throw new UserError("The token works but can't see any zones. Give it Zone:Read and DNS:Edit permissions.");
    const accounts = await cf.accounts().catch(() => []);
    const id = newId();
    await db.insert(schema.cloudflareAccount).values({
      id,
      organizationId: ctx.org.id,
      name: input.name.trim() || accounts[0]?.name || "Cloudflare",
      apiToken: encrypt(token),
      originCaKey: input.originCaKey?.trim() ? encrypt(input.originCaKey.trim()) : null,
      cfAccountId: accounts[0]?.id ?? zones[0]?.account?.id ?? null,
    });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "cloudflare.connected", message: `Connected Cloudflare (${zones.length} zones)` });
    return { id, zones: zones.length };
  });
}

export async function disconnectCloudflare(accountId: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    await db
      .delete(schema.cloudflareAccount)
      .where(and(eq(schema.cloudflareAccount.id, accountId), eq(schema.cloudflareAccount.organizationId, ctx.org.id)));
    return null;
  });
}

const recordSchema = z.object({
  type: z.enum(["A", "AAAA", "CNAME", "TXT", "MX", "NS", "CAA", "SRV"]),
  name: z.string().trim().min(1),
  content: z.string().trim().min(1),
  proxied: z.boolean().optional(),
  ttl: z.number().int().min(1).optional(),
  priority: z.number().int().min(0).optional(),
  comment: z.string().optional(),
});

export async function upsertDnsRecord(accountId: string, zoneId: string, recordId: string | null, input: z.infer<typeof recordSchema>) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const data = recordSchema.parse(input);
    const cf = await cfAccount(ctx.org.id, accountId);
    const payload: Partial<CfDnsRecord> = {
      type: data.type,
      name: data.name,
      content: data.content,
      ttl: data.ttl ?? 1,
      comment: data.comment,
      ...(["A", "AAAA", "CNAME"].includes(data.type) ? { proxied: !!data.proxied } : {}),
      ...(data.type === "MX" ? { priority: data.priority ?? 10 } : {}),
    };
    const record = recordId ? await cf.updateDnsRecord(zoneId, recordId, payload) : await cf.createDnsRecord(zoneId, payload);
    return record;
  });
}

export async function deleteDnsRecord(accountId: string, zoneId: string, recordId: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const cf = await cfAccount(ctx.org.id, accountId);
    await cf.deleteDnsRecord(zoneId, recordId);
    return null;
  });
}

export async function setZoneSsl(accountId: string, zoneId: string, mode: CfSslMode) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const cf = await cfAccount(ctx.org.id, accountId);
    await cf.setSslMode(zoneId, z.enum(["off", "flexible", "full", "strict"]).parse(mode));
    return null;
  });
}

export async function setZoneAlwaysHttps(accountId: string, zoneId: string, on: boolean) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const cf = await cfAccount(ctx.org.id, accountId);
    await cf.setAlwaysUseHttps(zoneId, on);
    return null;
  });
}

export async function purgeZoneCache(accountId: string, zoneId: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const cf = await cfAccount(ctx.org.id, accountId);
    await cf.purgeCache(zoneId);
    return null;
  });
}

/* -------------------------------------------------------------------------- */
/*                                    Git                                     */
/* -------------------------------------------------------------------------- */

export async function addGitToken(input: { provider: GitProviderType; name: string; token: string; baseUrl?: string }) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const token = z.string().trim().min(8, "Paste an access token").parse(input.token);
    const baseUrl = input.baseUrl?.trim() || null;
    let login: string;
    try {
      login = await verifyGitToken(input.provider, token, baseUrl);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    const id = newId();
    await db.insert(schema.gitCredential).values({
      id,
      organizationId: ctx.org.id,
      name: input.name.trim() || `${input.provider} · ${login}`,
      provider: input.provider,
      secret: encrypt(token),
      publicInfo: login,
      baseUrl,
    });
    return { id, login };
  });
}

export async function createDeployKey(name: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const key = await generateSshKey(`serve-${ctx.org.slug}`);
    const id = newId();
    await db.insert(schema.gitCredential).values({
      id,
      organizationId: ctx.org.id,
      name: name.trim() || "Deploy key",
      provider: "ssh",
      secret: encrypt(key.privateKey),
      publicInfo: key.publicKey,
    });
    return { id, publicKey: key.publicKey };
  });
}

export async function deleteGitCredential(id: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    await db
      .delete(schema.gitCredential)
      .where(and(eq(schema.gitCredential.id, id), eq(schema.gitCredential.organizationId, ctx.org.id)));
    return null;
  });
}

export async function fetchRepositories(credentialId: string): Promise<{ ok: true; data: RemoteRepo[] } | { ok: false; error: string }> {
  return act(async () => {
    const ctx = await requireOrg();
    const [cred] = await db
      .select()
      .from(schema.gitCredential)
      .where(and(eq(schema.gitCredential.id, credentialId), eq(schema.gitCredential.organizationId, ctx.org.id)));
    if (!cred || cred.provider === "ssh") return [];
    return listRepositories(cred.provider, decrypt(cred.secret), cred.baseUrl);
  });
}

export async function fetchBranches(repository: string, credentialId: string | null) {
  return act(async () => {
    const ctx = await requireOrg();
    if (credentialId) {
      const [cred] = await db
        .select({ id: schema.gitCredential.id })
        .from(schema.gitCredential)
        .where(and(eq(schema.gitCredential.id, credentialId), eq(schema.gitCredential.organizationId, ctx.org.id)));
      if (!cred) throw new UserError("Credential not found.");
    }
    try {
      return await listRemoteBranches({ type: "git", repository: normalizeRepoUrl(repository), branch: "main", credentialId }, ctx.org.id);
    } catch {
      throw new UserError("Could not reach the repository. Check the URL and access.");
    }
  });
}

/* -------------------------------------------------------------------------- */
/*                               Notifications                                */
/* -------------------------------------------------------------------------- */

const channelSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["discord", "slack", "telegram", "webhook"]),
  config: z.record(z.string(), z.string()),
  events: z.array(z.string()).min(1, "Pick at least one event"),
});

export async function saveNotificationChannel(id: string | null, input: z.infer<typeof channelSchema>) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const data = channelSchema.parse(input);
    const required: Record<NotificationKind, string[]> = {
      discord: ["webhookUrl"],
      slack: ["webhookUrl"],
      telegram: ["botToken", "chatId"],
      webhook: ["url"],
    };
    for (const k of required[data.kind]) if (!data.config[k]?.trim()) throw new UserError(`Fill in ${k}.`);
    const values = { name: data.name, kind: data.kind, config: encrypt(JSON.stringify(data.config)), events: data.events };
    if (id) {
      await db
        .update(schema.notificationChannel)
        .set(values)
        .where(and(eq(schema.notificationChannel.id, id), eq(schema.notificationChannel.organizationId, ctx.org.id)));
      return { id };
    }
    const newIdValue = newId();
    await db.insert(schema.notificationChannel).values({ id: newIdValue, organizationId: ctx.org.id, ...values });
    return { id: newIdValue };
  });
}

export async function toggleNotificationChannel(id: string, enabled: boolean) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    await db
      .update(schema.notificationChannel)
      .set({ enabled })
      .where(and(eq(schema.notificationChannel.id, id), eq(schema.notificationChannel.organizationId, ctx.org.id)));
    return null;
  });
}

export async function deleteNotificationChannel(id: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    await db
      .delete(schema.notificationChannel)
      .where(and(eq(schema.notificationChannel.id, id), eq(schema.notificationChannel.organizationId, ctx.org.id)));
    return null;
  });
}

export async function testNotificationChannel(id: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const [channel] = await db
      .select()
      .from(schema.notificationChannel)
      .where(and(eq(schema.notificationChannel.id, id), eq(schema.notificationChannel.organizationId, ctx.org.id)));
    if (!channel) throw new UserError("Channel not found.");
    await sendToChannel(channel, { ok: true, title: "Test notification", body: `Sent from ${ctx.org.name} on Serve.` });
    return null;
  });
}

export type { NotifyEvent };

/* -------------------------------------------------------------------------- */
/*                                 S3 storage                                 */
/* -------------------------------------------------------------------------- */

const s3Schema = z.object({
  name: z.string().trim().min(1).max(60),
  endpoint: z.string().trim().min(3),
  region: z.string().trim().default("auto"),
  bucket: z.string().trim().min(1),
  accessKeyId: z.string().trim().min(1),
  secretAccessKey: z.string().trim().min(1),
  pathPrefix: z.string().trim().default(""),
});

export async function addS3Destination(input: z.input<typeof s3Schema>) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const data = s3Schema.parse(input);
    try {
      await s3Test(data);
    } catch (e) {
      throw new UserError(`Could not access the bucket: ${(e as Error).message}`);
    }
    const id = newId();
    await db.insert(schema.s3Destination).values({
      id,
      organizationId: ctx.org.id,
      ...data,
      secretAccessKey: encrypt(data.secretAccessKey),
    });
    return { id };
  });
}

export async function deleteS3Destination(id: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    await db
      .delete(schema.s3Destination)
      .where(and(eq(schema.s3Destination.id, id), eq(schema.s3Destination.organizationId, ctx.org.id)));
    return null;
  });
}

export async function testS3Destination(id: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const [row] = await db
      .select()
      .from(schema.s3Destination)
      .where(and(eq(schema.s3Destination.id, id), eq(schema.s3Destination.organizationId, ctx.org.id)));
    if (!row) throw new UserError("Destination not found.");
    await s3Test({ ...row, secretAccessKey: decrypt(row.secretAccessKey) });
    return null;
  });
}

/** Find the Cloudflare zone (across connected accounts) that owns a hostname. */
export async function findCloudflareZone(hostname: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const accounts = await db
      .select()
      .from(schema.cloudflareAccount)
      .where(eq(schema.cloudflareAccount.organizationId, ctx.org.id));
    for (const account of accounts) {
      try {
        const cf = new Cloudflare(decrypt(account.apiToken));
        const zone = await cf.zoneFor(hostname);
        if (zone) return { accountId: account.id, accountName: account.name, zoneId: zone.id, zoneName: zone.name };
      } catch {
        // try next account
      }
    }
    return null;
  });
}
