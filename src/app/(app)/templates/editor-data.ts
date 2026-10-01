import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getTemplate, templateCategories } from "@/server/services/templates";
import { serviceInOrg } from "@/server/services/access";
import { composeServicePorts } from "@/server/deploy/compose";
import { composeVariables, guessVarKind } from "@/lib/compose-vars";
import type { EditorInitial, TemplateVarDef } from "./template-editor";

const blank: EditorInitial = {
  id: null,
  name: "",
  description: "",
  category: "Custom",
  iconUrl: "",
  compose: "",
  vars: [],
  exposeService: null,
  exposePort: null,
};

function detectVars(compose: string): TemplateVarDef[] {
  return composeVariables(compose)
    .filter((v) => !v.hasDefault)
    .map((v) => {
      const kind = guessVarKind(v.name);
      return kind === "publicUrl" ? { key: v.name, publicUrl: true } : kind === "value" ? { key: v.name, value: "" } : { key: v.name, generate: kind };
    });
}

/** Initial editor state for a new template: blank, a built-in copy or an existing compose service. */
export async function newTemplateInitial(orgId: string, from?: string, serviceId?: string): Promise<EditorInitial> {
  const builtIn = from ? await getTemplate(from) : null;
  if (builtIn) {
    return {
      ...blank,
      name: `${builtIn.name} (copy)`,
      description: builtIn.description,
      category: builtIn.category,
      compose: builtIn.compose,
      vars: builtIn.vars,
      exposeService: builtIn.expose.service,
      exposePort: builtIn.expose.port,
    };
  }
  if (serviceId) {
    const { service } = await serviceInOrg(serviceId, orgId).catch(() => ({ service: null }));
    const content = service?.compose?.mode === "inline" ? service.compose.content : "";
    if (service && content) {
      const [domain] = await db
        .select({ port: schema.domain.port, composeService: schema.domain.composeService })
        .from(schema.domain)
        .where(eq(schema.domain.serviceId, service.id))
        .limit(1);
      const ports = composeServicePorts(content);
      const exposeService = domain?.composeService ?? Object.keys(ports)[0] ?? null;
      return {
        ...blank,
        name: service.name,
        compose: content,
        vars: detectVars(content),
        exposeService,
        exposePort: domain?.port ?? (exposeService ? (ports[exposeService]?.[0] ?? null) : null),
      };
    }
  }
  return blank;
}

export async function existingTemplateInitial(orgId: string, id: string): Promise<EditorInitial | null> {
  const [row] = await db
    .select()
    .from(schema.customTemplate)
    .where(and(eq(schema.customTemplate.id, id), eq(schema.customTemplate.organizationId, orgId)));
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    iconUrl: row.iconUrl ?? "",
    compose: row.compose,
    vars: row.vars,
    exposeService: row.exposeService,
    exposePort: row.exposePort,
  };
}

export const editorCategories = [...templateCategories];
