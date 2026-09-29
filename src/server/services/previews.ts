import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { ensureCertificateFor } from "@/server/ssl/certificates";
import { generatedHostname, newWebhookSecret, queueDeployment } from "./create";

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
export async function deployPreview(parent: Service, pr: PullRequest) {
  if (parent.source?.type !== "git") return null;
  let preview = await previewFor(parent.id, pr.number);
  const source = { ...parent.source, branch: pr.branch, repository: pr.repository || parent.source.repository };

  if (!preview) {
    const id = newId();
    const slug = `${parent.slug}-pr${pr.number}`.slice(0, 60);
    [preview] = await db
      .insert(schema.service)
      .values({
        id,
        projectId: parent.projectId,
        environmentId: parent.environmentId,
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
    if (rows.length) await db.insert(schema.envVar).values(rows);

    const host = await generatedHostname(slug);
    if (host) {
      const [domain] = await db
        .insert(schema.domain)
        .values({ id: newId(), serviceId: id, hostname: host.hostname, https: host.https, forceHttps: host.https, generated: true })
        .onConflictDoNothing()
        .returning();
      if (domain?.https) await ensureCertificateFor(domain, await orgId(parent.projectId));
    }
    await logActivity({ action: "preview.created", projectId: parent.projectId, targetType: "service", targetId: id, message: `Preview created for PR #${pr.number}${pr.title ? ` (${pr.title})` : ""}` });
  } else {
    await db.update(schema.service).set({ source }).where(eq(schema.service.id, preview.id));
  }

  const deploymentId = await queueDeployment(preview.id, "webhook", { commitSha: pr.sha, commitMessage: pr.title, branch: pr.branch });
  return { preview, deploymentId };
}

export async function removePreview(parent: Service, prNumber: number) {
  const preview = await previewFor(parent.id, prNumber);
  if (!preview) return false;
  await db.delete(schema.service).where(eq(schema.service.id, preview.id));
  await enqueue("service.delete", { serviceId: preview.id, slug: preview.slug, type: preview.type, removeVolumes: true }, { concurrencyKey: `service:${preview.id}` });
  await logActivity({ action: "preview.removed", projectId: parent.projectId, message: `Preview for PR #${prNumber} removed` });
  return true;
}

/** Post (or update) a comment on the GitHub PR with the preview URL. Best effort. */
export async function commentOnGithub(parent: Service, pr: PullRequest, url: string | null) {
  if (parent.source?.type !== "git" || !parent.source.credentialId || !pr.fullName) return;
  const [cred] = await db.select().from(schema.gitCredential).where(eq(schema.gitCredential.id, parent.source.credentialId));
  if (!cred || cred.provider !== "github") return;
  const token = decrypt(cred.secret);
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
