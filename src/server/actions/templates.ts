"use server";

import dns from "node:dns/promises";
import net from "node:net";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import { parseCompose } from "@/server/deploy/compose";
import { isPrivateAddress, publicGet } from "@/server/net/public-fetch";
import { composeSecurityIssues } from "@/server/security";
import { composeVariables } from "@/lib/compose-vars";
import { reloadTemplates } from "@/server/services/templates";

const varSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Variable names use letters, numbers and underscores"),
  generate: z.enum(["password", "strongPassword", "secret", "hex32", "hex16", "base64key"]).optional(),
  value: z.string().max(4000).optional(),
  publicUrl: z.boolean().optional(),
  publicHost: z.boolean().optional(),
  label: z.string().trim().max(60).optional(),
});

const templateSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(60),
  description: z.string().trim().max(200).default(""),
  category: z.string().trim().min(1).max(40).default("Custom"),
  iconUrl: z
    .union([z.url({ protocol: /^https?$/, message: "Use an http(s) image URL" }), z.literal("")])
    .nullable()
    .optional(),
  compose: z.string().min(1, "Paste a compose file").max(200_000),
  vars: z.array(varSchema).max(100),
  exposeService: z.string().trim().max(100).nullable().optional(),
  exposePort: z.number().int().min(1).max(65535).nullable().optional(),
});

export type CustomTemplateInput = z.input<typeof templateSchema>;

function validate(data: z.output<typeof templateSchema>, allowHost: boolean, inRoot: boolean) {
  let services: string[];
  try {
    services = Object.keys(parseCompose(data.compose).services ?? {});
  } catch (e) {
    throw new UserError(`The compose file is not valid: ${(e as Error).message}`);
  }
  const issues = composeSecurityIssues(data.compose);
  if (issues.length && !allowHost) {
    const who = inRoot ? "only admins of the Root organization may use" : "only services of the Root organization may use";
    throw new UserError(`This compose file uses options ${who}: ${issues.slice(0, 3).join("; ")}.`);
  }
  if (data.exposeService && !services.includes(data.exposeService)) throw new UserError(`The compose file has no service named ${data.exposeService}.`);
  if (data.exposeService && !data.exposePort) throw new UserError("Enter the port the exposed service listens on.");
  const keys = new Set<string>();
  for (const v of data.vars) {
    if (keys.has(v.key)) throw new UserError(`${v.key} is listed twice.`);
    keys.add(v.key);
  }
  const missing = composeVariables(data.compose).filter((v) => !v.hasDefault && !keys.has(v.name));
  if (missing.length) throw new UserError(`Add ${missing.map((m) => m.name).join(", ")} to the variables, or give ${missing.length === 1 ? "it" : "them"} a default in the file.`);
}

export async function saveCustomTemplate(id: string | null, input: CustomTemplateInput) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const data = templateSchema.parse(input);
    // Templates are deployed in their own organization: host options only in the Root organization.
    validate(data, ctx.isInstanceAdmin && ctx.isRoot, ctx.isRoot);
    const values = {
      name: data.name,
      description: data.description,
      category: data.category,
      iconUrl: data.iconUrl || null,
      compose: data.compose,
      vars: data.vars,
      exposeService: data.exposeService || null,
      exposePort: data.exposeService ? (data.exposePort ?? null) : null,
    };
    if (id) {
      const [row] = await db
        .update(schema.customTemplate)
        .set(values)
        .where(and(eq(schema.customTemplate.id, id), eq(schema.customTemplate.organizationId, ctx.org.id)))
        .returning({ id: schema.customTemplate.id });
      if (!row) throw new UserError("Template not found.");
      await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "template.update", message: `Updated template ${data.name}` });
      return { id };
    }
    const newIdValue = newId();
    await db.insert(schema.customTemplate).values({ id: newIdValue, organizationId: ctx.org.id, createdBy: ctx.user.id, ...values });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "template.create", message: `Added template ${data.name}` });
    return { id: newIdValue };
  });
}

export async function deleteCustomTemplate(id: string) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const [row] = await db
      .delete(schema.customTemplate)
      .where(and(eq(schema.customTemplate.id, id), eq(schema.customTemplate.organizationId, ctx.org.id)))
      .returning({ name: schema.customTemplate.name });
    if (!row) throw new UserError("Template not found.");
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "template.delete", message: `Deleted template ${row.name}` });
    return null;
  });
}

/* ------------------------------ Import by URL ----------------------------- */

const MAX_BYTES = 256 * 1024;

async function assertPublicUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UserError("Enter a full URL like https://raw.githubusercontent.com/owner/repo/main/compose.yml");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UserError("Only http and https URLs can be imported.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new UserError(`${host} does not resolve.`);
  if (addresses.some(isPrivateAddress)) throw new UserError("That address points at a private network and cannot be imported.");
  return url;
}

/** Fetches a compose file from a public URL (GitHub "raw" links, gists, …). */
export async function fetchComposeFromUrl(raw: string) {
  return act(async () => {
    await requirePermission("integrations.manage");
    let url = await assertPublicUrl(raw);
    // GitHub page links → raw file.
    const gh = url.hostname === "github.com" && url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (gh) url = new URL(`https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`);
    // publicGet checks every redirect and the address actually connected to (no DNS rebinding).
    const res = await publicGet(url.href, { maxRedirects: 3, timeoutMs: 8000 }).catch((e) => {
      throw new UserError(`Could not fetch the file: ${(e as Error).message}`);
    });
    if (res.status < 200 || res.status >= 300) {
      res.body.resume();
      throw new UserError(`The server answered ${res.status}.`);
    }
    if (Number(res.headers["content-length"] ?? 0) > MAX_BYTES) {
      res.body.destroy();
      throw new UserError("The file is larger than 256 KB.");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of res.body as AsyncIterable<Buffer>) {
      size += value.byteLength;
      if (size > MAX_BYTES) {
        res.body.destroy();
        throw new UserError("The file is larger than 256 KB.");
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      parseCompose(text);
    } catch (e) {
      throw new UserError(`That file is not a compose file: ${(e as Error).message}`);
    }
    return text;
  });
}

/** Loads the built-in template list from GitHub now. */
export async function reloadTemplateCatalog() {
  return act(async () => {
    await requirePermission("services.manage");
    const { count, error } = await reloadTemplates();
    if (error) throw new UserError(error);
    return { count };
  });
}
