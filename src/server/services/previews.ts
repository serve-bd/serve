import { withoutHostAccess } from "@/server/services/types";
import { and, eq, isNull, sql } from "drizzle-orm";
import { requireRoomFor } from "@/server/limits";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { ensureCertificateFor } from "@/server/ssl/certificates";
import { generatedHostname, newWebhookSecret, queueDeployment } from "./create";
import { createPreviewDatabase } from "./environments";
import { branchesSupported, createPreviewBranch, enqueueBranchJob } from "@/server/databases/branches";
import { teardownServices } from "./teardown";

type Service = typeof schema.service.$inferSelect;

export type PullRequest = {
  number: number;
  branch: string;
  repository: string;
  title: string | null;
  sha: string | null;
  author: string | null;
  /** owner/repo of the pull request's target, used for its preview comment. */
  fullName?: string | null;
  /** Apps deployed from an image: the image the preview runs (see imageWithTag). */
  image?: string | null;
};

export { imageWithTag } from "@/lib/preview-image";

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

/** The port the app's own domain routes to, so a preview answers on the same one. */
async function appDomainPort(serviceId: string) {
  const own = await db.select({ port: schema.domain.port, redirectTo: schema.domain.redirectTo }).from(schema.domain).where(eq(schema.domain.serviceId, serviceId));
  return own.find((d) => !d.redirectTo && d.port)?.port ?? null;
}

/**
 * The preview URL template with the pull request number, reached like the app's own domain: through its Cloudflare Tunnel
 * (a record per preview), with a DNS record in its Cloudflare zone, or through a wildcard record the
 * owner points at the server. Not added when the service has no preview domain or the name is taken,
 * nor when its DNS record could not be made (`dnsProblem` says why): the preview then keeps its
 * generated address, and its next push tries again.
 */
