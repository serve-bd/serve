import { and, eq } from "drizzle-orm";
import { requireRoomFor } from "@/server/limits";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { ensureCertificateFor } from "@/server/ssl/certificates";
import { generatedHostname, newWebhookSecret, queueDeployment } from "./create";
import { createPreviewDatabase } from "./environments";
import { teardownServices } from "./teardown";

type Service = typeof schema.service.$inferSelect;

export type PullRequest = {
  number: number;
  branch: string;
  repository: string;
  title: string | null;
  sha: string | null;
  author: string | null;
  /** owner/repo, used for PR comments on GitHub. */
  fullName?: string | null;
};

async function previewFor(parentId: string, pr: number) {
  const [row] = await db
    .select()
    .from(schema.service)
    .where(and(eq(schema.service.parentServiceId, parentId), eq(schema.service.previewPr, pr)));
  return row ?? null;
}

async function orgId(projectId: string) {
  const [p] = await db.select({ organizationId: schema.project.organizationId }).from(schema.project).where(eq(schema.project.id, projectId));
  return p.organizationId;
}

/** Create or update the preview service for a pull request and deploy it. */
/** The port the app's own domain routes to, so a preview answers on the same one. */
async function appDomainPort(serviceId: string) {
  const own = await db.select({ port: schema.domain.port, redirectTo: schema.domain.redirectTo }).from(schema.domain).where(eq(schema.domain.serviceId, serviceId));
  return own.find((d) => !d.redirectTo && d.port)?.port ?? null;
}

/**
 * The preview URL template with the pull request number, reached like the app's own domain: through its Cloudflare Tunnel
 * (a record per preview), with a DNS record in its Cloudflare zone, or through a wildcard record the
 * owner points at the server. False when the service has no preview domain or the name is taken.
 */
async function addPreviewDomain(parent: Service, previewId: string, prNumber: number) {
  if (!parent.previewDomain) return false;
  const { previewHostname, previewTemplateProblem } = await import("@/lib/preview-url");
  if (previewTemplateProblem(parent.previewDomain)) return false;
  const hostname = previewHostname(parent.previewDomain, prNumber);
  const [taken] = await db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.hostname, hostname));
  if (taken) return false;
  const own = await db.select().from(schema.domain).where(eq(schema.domain.serviceId, parent.id));
  const like = own.find((d) => d.tunnelId) ?? own.find((d) => !d.generated && !d.redirectTo);
  const { Cloudflare } = await import("@/server/cloudflare/api");
  let route: { accountId: string; zoneId: string; recordId: string | null; tunnelId: string | null } | null = null;
  if (like?.tunnelId) {
    const [tunnel] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, like.tunnelId));
    if (tunnel && tunnel.serverId === parent.serverId) {
      const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
      const zone = await cf.zoneFor(hostname).catch(() => null);
      if (zone) {
        const record = await cf.upsertTunnelRecord(zone.id, hostname, tunnel.cfTunnelId).catch(() => null);
        route = { accountId: tunnel.cloudflareAccountId, zoneId: zone.id, recordId: record?.id ?? null, tunnelId: tunnel.id };
      }
    }
  } else if (like?.cloudflareAccountId && like.cloudflareRecordId) {
    const { serverPublicIp } = await import("@/server/servers/access");
    const ip = await serverPublicIp(parent.serverId);
    const cf = await Cloudflare.forAccount(like.cloudflareAccountId);
    const zone = ip ? await cf.zoneFor(hostname).catch(() => null) : null;
    if (ip && zone) {
      const record = await cf.upsertARecord(zone.id, hostname, ip, false).catch(() => null);
      route = { accountId: like.cloudflareAccountId, zoneId: zone.id, recordId: record?.id ?? null, tunnelId: null };
    }
  }
  // Cloudflare ends HTTPS for a tunnel; otherwise previews use HTTPS when the app's domain does.
  const https = route?.tunnelId ? false : (like?.https ?? true);
  const [domain] = await db
    .insert(schema.domain)
    .values({
      id: newId(),
      serviceId: previewId,
      hostname,
      // Same as the app's own domain: the port and path it routes to, and HTTPS.
      port: like?.port ?? null,
      pathPrefix: like?.pathPrefix ?? "/",
      https,
      forceHttps: https && (like?.forceHttps ?? true),
      cloudflareAccountId: route?.accountId ?? null,
      cloudflareZoneId: route?.zoneId ?? null,
      cloudflareRecordId: route?.recordId ?? null,
      tunnelId: route?.tunnelId ?? null,
      wantsTunnel: !!route?.tunnelId,
    })
    .onConflictDoNothing()
    .returning();
  if (!domain) return false;
  if (route?.tunnelId) {
    const { syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
    await syncTunnelIngress(route.tunnelId).catch(() => {});
  } else if (https) await ensureCertificateFor(domain, await orgId(parent.projectId));
  return true;
}

