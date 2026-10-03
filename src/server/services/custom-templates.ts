import "server-only";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { randomPassword, randomSecret } from "@/server/crypto";
import { getTemplate, type TemplateVar } from "@/server/services/templates";
import { composeVarSuffix } from "@/lib/refs";

export const CUSTOM_PREFIX = "custom:";

/** A built-in or organization template, in one shape. */
export type ResolvedTemplate = {
  id: string;
  name: string;
  compose: string;
  vars: TemplateVar[];
  expose: { service: string; port: number } | null;
  /** More compose services that get a generated domain. */
  domains: { service: string; port: number }[];
  custom: boolean;
  hostAccess: boolean;
};

export async function resolveTemplate(id: string, organizationId: string): Promise<ResolvedTemplate | null> {
  if (id.startsWith(CUSTOM_PREFIX)) {
    const [row] = await db
      .select()
      .from(schema.customTemplate)
      .where(and(eq(schema.customTemplate.id, id.slice(CUSTOM_PREFIX.length)), eq(schema.customTemplate.organizationId, organizationId)));
    if (!row) return null;
    return {
      id,
      name: row.name,
      compose: row.compose,
      vars: row.vars,
      expose: row.exposeService && row.exposePort ? { service: row.exposeService, port: row.exposePort } : null,
      domains: [],
      custom: true,
      hostAccess: false,
    };
  }
  const t = await getTemplate(id);
  return t ? { id: t.id, name: t.name, compose: t.compose, vars: t.vars, expose: t.expose, domains: t.domains ?? [], custom: false, hostAccess: !!t.hostAccess } : null;
}

/**
 * The stored value of a template variable. Public URL / host values are
 * references, so they follow the service's primary domain.
 */
export function templateVarValue(v: TemplateVar, hasDomain: boolean): string {
  if (v.publicUrl) return hasDomain ? "${{SERVE_PUBLIC_URL}}" : "http://localhost";
  if (v.publicHost) return hasDomain ? "${{SERVE_PUBLIC_DOMAIN}}" : "localhost";
  if (v.serviceUrl) return hasDomain ? `\${{SERVE_PUBLIC_URL_${composeVarSuffix(v.serviceUrl)}}}` : "http://localhost";
  if (v.serviceHost) return hasDomain ? `\${{SERVE_PUBLIC_DOMAIN_${composeVarSuffix(v.serviceHost)}}}` : "localhost";
  switch (v.generate) {
    case "password":
      return randomPassword(24);
    case "strongPassword":
      return strongPassword();
    case "secret":
      return randomSecret(32);
    case "hex32":
      // 32 random bytes as 64 hex characters (Rails SECRET_KEY_BASE and similar validate hex).
      return crypto.randomBytes(32).toString("hex");
    case "hex16":
      // 16 random bytes as exactly 32 hex characters, for apps that want a 32-character key.
      return crypto.randomBytes(16).toString("hex");
    case "base64key":
      return `base64:${crypto.randomBytes(32).toString("base64")}`;
    default:
      return v.value ?? "";
  }
}

/**
 * For apps that refuse a password without upper and lower case, a digit and a symbol (OpenObserve).
 * The symbol is a dash: safe in URLs, shells and connection strings.
 */
export function strongPassword() {
  const pick = (chars: string) => chars[crypto.randomInt(chars.length)];
  return `${randomPassword(20)}-${pick("ABCDEFGHJKLMNPQRSTUVWXYZ")}${pick("abcdefghijkmnopqrstuvwxyz")}${pick("23456789")}`;
}
