"use server";

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireOrg, requireOrgAdmin } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decrypt, encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { Cloudflare, type CfDnsRecord, type CfSslMode } from "@/server/cloudflare/api";
import { generateSshKey, listRepositories, tokenScopeWarning, verifyGitToken, type RemoteRepo } from "@/server/git/providers";
import { listRemoteBranches, normalizeRepoUrl } from "@/server/deploy/git";
import { logActivity } from "@/server/activity";
import { sendToChannel, type NotifyEvent } from "@/server/notify";
import { s3Test } from "@/server/backups/s3";
import type { GitProviderType, NotificationKind } from "@/server/db/schema";
import { getSettings, updateSettings } from "@/server/settings";
import { enqueue } from "@/server/queue";
import { syncServiceProxy } from "@/server/proxy/nginx";

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

/** What stops working when an account is disconnected: its tunnels and the domains they carry. */
export async function cloudflareDisconnectImpact(accountId: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const { tunnelDomains } = await import("@/server/cloudflare/tunnels");
    const tunnels = await db
      .select({ id: schema.cloudflareTunnel.id, name: schema.cloudflareTunnel.name, serverName: schema.server.name })
      .from(schema.cloudflareTunnel)
      .innerJoin(schema.server, eq(schema.cloudflareTunnel.serverId, schema.server.id))
      .where(and(eq(schema.cloudflareTunnel.cloudflareAccountId, accountId), eq(schema.cloudflareTunnel.organizationId, ctx.org.id)));
    return Promise.all(tunnels.map(async (t) => ({ ...t, domains: (await tunnelDomains(t.id)).map((d) => d.hostname) })));
  });
}

/**
 * Disconnect an account. Its tunnels are stopped and deleted first (containers, Cloudflare
 * tunnel, the DNS records Serve made for them), so no connector keeps serving traffic.
 */
export async function disconnectCloudflare(accountId: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const [account] = await db
      .select()
      .from(schema.cloudflareAccount)
      .where(and(eq(schema.cloudflareAccount.id, accountId), eq(schema.cloudflareAccount.organizationId, ctx.org.id)));
    if (!account) throw new UserError("Cloudflare account not found.");
    const { deleteTunnel } = await import("@/server/cloudflare/tunnels");
    const tunnels = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.cloudflareAccountId, accountId));
    const tunnelIds = tunnels.map((t) => t.id);
    const routed = tunnelIds.length ? await db.select().from(schema.domain).where(inArray(schema.domain.tunnelId, tunnelIds)) : [];
    // DNS records Serve created that point at these tunnels would only show Cloudflare errors.
    const cf = new Cloudflare(decrypt(account.apiToken));
    for (const d of routed) {
      if (d.cloudflareZoneId && d.cloudflareRecordId) await cf.deleteDnsRecord(d.cloudflareZoneId, d.cloudflareRecordId).catch(() => {});
    }
    for (const t of tunnels) await deleteTunnel(t.id);
    if (routed.length) {
      await db.update(schema.domain).set({ cloudflareRecordId: null }).where(inArray(schema.domain.id, routed.map((d) => d.id)));
    }
    const settings = await getSettings();
    if (settings.dashboardTunnelId && tunnelIds.includes(settings.dashboardTunnelId)) {
      await updateSettings({ dashboardTunnelId: null });
      await enqueue("proxy.sync", {});
    }
    await db.delete(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.id, accountId));
    for (const serviceId of new Set(routed.map((d) => d.serviceId))) await syncServiceProxy(serviceId).catch(() => {});
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "cloudflare.disconnect",
      message: tunnels.length ? `Disconnected Cloudflare ${account.name} and removed ${tunnels.length} tunnel${tunnels.length === 1 ? "" : "s"}` : `Disconnected Cloudflare ${account.name}`,
    });
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
    return { id, login, warning: await tokenScopeWarning(input.provider, token, baseUrl) };
  });
}

/* ------------------------------- OAuth apps ------------------------------- */

const oauthAppSchema = z.object({
  provider: z.enum(["gitlab", "gitea", "bitbucket"]),
  name: z.string().trim().min(1, "Enter a name").max(60),
  baseUrl: z.union([z.url("Enter a URL like https://git.example.com").trim(), z.literal("")]).optional(),
  clientId: z.string().trim().min(4, "Paste the application ID"),
  clientSecret: z.string().trim().min(4, "Paste the secret"),
  groupPath: z.string().trim().max(200).optional(),
});

