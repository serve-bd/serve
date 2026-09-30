import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { pickPrimaryDomain } from "@/lib/domains";

export type PreviewRow = {
  id: string;
  pr: number;
  status: string;
  branch: string | null;
  url: string | null;
  createdAt: string;
  database: boolean;
  deployment: { id: string; status: string; title: string | null; sha: string | null; createdAt: string } | null;
};

/** The open pull request previews of an app, newest pull request first. */
export async function loadPreviews(serviceId: string): Promise<PreviewRow[]> {
  const previews = await db
    .select()
    .from(schema.service)
    .where(and(eq(schema.service.parentServiceId, serviceId), isNotNull(schema.service.previewPr), eq(schema.service.type, "app")))
    .orderBy(desc(schema.service.previewPr));
  const ids = previews.map((p) => p.id);
  if (!ids.length) return [];
  const [domains, deployments, copies] = await Promise.all([
    db.select().from(schema.domain).where(inArray(schema.domain.serviceId, ids)),
    db
      .selectDistinctOn([schema.deployment.serviceId])
      .from(schema.deployment)
      .where(inArray(schema.deployment.serviceId, ids))
      .orderBy(schema.deployment.serviceId, desc(schema.deployment.createdAt)),
    db.select({ parentServiceId: schema.service.parentServiceId }).from(schema.service).where(inArray(schema.service.parentServiceId, ids)),
  ]);
  return previews.map((p) => {
    const domain = pickPrimaryDomain(domains.filter((d) => d.serviceId === p.id));
    const dep = deployments.find((d) => d.serviceId === p.id);
    return {
      id: p.id,
      pr: p.previewPr!,
      status: p.status,
      branch: p.source?.type === "git" ? p.source.branch : null,
      url: domain ? `${domain.https ? "https" : "http"}://${domain.hostname}` : null,
      createdAt: p.createdAt.toISOString(),
      database: copies.some((c) => c.parentServiceId === p.id),
      deployment: dep ? { id: dep.id, status: dep.status, title: dep.commitMessage, sha: dep.commitSha, createdAt: dep.createdAt.toISOString() } : null,
    };
  });
}
