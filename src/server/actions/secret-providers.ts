"use server";

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decryptOrNull, encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import { providerClient } from "@/server/secrets/resolve";
import { SecretFetchError, testProvider } from "@/server/secrets/providers";
import { getSetting } from "@/server/settings";
import { CREDENTIAL_KEYS, providerNamePattern, SECRET_PROVIDER_KINDS, SECRET_PROVIDERS, type SecretProviderCredentials } from "@/lib/secret-providers";

const text = (max = 500) => z.string().trim().max(max).optional();

const inputSchema = z.object({
  name: z.string().trim().toLowerCase().regex(providerNamePattern, "Use lowercase letters, digits and dashes, like prod-vault"),
  kind: z.enum(SECRET_PROVIDER_KINDS),
  config: z
    .object({
      url: text(),
      mount: text(200),
      kvVersion: z.union([z.literal(1), z.literal(2)]).optional(),
      namespace: text(200),
      projectId: text(200),
      environment: text(100),
      project: text(200),
      config: text(200),
      region: text(40),
    })
    .strip(),
  /** Empty fields keep what is stored, so editing never needs the token again. */
  credentials: z.record(z.string(), z.string().max(8000)),
  access: z.object({ projectIds: z.array(z.string()).max(500), environmentIds: z.array(z.string()).max(2000) }),
});

type Input = z.input<typeof inputSchema>;

/** Drop empty config values, check required fields and URLs, and merge credentials with the stored ones. */
async function prepare(organizationId: string, input: Input, stored: SecretProviderCredentials = {}) {
  const data = inputSchema.parse(input);
  const config = Object.fromEntries(Object.entries(data.config).filter(([, v]) => v !== undefined && v !== "")) as typeof data.config;
  const credentials: SecretProviderCredentials = { ...stored };
  for (const [k, v] of Object.entries(data.credentials)) if (CREDENTIAL_KEYS.has(k) && v.trim()) credentials[k as keyof SecretProviderCredentials] = v.trim();
  for (const f of SECRET_PROVIDERS[data.kind].fields) {
    if (f.optional) continue;
    const value = CREDENTIAL_KEYS.has(f.key) ? credentials[f.key as keyof SecretProviderCredentials] : config[f.key as keyof typeof config];
    if (!value) throw new UserError(`Enter the ${f.label.toLowerCase()}.`);
  }
  if (config.url) {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new UserError("Enter the URL with http:// or https://.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new UserError("The URL must start with http:// or https://.");
    // Tokens go over the network: plain HTTP is only for Root, on its own network.
    if (url.protocol === "http:" && organizationId !== (await getSetting("rootOrganizationId")))
      throw new UserError("Use an https:// URL, so the token is never sent in the clear.");
    config.url = url.toString().replace(/\/+$/, "");
  }

  // Access lists only keep this organization's projects and their environments.
  const projects = data.access.projectIds.length
    ? await db
        .select({ id: schema.project.id })
        .from(schema.project)
        .where(and(eq(schema.project.organizationId, organizationId), inArray(schema.project.id, data.access.projectIds)))
    : [];
  const projectIds = projects.map((p) => p.id);
  const envs =
    data.access.environmentIds.length && projectIds.length
      ? await db
          .select({ id: schema.environment.id })
          .from(schema.environment)
          .where(and(inArray(schema.environment.id, data.access.environmentIds), inArray(schema.environment.projectId, projectIds)))
      : [];
  return { name: data.name, kind: data.kind, config, credentials, access: { projectIds, environmentIds: envs.map((e) => e.id) } };
}

async function providerInOrg(id: string, organizationId: string) {
  const [row] = await db
    .select()
    .from(schema.secretProvider)
    .where(and(eq(schema.secretProvider.id, id), eq(schema.secretProvider.organizationId, organizationId)));
  if (!row) throw new UserError("Secret manager not found.");
  return row;
}

async function nameFree(organizationId: string, name: string, exceptId?: string) {
  const [taken] = await db
    .select({ id: schema.secretProvider.id })
    .from(schema.secretProvider)
    .where(and(eq(schema.secretProvider.organizationId, organizationId), eq(schema.secretProvider.name, name)));
  if (taken && taken.id !== exceptId) throw new UserError(`A secret manager named ${name} exists already.`);
}

export async function createSecretProvider(input: Input) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const p = await prepare(ctx.org.id, input);
    await nameFree(ctx.org.id, p.name);
    const id = newId();
    await db
      .insert(schema.secretProvider)
      .values({ id, organizationId: ctx.org.id, name: p.name, kind: p.kind, config: p.config, credentials: encrypt(JSON.stringify(p.credentials)), access: p.access });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "secret_provider.created", message: `Added secret manager ${p.name}` });
    return { id };
  });
}

export async function updateSecretProvider(id: string, input: Input) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const row = await providerInOrg(id, ctx.org.id);
    const stored = row.kind === input.kind ? (JSON.parse(decryptOrNull(row.credentials) ?? "{}") as SecretProviderCredentials) : {};
    const p = await prepare(ctx.org.id, input, stored);
    await nameFree(ctx.org.id, p.name, id);
    await db
      .update(schema.secretProvider)
      .set({ name: p.name, kind: p.kind, config: p.config, credentials: encrypt(JSON.stringify(p.credentials)), access: p.access, updatedAt: new Date() })
      .where(eq(schema.secretProvider.id, id));
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "secret_provider.updated", message: `Updated secret manager ${p.name}` });
    return null;
  });
}

export async function deleteSecretProvider(id: string) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const row = await providerInOrg(id, ctx.org.id);
    await db.delete(schema.secretProvider).where(eq(schema.secretProvider.id, id));
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "secret_provider.deleted", message: `Removed secret manager ${row.name}` });
    return null;
  });
}

/** Check a provider: the form's values before saving (`id` fills in stored credentials), or a saved one. */
export async function testSecretProvider(input: Input, id?: string) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const row = id ? await providerInOrg(id, ctx.org.id) : null;
    const stored = row && row.kind === input.kind ? (JSON.parse(decryptOrNull(row.credentials) ?? "{}") as SecretProviderCredentials) : {};
    const p = await prepare(ctx.org.id, input, stored);
    const client = await providerClient({
      id: id ?? "test",
      organizationId: ctx.org.id,
      name: p.name,
      kind: p.kind,
      config: p.config,
      credentials: encrypt(JSON.stringify(p.credentials)),
      access: p.access,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    try {
      return { message: await testProvider(client) };
    } catch (e) {
      throw new UserError(e instanceof SecretFetchError ? e.message : `The test failed: ${(e as Error).message}`);
    }
  });
}