export async function addPreviewDomain(parent: Service, previewId: string, prNumber: number): Promise<{ added: boolean; dnsProblem?: string }> {
  if (!parent.previewDomain) return { added: false };
  const { previewHostname, previewTemplateProblem } = await import("@/lib/preview-url");
  if (previewTemplateProblem(parent.previewDomain)) return { added: false };
  const hostname = previewHostname(parent.previewDomain, prNumber);
  const [taken] = await db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.hostname, hostname));
  if (taken) return { added: false };
  const own = await db.select().from(schema.domain).where(eq(schema.domain.serviceId, parent.id));
  const like = own.find((d) => d.tunnelId) ?? own.find((d) => !d.generated && !d.redirectTo);
  const { Cloudflare } = await import("@/server/cloudflare/api");
  let route: { accountId: string; zoneId: string; recordId: string | null; tunnelId: string | null } | null = null;
  try {
    if (like?.tunnelId) {
      const [tunnel] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, like.tunnelId));
      // The app's shared tunnel reaches the app's servers, not the preview's: its server's own tunnel does.
      const [own] =
        tunnel?.serviceId && tunnel.serverId === parent.serverId
          ? await db
              .select()
              .from(schema.cloudflareTunnel)
              .where(
                and(
                  eq(schema.cloudflareTunnel.serverId, parent.serverId),
                  eq(schema.cloudflareTunnel.cloudflareAccountId, tunnel.cloudflareAccountId),
                  isNull(schema.cloudflareTunnel.serviceId),
                ),
              )
          : [tunnel];
      if (own && own.serverId === parent.serverId) {
        const cf = await Cloudflare.forAccount(own.cloudflareAccountId);
        const zone = await cf.zoneFor(hostname);
        if (zone) {
          const record = await cf.upsertTunnelRecord(zone.id, hostname, own.cfTunnelId);
          route = { accountId: own.cloudflareAccountId, zoneId: zone.id, recordId: record?.id ?? null, tunnelId: own.id };
        }
      }
    } else if (like?.cloudflareAccountId && like.cloudflareRecordId) {
      const { serverPublicIp } = await import("@/server/servers/access");
      const ip = await serverPublicIp(parent.serverId);
      const cf = await Cloudflare.forAccount(like.cloudflareAccountId);
      const zone = ip ? await cf.zoneFor(hostname) : null;
      if (ip && zone) {
        // Null without an error: the owner's own A record already points at the server.
        const record = await cf.upsertARecord(zone.id, hostname, ip, false);
        route = { accountId: like.cloudflareAccountId, zoneId: zone.id, recordId: record?.id ?? null, tunnelId: null };
      }
    }
  } catch (e) {
    // An address that cannot resolve is never handed out.
    return { added: false, dnsProblem: dnsProblem(hostname, e) };
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
  if (!domain) return { added: false };
  if (route?.tunnelId) {
    const { syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
    await syncTunnelIngress(route.tunnelId).catch(() => {});
  } else if (https) await ensureCertificateFor(domain, await orgId(parent.projectId));
  return { added: true };
}

/** Why a preview's DNS record could not be made, for the deployment log and the pull request. */
export function dnsProblem(hostname: string, e: unknown) {
  const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
  return `The DNS record for ${hostname} could not be created in Cloudflare: ${reason}`;
}

/** Create or update the preview service for a pull request and deploy it. */
export async function deployPreview(parent: Service, pr: PullRequest) {
  // Two webhooks for the same new pull request at once (opened and a push) must not both create it:
  // they run one after the other. In memory, not a database lock, which would hold a pool
  // connection for the whole setup while the setup needs others.
  const key = `${parent.id}:${pr.number}`;
  const run = (previewLocks.get(key) ?? Promise.resolve()).catch(() => {}).then(() => deployPreviewLocked(parent, pr));
  const done = run.catch(() => {});
  previewLocks.set(key, done);
  void done.then(() => {
    if (previewLocks.get(key) === done) previewLocks.delete(key);
  });
  return run;
}

const previewLocks = new Map<string, Promise<unknown>>();

async function deployPreviewLocked(parent: Service, pr: PullRequest) {
  if (parent.type !== "app" || (parent.source?.type !== "git" && parent.source?.type !== "image")) return null;
  if (parent.source.type === "image" && !pr.image) return null;
  let preview = await previewFor(parent.id, pr.number);
  const source: Service["source"] =
    parent.source.type === "image"
      ? { ...parent.source, image: pr.image! }
      : // Previews never own the parent's repository webhook.
        { ...parent.source, branch: pr.branch, repository: pr.repository || parent.source.repository, webhook: null };

  let dns: string | null = null;
  let databaseId: string | null = null;
  let branch: { id: string; serviceId: string; reset: boolean } | null = null;
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
        // Branch code runs here: never with the parent's host-level access.
        runtime: { ...withoutHostAccess(parent.runtime), replicas: 1, volumes: parent.runtime.volumes.filter((v) => v.kind === "volume" && !v.external) },
        autoDeploy: true,
        webhookSecret: newWebhookSecret(),
        parentServiceId: parent.id,
        previewPr: pr.number,
      })
      .returning();

    // Copy variables and mark the environment as a preview.
    const vars = await db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, parent.id));
    const rows: (typeof schema.envVar.$inferInsert)[] = vars.map((v) => ({
      id: newId(),
      serviceId: id,
      key: v.key,
      value: v.value,
      buildTime: v.buildTime,
      runtime: v.runtime,
      literal: v.literal,
      multiline: v.multiline,
    }));
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
      // Preview values hold references (a database copy's URL): never literal.
      if (same) Object.assign(same, { value, literal: false });
      else rows.push({ id: newId(), serviceId: id, key, value, buildTime: true, runtime: true });
    }
    if (rows.length) await db.insert(schema.envVar).values(rows);

    if (parent.previewDatabase?.mode === "branch") branch = await previewBranch(preview, parent, pr.number);
    else if (parent.previewDatabase) databaseId = await createPreviewDatabase(preview, parent, pr.number);

    const added = await addPreviewDomain(parent, id, pr.number);
    dns = added.dnsProblem ?? null;
    if (!added.added) {
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
      if (domains.every((d) => d.generated)) dns = (await addPreviewDomain(parent, preview.id, pr.number)).dnsProblem ?? null;
    }
  }
  if (dns) {
    await logActivity({ action: "preview.dns-failed", projectId: parent.projectId, targetType: "service", targetId: preview.id, message: `${preview.name}: ${dns}` });
  }

  const deployment = { commitSha: pr.sha, commitMessage: pr.title, branch: parent.source.type === "git" ? pr.branch : null };
  // A new preview with its own branch: fill it first; that job deploys the preview.
  if (branch) {
    await enqueueBranchJob({ branchId: branch.id, op: branch.reset ? "reset" : "create", preview: { previewId: preview.id, deployment } }, branch.serviceId);
    return { preview, deploymentId: null, dnsProblem: dns };
  }
  // A new preview with its own database: fill the copy first; that job deploys the preview.
  if (databaseId) {
    await enqueue("preview.database", { previewId: preview.id, databaseId, parentId: parent.id, deployment }, { concurrencyKey: `service:${databaseId}:copy` });
    return { preview, deploymentId: null, dnsProblem: dns };
  }
  const deploymentId = await queueDeployment(preview.id, "webhook", deployment);
  if (dns) await appendLog(deploymentId, `${dns}. The next push tries again.`);
  return { preview, deploymentId, dnsProblem: dns };
}

