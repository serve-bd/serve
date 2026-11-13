import { eq } from "drizzle-orm";
import { UserError, type ActionResult } from "@/server/action";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import type { StackFileRecord } from "@/server/db/schema";
import { rewriteLinks, STACK_FILE, variableChanges } from "@/lib/stack";
import type { PlanContext, Resolved, StackOptions, StackPlan } from "./plan";

type Service = typeof schema.service.$inferSelect;

const must = async <T>(r: Promise<ActionResult<T>>, what: string): Promise<T> => {
  const out = await r;
  if (!out.ok) throw new UserError(`${what}: ${out.error}`);
  return out.data;
};

export type Applied = { key: string; serviceId: string; name: string; action: "create" | "update" | "unchanged"; upload: string | null };

/**
 * Makes the environment match the plan: missing services are created (nothing deploys yet), then
 * each service's source, port, settings, domains and variables are set. Variables go last, once
 * every service exists, so links bind to their rows. The caller checked the plan is ready.
 */
export async function applyStack(ctx: PlanContext & { userId: string }, plan: StackPlan, resolved: Resolved[], opts: StackOptions): Promise<Applied[]> {
  if (!plan.stack) throw new UserError("The file has no stack.");
  const stackName = plan.stack;
  const services = await import("@/server/actions/services");
  const created = new Map<string, Service>();

  // 1. Create what is missing, in deploy order, without deploying.
  for (const wave of plan.waves)
    for (const key of wave) {
      const r = resolved.find((x) => x.key === key);
      if (!r || r.existing) continue;
      const base = { projectId: ctx.projectId, environmentId: ctx.environmentId, name: key, serverId: r.serverId, deploy: false };
      let id: string;
      if (r.kind === "database" && r.database) {
        id = (
          await must(
            services.createDatabaseService({
              ...base,
              engine: r.database.engine,
              version: r.database.version ?? undefined,
              username: r.database.username,
              database: r.database.database,
              password: r.database.password,
            }),
            key,
          )
        ).id;
      } else if (r.kind === "compose") {
        id = (await must(services.createComposeService({ ...base, mode: "inline", content: r.compose ?? "" }), key)).id;
      } else {
        const build = typeof r.spec.build === "object" ? { rootDir: r.spec.build.rootDir ? `/${r.spec.build.rootDir.replace(/^\.?\/+/, "")}` : undefined } : undefined;
        const source =
          r.kind === "git" && r.git
            ? { type: "git" as const, repository: r.git.repository, branch: r.git.branch ?? "main", credentialId: r.git.credentialId }
            : r.kind === "image"
              ? { type: "image" as const, image: r.spec.image ?? "" }
              : { type: "upload" as const };
        id = (await must(services.createAppService({ ...base, source, build, port: r.spec.port ?? null }), key)).id;
      }
      await db.update(schema.service).set({ stackName, stackKey: key }).where(eq(schema.service.id, id));
      const [row] = await db.select().from(schema.service).where(eq(schema.service.id, id));
      created.set(key, row);
    }

  const serviceOf = (r: Resolved) => r.existing ?? (created.get(r.key) as Service);
  const names = new Map(resolved.map((r) => [r.key.toLowerCase(), serviceOf(r).name]));
  const out: Applied[] = [];
  const item = (key: string) => plan.services.find((s) => s.key === key);

  // 2. Each service's own settings, then its variables.
  for (const r of resolved) {
    const service = serviceOf(r);
    const last = service.stackFile;
    const record: StackFileRecord = { appliedAt: new Date().toISOString(), variables: {}, domains: r.domains.map((d) => d.host), settings: r.settings, port: r.spec.port ?? null };

    if (r.existing) {
      const patch: Parameters<typeof services.updateService>[1] = {};
      if (r.git && service.source?.type === "git" && (service.source.repository !== r.git.repository || (r.git.branch && service.source.branch !== r.git.branch)))
        patch.source = { type: "git", repository: r.git.repository, branch: r.git.branch ?? service.source.branch, credentialId: r.git.credentialId };
      if (r.spec.image && service.source?.type === "image" && service.source.image !== r.spec.image) patch.source = { ...service.source, image: r.spec.image };
      const keepPort = last?.port != null && service.runtime.port !== last.port && !opts.force;
      if (r.spec.port !== undefined && service.runtime.port !== r.spec.port && !keepPort) patch.runtime = { port: r.spec.port };
      if (r.kind === "compose" && r.compose !== null && service.compose?.content !== r.compose) patch.compose = { content: r.compose };
      if (Object.keys(patch).length) await must(services.updateService(service.id, patch), r.key);
    }

    // serve.json-style settings: applied like a serve.json, so dashboard changes win the same way.
    if (r.settings) {
      const [fresh] = await db.select().from(schema.service).where(eq(schema.service.id, service.id));
      const { applyServeConfig } = await import("@/server/services/serve-config");
      const lines: string[] = [];
      const log = { step: () => {}, line: (l: string) => lines.push(l) };
      try {
        await applyServeConfig(
          fresh,
          { path: `${STACK_FILE}#${r.key}`, text: r.settings },
          { deploymentId: fresh.configFile?.deploymentId ?? "", commitSha: null, organizationId: ctx.organizationId, log, now: true, force: opts.force },
        );
      } catch (e) {
        throw new UserError(`${r.key}: ${(e as Error).message}`);
      }
    }

    // Domains: the file's are added; ones it set before and dropped are removed.
    const have = await db.select().from(schema.domain).where(eq(schema.domain.serviceId, service.id));
    for (const d of r.domains)
      if (!have.some((h) => h.hostname === d.host))
        await must(services.addDomain(service.id, { hostname: d.host, port: d.port, composeService: d.service }), `${r.key}: ${d.host}`);
    for (const h of have)
      if ((last?.domains ?? []).includes(h.hostname) && !r.domains.some((d) => d.host === h.hostname)) await must(services.removeDomain(h.id, false), `${r.key}: ${h.hostname}`);

    out.push({ key: r.key, serviceId: service.id, name: service.name, action: r.existing ? (item(r.key)?.action ?? "unchanged") : "create", upload: item(r.key)?.upload ?? null });
    record.variables = rewriteLinks(r.env, names);
    (r as Resolved & { record?: StackFileRecord }).record = record;
  }

  // 3. Variables, now that every service exists: links bind to the rows they reach.
  for (const r of resolved) {
    const service = serviceOf(r);
    const record = (r as Resolved & { record: StackFileRecord }).record;
    const rows = await db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, service.id));
    const current = new Map(rows.map((v) => [v.key, decryptOrNull(v.value) ?? ""]));
    const change = variableChanges(current, record.variables, service.stackFile?.variables ?? {}, !!opts.force);
    if (change.set.length || change.remove.length) {
      const set = new Set(change.set);
      const remove = new Set(change.remove);
      const list = [
        ...rows
          .filter((v) => !set.has(v.key) && !remove.has(v.key))
          .map((v) => ({ key: v.key, value: "", keep: v.key, buildTime: v.buildTime, runtime: v.runtime, literal: v.literal, multiline: v.multiline })),
        ...change.set.map((k) => {
          const old = rows.find((v) => v.key === k);
          return {
            key: k,
            value: record.variables[k],
            buildTime: old?.buildTime ?? true,
            runtime: old?.runtime ?? true,
            literal: false,
            multiline: record.variables[k].includes("\n"),
          };
        }),
      ];
      await must(services.saveEnvVars(service.id, list, false), `${r.key}: variables`);
    }
    await db.update(schema.service).set({ stackName, stackKey: r.key, stackFile: record }).where(eq(schema.service.id, service.id));
  }

  // 4. Services that left the file, when asked to remove them (their volumes stay).
  for (const o of plan.orphans) if (o.remove) await must(services.deleteService(o.serviceId, false), `${o.key}: remove`);
  return out;
}
