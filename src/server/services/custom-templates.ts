import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getTemplate, type TemplateVar } from "@/server/services/templates";
import { generatedValue } from "@/server/services/generated-values";
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
  return t
    ? {
        id: t.id,
        name: t.name,
        compose: t.compose,
        vars: t.vars,
        expose: t.noDomain ? null : t.expose,
        domains: t.noDomain ? [] : (t.domains ?? []),
        custom: false,
        hostAccess: !!t.hostAccess,
      }
    : null;
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
  return v.generate ? generatedValue(v.generate) : (v.value ?? "");
}

export { strongPassword } from "@/server/services/generated-values";
