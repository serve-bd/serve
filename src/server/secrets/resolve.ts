import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { REF } from "@/lib/refs";
import { parseSecretRef, providerAllows, SECRETS_SCOPE, type SecretProviderCredentials } from "@/lib/secret-providers";
import { getSetting } from "@/server/settings";
import { fetchSecrets } from "./providers";

type Row = typeof schema.secretProvider.$inferSelect;

/** A provider row ready to call: credentials decrypted, private addresses allowed for Root. */
export async function providerClient(row: Row) {
  const rootId = await getSetting("rootOrganizationId");
  const credentials = JSON.parse(decryptOrNull(row.credentials) ?? "{}") as SecretProviderCredentials;
  return { kind: row.kind, config: row.config, credentials, allowPrivate: row.organizationId === rootId };
}

/**
 * Fetch every ${{secrets.<name>.<path>}} that `values` use, for a service in this project and
 * environment. `found` maps "<name>.<path>[:field]" to the value; `errors` explain each one that
 * could not be read. Nothing is cached or stored.
 */
export async function resolveSecretRefs(organizationId: string, projectId: string, environmentId: string, values: string[]) {
  const wanted = new Map<string, { provider: string; path: string; field: string | null }>();
  const errors: { ref: string; message: string }[] = [];
  for (const v of values)
    for (const [, ref] of v.matchAll(REF)) {
      if (!ref.toLowerCase().startsWith(`${SECRETS_SCOPE}.`)) continue;
      const rest = ref.slice(SECRETS_SCOPE.length + 1);
      const parsed = parseSecretRef(rest);
      if (!parsed) errors.push({ ref, message: "write it as secrets.<provider>.<path> or secrets.<provider>.<path>:<FIELD>" });
      else wanted.set(rest, parsed);
    }
  const found = new Map<string, string>();
  if (!wanted.size) return { found, errors };

  const names = [...new Set([...wanted.values()].map((w) => w.provider))];
  const rows = await db
    .select()
    .from(schema.secretProvider)
    .where(and(eq(schema.secretProvider.organizationId, organizationId), inArray(schema.secretProvider.name, names)));
  const envIds = [...new Set(rows.flatMap((r) => r.access.environmentIds))];
  const envProject = new Map(
    envIds.length
      ? (await db.select({ id: schema.environment.id, projectId: schema.environment.projectId }).from(schema.environment).where(inArray(schema.environment.id, envIds))).map(
          (e) => [e.id, e.projectId] as const,
        )
      : [],
  );

  await Promise.all(
    names.map(async (name) => {
      const refs = [...wanted].filter(([, w]) => w.provider === name);
      const row = rows.find((r) => r.name === name);
      if (!row) {
        for (const [rest] of refs) errors.push({ ref: `secrets.${rest}`, message: `there is no secret manager named ${name}` });
        return;
      }
      if (!providerAllows(row.access, projectId, environmentId, (id) => envProject.get(id))) {
        for (const [rest] of refs) errors.push({ ref: `secrets.${rest}`, message: `${name} may not be used in this project or environment (see its Access settings)` });
        return;
      }
      const result = await fetchSecrets(
        await providerClient(row),
        refs.map(([, w]) => ({ path: w.path, field: w.field })),
      );
      for (const [rest, w] of refs) {
        const value = result.get(w.field === null ? w.path : `${w.path}:${w.field}`);
        if (typeof value === "string") found.set(rest, value);
        else errors.push({ ref: `secrets.${rest}`, message: value?.message ?? "not read" });
      }
    }),
  );
  return { found, errors };
}