export async function deployPreview(parent: Service, pr: PullRequest) {
  if (parent.type !== "app" || parent.source?.type !== "git") return null;
  let preview = await previewFor(parent.id, pr.number);
  // Previews never own the parent's repository webhook.
  const source = { ...parent.source, branch: pr.branch, repository: pr.repository || parent.source.repository, webhook: null };

  let databaseId: string | null = null;
  if (!preview) {
    // Previews count against the organization's limits like any service.
    await requireRoomFor(await orgId(parent.projectId), [{ type: "app", runtime: parent.runtime }]);
    const id = newId();
    const slug = `${parent.slug}-pr${pr.number}`.slice(0, 60);
    [preview] = await db
      .insert(schema.service)
      .values({
        id,
        projectId: parent.projectId,
        environmentId: parent.environmentId,
        serverId: parent.serverId,
        name: `${parent.name} · PR #${pr.number}`,
        slug,
        type: "app",
        icon: parent.icon,
        source,
        build: parent.build,
        runtime: { ...parent.runtime, replicas: 1, ports: [], volumes: parent.runtime.volumes.filter((v) => v.kind === "volume") },
        autoDeploy: true,
        webhookSecret: newWebhookSecret(),
        parentServiceId: parent.id,
        previewPr: pr.number,
      })
      .returning();

    // Copy variables and mark the environment as a preview.
    const vars = await db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, parent.id));
    const rows = vars.map((v) => ({ id: newId(), serviceId: id, key: v.key, value: v.value, buildTime: v.buildTime, runtime: v.runtime }));
    const { encrypt } = await import("@/server/crypto");
    for (const [key, value] of [
      ["SERVE_PREVIEW", "true"],
      ["SERVE_PR_NUMBER", String(pr.number)],
    ]) {
      if (!rows.some((r) => r.key === key)) rows.push({ id: newId(), serviceId: id, key, value: encrypt(value), buildTime: true, runtime: true });
    }
    // Preview variables replace the service's: a preview must not reach production data.
    for (const [key, value] of Object.entries(parent.previewVars ?? {})) {
      const same = rows.find((r) => r.key === key);
      if (same) same.value = value;
      else rows.push({ id: newId(), serviceId: id, key, value, buildTime: true, runtime: true });
    }
    if (rows.length) await db.insert(schema.envVar).values(rows);

    if (parent.previewDatabase) databaseId = await createPreviewDatabase(preview, parent, pr.number);

    if (!(await addPreviewDomain(parent, id, pr.number))) {
      const host = await generatedHostname(slug, parent.serverId);
      if (host) {
        const [domain] = await db
          .insert(schema.domain)
          .values({ id: newId(), serviceId: id, hostname: host.hostname, port: await appDomainPort(parent.id), https: host.https, forceHttps: host.https, generated: true })
          .onConflictDoNothing()
          .returning();
        if (domain?.https) await ensureCertificateFor(domain, await orgId(parent.projectId));
      }
    }
    await logActivity({
      action: "preview.created",
      projectId: parent.projectId,
      targetType: "service",
      targetId: id,
      message: `Preview created for PR #${pr.number}${pr.title ? ` (${pr.title})` : ""}`,
    });
  } else {
    await db.update(schema.service).set({ source }).where(eq(schema.service.id, preview.id));
    // A URL template set after the preview opened: it gets that address with its next push.
    if (parent.previewDomain) {
      const domains = await db.select({ generated: schema.domain.generated }).from(schema.domain).where(eq(schema.domain.serviceId, preview.id));
      if (domains.every((d) => d.generated)) await addPreviewDomain(parent, preview.id, pr.number);
    }
  }

  const deployment = { commitSha: pr.sha, commitMessage: pr.title, branch: pr.branch };
  // A new preview with its own database: fill the copy first; that job deploys the preview.
  if (databaseId) {
    await enqueue("preview.database", { previewId: preview.id, databaseId, parentId: parent.id, deployment }, { concurrencyKey: `service:${databaseId}:copy` });
    return { preview, deploymentId: null };
  }
  const deploymentId = await queueDeployment(preview.id, "webhook", deployment);
  return { preview, deploymentId };
}