export async function createGitOAuthApp(input: z.input<typeof oauthAppSchema>) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const data = oauthAppSchema.parse(input);
    if (data.provider === "gitea" && !data.baseUrl) throw new UserError("Enter the address of your Gitea or Forgejo server.");
    const id = newId();
    await db.insert(schema.gitOAuthApp).values({
      id,
      organizationId: ctx.org.id,
      provider: data.provider,
      name: data.name,
      baseUrl: data.provider === "bitbucket" ? null : data.baseUrl?.replace(/\/$/, "") || null,
      clientId: data.clientId,
      clientSecret: encrypt(data.clientSecret),
      groupPath: data.provider === "gitlab" ? data.groupPath?.replace(/^\/|\/$/g, "") || null : null,
    });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "git.oauth.created", message: `Added OAuth app ${data.name}` });
    return { id };
  });
}

/** Deletes the app and its connection (services using it can no longer pull). */
export async function deleteGitOAuthApp(id: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const [app] = await db
      .delete(schema.gitOAuthApp)
      .where(and(eq(schema.gitOAuthApp.id, id), eq(schema.gitOAuthApp.organizationId, ctx.org.id)))
      .returning();
    if (app) await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "git.oauth.deleted", message: `Removed OAuth app ${app.name}` });
    return null;
  });
}

/** URL of the provider's consent page for an OAuth app. */
export async function startGitOAuth(id: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const [app] = await db
      .select()
      .from(schema.gitOAuthApp)
      .where(and(eq(schema.gitOAuthApp.id, id), eq(schema.gitOAuthApp.organizationId, ctx.org.id)));
    if (!app) throw new UserError("OAuth app not found.");
    const { oauthBaseUrl } = await import("@/server/git/public-url");
    const { authorizeUrl, redirectUri, signOAuthState } = await import("@/server/git/oauth");
    const base = await oauthBaseUrl();
    if (!base.ok) throw new UserError(base.error);
    return authorizeUrl(app, redirectUri(base.url, app.provider), signOAuthState({ appId: app.id, organizationId: ctx.org.id, userId: ctx.user.id }));
  });
}

/* ---------------------------- Service webhooks ---------------------------- */

export async function registerServiceWebhook(serviceId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const { serviceInOrg } = await import("@/server/services/access");
    await serviceInOrg(serviceId, ctx.org.id);
    const { registerRepoWebhook } = await import("@/server/git/repo-webhooks");
    const hook = await registerRepoWebhook(serviceId);
    if (!hook) throw new UserError("This service's git credential cannot manage webhooks. Add the webhook URL on the repository yourself.");
    if (hook.error) throw new UserError(hook.error);
    return hook;
  });
}

export async function removeServiceWebhook(serviceId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const { serviceInOrg } = await import("@/server/services/access");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.source?.type !== "git") return null;
    const { removeRepoWebhook } = await import("@/server/git/repo-webhooks");
    const error = await removeRepoWebhook(service.source);
    if (error) throw new UserError(`Could not remove the webhook: ${error}`);
    await db.update(schema.service).set({ source: { ...service.source, webhook: null } }).where(eq(schema.service.id, serviceId));
    return null;
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
    if (cred.provider === "github-app") {
      const { listAppRepositories } = await import("@/server/git/github-app");
      return listAppRepositories(cred);
    }
    const { withCredentialToken } = await import("@/server/git/oauth");
    const [app] = cred.oauthAppId ? await db.select().from(schema.gitOAuthApp).where(eq(schema.gitOAuthApp.id, cred.oauthAppId)) : [];
    return withCredentialToken(cred, (token) => listRepositories(cred.provider, token, cred.baseUrl, { oauth: !!cred.oauthAppId, group: app?.groupPath }));
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

/** Edit a destination. Access is checked before saving. */
export async function updateS3Destination(id: string, input: Omit<z.input<typeof s3Schema>, "secretAccessKey" | "accessKeyId"> & { accessKeyId?: string; secretAccessKey?: string }) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const [row] = await db
      .select()
      .from(schema.s3Destination)
      .where(and(eq(schema.s3Destination.id, id), eq(schema.s3Destination.organizationId, ctx.org.id)));
    if (!row) throw new UserError("Destination not found.");
    // Empty key fields keep the stored credentials.
    const secret = input.secretAccessKey?.trim() || decrypt(row.secretAccessKey);
    const data = s3Schema.parse({ ...input, accessKeyId: input.accessKeyId?.trim() || row.accessKeyId, secretAccessKey: secret });
    try {
      await s3Test(data);
    } catch (e) {
      throw new UserError(`Could not access the bucket: ${(e as Error).message}`);
    }
    await db
      .update(schema.s3Destination)
      .set({ ...data, secretAccessKey: encrypt(data.secretAccessKey) })
      .where(eq(schema.s3Destination.id, id));
    return null;
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
    try {
      await s3Test({ ...row, secretAccessKey: decrypt(row.secretAccessKey) });
    } catch (e) {
      throw new UserError(`Could not access the bucket: ${(e as Error).message}`);
    }
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