/** One more line in a deployment's log. */
async function appendLog(deploymentId: string, line: string) {
  await db
    .update(schema.deployment)
    .set({ logs: sql`${schema.deployment.logs} || ${`${line}\n`}` })
    .where(eq(schema.deployment.id, deploymentId))
    .catch((e: Error) => console.error(`[previews] could not log to ${deploymentId}: ${e.message}`));
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
        .onConflictDoUpdate({ target: [schema.envVar.serviceId, schema.envVar.key], set: { value, literal: false, updatedAt: new Date() } });
    }
    for (const key of Object.keys(before)) {
      if (key === skip || Object.hasOwn(after, key)) continue;
      const original = own.find((v) => v.key === key);
      if (original)
        await db
          .update(schema.envVar)
          .set({ value: original.value, buildTime: original.buildTime, runtime: original.runtime, literal: original.literal, multiline: original.multiline, updatedAt: new Date() })
          .where(and(eq(schema.envVar.serviceId, p.id), eq(schema.envVar.key, key)));
      else await db.delete(schema.envVar).where(and(eq(schema.envVar.serviceId, p.id), eq(schema.envVar.key, key)));
    }
  }
}

/** The preview's branch of the source database, when previews branch instead of copying. */
async function previewBranch(preview: Service, parent: Service, prNumber: number) {
  const cfg = parent.previewDatabase;
  if (!cfg) return null;
  const [source] = await db
    .select()
    .from(schema.service)
    .where(and(eq(schema.service.id, cfg.sourceServiceId), eq(schema.service.environmentId, parent.environmentId)));
  if (!source || !branchesSupported(source)) return null;
  const b = await createPreviewBranch(preview, source, prNumber, cfg.variable);
  return { id: b.id, serviceId: source.id, reset: b.status === "resetting" };
}

export async function removePreview(parent: Service, prNumber: number) {
  const preview = await previewFor(parent.id, prNumber);
  if (!preview) return false;
  // Also removes the preview's database copy.
  await teardownServices([preview], true);
  await logActivity({ action: "preview.removed", projectId: parent.projectId, message: `Preview for PR #${prNumber} removed` });
  void commentOnPullRequest(parent, { number: prNumber, sha: null }, "removed");
  return true;
}

/** Text inside a Markdown code span: no backtick or line break can end it early. */
const code = (text: string) => `\`${text.replace(/[`\r\n]+/g, " ").slice(0, 400)}\``;

export type PreviewCommentState = { url: string | null; dnsProblem?: string | null } | "removed";

/** The preview comment's text (the provider's hidden marker is added when it is sent). */
export function previewCommentBody(serviceName: string, sha: string | null | undefined, state: PreviewCommentState) {
  const head = `**Serve preview** for ${code(serviceName)}`;
  if (state === "removed") return `${head}\n\nThe preview was removed.`;
  const lines = [head, ""];
  if (state.dnsProblem) {
    const meanwhile = state.url ? `Until then the preview answers at ${state.url}` : "Until then the preview has no address.";
    lines.push(`⚠️ ${code(state.dnsProblem)}`, "", `Serve tries again on the next push. ${meanwhile}`);
  } else lines.push(state.url ? `🔗 ${state.url}` : "Deploying…");
  const commit = sha && /^[0-9a-f]{7,64}$/i.test(sha) ? sha.slice(0, 7) : "latest";
  lines.push("", `Commit ${code(commit)}`);
  return lines.join("\n");
}

const commentLocks = new Map<string, Promise<unknown>>();

/**
 * Writes the preview's state into its pull request comment (GitHub, GitLab, Gitea/Forgejo and
 * Bitbucket Cloud): made on the first deploy, edited after, and only edited (never made) when the
 * preview is removed. Best effort: a failure is logged, never thrown.
 */
export function commentOnPullRequest(parent: Service, pr: Pick<PullRequest, "number" | "sha" | "fullName">, state: PreviewCommentState) {
  // One at a time per pull request, so two quick deploys do not both make a comment.
  const key = `${parent.id}:${pr.number}`;
  const run = (commentLocks.get(key) ?? Promise.resolve()).then(() => writeComment(parent, pr, state));
  commentLocks.set(key, run);
  void run.then(() => {
    if (commentLocks.get(key) === run) commentLocks.delete(key);
  });
  return run;
}

async function writeComment(parent: Service, pr: Pick<PullRequest, "number" | "sha" | "fullName">, state: PreviewCommentState) {
  try {
    if (parent.source?.type !== "git" || !parent.source.credentialId) return;
    const [cred] = await db.select().from(schema.gitCredential).where(eq(schema.gitCredential.id, parent.source.credentialId));
    if (!cred) return;
    const { upsertPreviewComment } = await import("@/server/git/pr-comments");
    const body = previewCommentBody(parent.name, pr.sha, state);
    // The pull request's repository when the event names it, else the app's (the same one).
    await upsertPreviewComment(cred, pr.fullName || parent.source.repository, pr.number, body, { create: state !== "removed" });
  } catch (e) {
    console.error(`[previews] could not comment on pull request #${pr.number} for service ${parent.id}: ${(e as Error).message}`);
  }
}