/**
 * Puts changed preview variables into the open previews: new values replace theirs, and a removed
 * one goes back to the service's value (or away). The variable the preview database fills stays.
 */
export async function syncPreviewVars(parent: Service, before: Record<string, string>, after: Record<string, string>) {
  const previews = await db.select({ id: schema.service.id }).from(schema.service).where(eq(schema.service.parentServiceId, parent.id));
  if (!previews.length) return;
  const own = await db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, parent.id));
  const skip = parent.previewDatabase?.variable;
  for (const p of previews) {
    for (const [key, value] of Object.entries(after)) {
      if (key === skip || before[key] === value) continue;
      await db
        .insert(schema.envVar)
        .values({ id: newId(), serviceId: p.id, key, value, buildTime: true, runtime: true })
        .onConflictDoUpdate({ target: [schema.envVar.serviceId, schema.envVar.key], set: { value, updatedAt: new Date() } });
    }
    for (const key of Object.keys(before)) {
      if (key === skip || Object.hasOwn(after, key)) continue;
      const original = own.find((v) => v.key === key);
      if (original)
        await db
          .update(schema.envVar)
          .set({ value: original.value, buildTime: original.buildTime, runtime: original.runtime, updatedAt: new Date() })
          .where(and(eq(schema.envVar.serviceId, p.id), eq(schema.envVar.key, key)));
      else await db.delete(schema.envVar).where(and(eq(schema.envVar.serviceId, p.id), eq(schema.envVar.key, key)));
    }
  }
}

export async function removePreview(parent: Service, prNumber: number) {
  const preview = await previewFor(parent.id, prNumber);
  if (!preview) return false;
  // Also removes the preview's database copy.
  await teardownServices([preview], true);
  await logActivity({ action: "preview.removed", projectId: parent.projectId, message: `Preview for PR #${prNumber} removed` });
  return true;
}

/** Post (or update) a comment on the GitHub PR with the preview URL. Best effort. */
export async function commentOnGithub(parent: Service, pr: PullRequest, url: string | null) {
  if (parent.source?.type !== "git" || !parent.source.credentialId || !pr.fullName) return;
  const [cred] = await db.select().from(schema.gitCredential).where(eq(schema.gitCredential.id, parent.source.credentialId));
  if (!cred || (cred.provider !== "github" && cred.provider !== "github-app")) return;
  let token: string;
  try {
    token =
      cred.provider === "github-app" ? await (await import("@/server/git/github-app")).installationToken(cred) : await (await import("@/server/git/oauth")).credentialToken(cred);
  } catch {
    return;
  }
  const api = `${cred.baseUrl ? `${cred.baseUrl.replace(/\/$/, "")}/api/v3` : "https://api.github.com"}/repos/${pr.fullName}/issues/${pr.number}/comments`;
  const marker = "<!-- serve-preview -->";
  const body = `${marker}\n**Serve preview** for \`${parent.name}\`\n\n${url ? `🔗 ${url}` : "Deploying…"}\n\nCommit \`${pr.sha?.slice(0, 7) ?? "latest"}\``;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" };
  try {
    const existing = (await (await fetch(`${api}?per_page=100`, { headers })).json()) as { id: number; body: string }[];
    const mine = Array.isArray(existing) ? existing.find((c) => c.body?.includes(marker)) : undefined;
    if (mine) {
      await fetch(api.replace(/\/issues\/\d+\/comments$/, `/issues/comments/${mine.id}`), { method: "PATCH", headers, body: JSON.stringify({ body }) });
    } else {
      await fetch(api, { method: "POST", headers, body: JSON.stringify({ body }) });
    }
  } catch {
    // ignore
  }
}