/** Prepare the GitHub App manifest form. The browser posts it to GitHub. */
export async function startGithubApp(input: { organization?: string }) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const { buildManifest, signState } = await import("@/server/git/github-app");
    const owner = input.organization?.trim();
    if (owner && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) throw new UserError("Enter a valid GitHub organization name.");
    const credentialId = newId();
    const state = signState({ credentialId, organizationId: ctx.org.id, userId: ctx.user.id });
    const base = owner ? `https://github.com/organizations/${owner}/settings/apps/new` : "https://github.com/settings/apps/new";
    return { action: `${base}?state=${encodeURIComponent(state)}`, manifest: JSON.stringify(await buildManifest(credentialId)) };
  });
}

/** Link to manage which repositories the app can access. */
export async function githubAppInstallUrl(credentialId: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const [cred] = await db
      .select()
      .from(schema.gitCredential)
      .where(and(eq(schema.gitCredential.id, credentialId), eq(schema.gitCredential.organizationId, ctx.org.id)));
    if (!cred || cred.provider !== "github-app") throw new UserError("GitHub App not found.");
    const { readAppSecret, signState } = await import("@/server/git/github-app");
    const secret = readAppSecret(cred);
    const state = signState({ credentialId, organizationId: ctx.org.id, userId: ctx.user.id });
    return `${secret.htmlUrl}/installations/new?state=${encodeURIComponent(state)}`;
  });
}

/* -------------------------------------------------------------------------- */
/*                             Cloudflare Tunnels                             */
/* -------------------------------------------------------------------------- */

/** Create a tunnel from a server to a connected Cloudflare account. */
export async function enableTunnel(cloudflareAccountId: string, serverId: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const [account] = await db
      .select()
      .from(schema.cloudflareAccount)
      .where(and(eq(schema.cloudflareAccount.id, cloudflareAccountId), eq(schema.cloudflareAccount.organizationId, ctx.org.id)));
    if (!account) throw new UserError("Cloudflare account not found.");
    const [server] = await db.select().from(schema.server).where(eq(schema.server.id, serverId));
    const { serverAllowsOrg } = await import("@/server/servers/access");
    if (!server || !serverAllowsOrg(server, ctx.org.id)) throw new UserError("Server not found.");
    if (!server.isLocal && server.status !== "ready") throw new UserError(`${server.name} is not ready. Validate it first.`);
    const { createTunnel } = await import("@/server/cloudflare/tunnels");
    try {
      const tunnel = await createTunnel({ organizationId: ctx.org.id, cloudflareAccountId, serverId });
      await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "tunnel.create", message: `Created a Cloudflare Tunnel from ${server.name} to ${account.name}` });
      return { id: tunnel.id };
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  });
}

export async function disableTunnel(tunnelId: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const [tunnel] = await db
      .select()
      .from(schema.cloudflareTunnel)
      .where(and(eq(schema.cloudflareTunnel.id, tunnelId), eq(schema.cloudflareTunnel.organizationId, ctx.org.id)));
    if (!tunnel) throw new UserError("Tunnel not found.");
    const { deleteTunnel, tunnelDomains } = await import("@/server/cloudflare/tunnels");
    const domains = await tunnelDomains(tunnelId);
    if (domains.length) {
      throw new UserError(`${domains.map((d) => d.hostname).join(", ")} ${domains.length === 1 ? "uses" : "use"} this tunnel. Remove ${domains.length === 1 ? "it" : "them"} first.`);
    }
    await deleteTunnel(tunnelId);
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "tunnel.delete", message: `Removed the Cloudflare Tunnel ${tunnel.name}` });
    return null;
  });
}

/** Refresh the status of this organization's tunnels that are still starting or down. */
export async function refreshTunnels() {
  return act(async () => {
    const ctx = await requireOrg();
    const { refreshTunnelStatus } = await import("@/server/cloudflare/tunnels");
    const tunnels = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.organizationId, ctx.org.id));
    const waiting = tunnels.filter((t) => t.status !== "healthy");
    await Promise.all(waiting.map((t) => refreshTunnelStatus(t)));
    return null;
  });
}
