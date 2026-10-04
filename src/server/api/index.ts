import { z } from "zod";
import { PERMISSION_INFO, PERMISSIONS } from "@/lib/permissions";
import { currentVersion } from "@/server/instance/version";
import { consoleRoutes } from "./routes/console";
import { databaseRoutes } from "./routes/databases";
import { infraRoutes } from "./routes/infra";
import { logDrainRoutes } from "./routes/log-drains";
import { metricsRoutes } from "./routes/metrics";
import { networkingRoutes } from "./routes/networking";
import { orgRoutes } from "./routes/org";
import { projectRoutes } from "./routes/projects";
import { serviceRoutes } from "./routes/services";
import { type ApiRoute, createRouter, needLabel } from "./router";

export const apiRoutes: ApiRoute[] = [
  ...orgRoutes,
  ...projectRoutes,
  ...serviceRoutes,
  ...consoleRoutes,
  ...databaseRoutes,
  ...infraRoutes,
  ...networkingRoutes,
  ...logDrainRoutes,
  ...metricsRoutes,
];

const TAGS = [
  ["Token", "The token itself: who it acts as and what it may do."],
  ["Organization", "The organization and its activity log."],
  ["Members", "Members, invitations and roles."],
  ["Projects", "Projects group services."],
  ["Environments", "Each project has environments (production, staging, ...) with their own services."],
  ["Services", "Apps, databases and compose stacks."],
  ["Deployments", "Builds and rollouts."],
  ["Variables", "Environment variables of services, and shared variables."],
  ["Domains", "Domains of services."],
  ["Databases", "Connection details, settings, domains and branches of databases."],
  ["Backups", "Database and stack backups."],
  ["Tasks", "Scheduled commands."],
  ["Logs", "Container logs."],
  ["Console", "Commands and shells in containers and on servers."],
  ["Monitoring", "Uptime checks."],
  ["Metrics", "Resource, request and deployment metrics in the Prometheus text format."],
  ["Servers", "Servers, their proxy, SSH keys and private networks."],
  ["Tailscale", "Servers in a Tailscale tailnet (Root admins)."],
  ["Certificates", "TLS certificates."],
  ["Integrations", "Registries, S3, notifications, log drains, secret managers, Cloudflare and Git."],
  ["Templates", "One-click templates."],
  ["Instance", "Updates and backups of this Serve instance (Root admins)."],
] as const;

function jsonSchema(schema: z.ZodType) {
  try {
    return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  } catch {
    return { type: "object" };
  }
}

/** The OpenAPI 3.1 description of the API, built from the route table. */
export function openApiDocument(baseUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of apiRoutes) {
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    const query: unknown[] = [];
    if (r.query) {
      const js = jsonSchema(r.query) as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, schema] of Object.entries(js.properties ?? {})) query.push({ name, in: "query", required: js.required?.includes(name) ?? false, schema });
    }
    const needs = r.needs.length ? `\n\nNeeds: ${r.needs.map(needLabel).join(", ")}.` : "";
    paths[r.path] ??= {};
    paths[r.path][r.method.toLowerCase()] = {
      tags: [r.tag],
      summary: r.summary,
      description: `${r.description ?? ""}${needs}`.trim(),
      operationId: `${r.method.toLowerCase()}${r.path.replace(/\{(\w+)\}/g, "By_$1").replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))}`,
      "x-permissions": r.needs,
      parameters: [...params, ...query],
      ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(r.body) } } } } : {}),
      responses: {
        [String(r.status ?? 200)]: {
          description: "Success",
          content: r.produces ? { [r.produces]: { schema: { type: "string" } } } : { "application/json": { schema: { type: "object" } } },
        },
        "400": { $ref: "#/components/responses/Error" },
        "401": { $ref: "#/components/responses/Error" },
        "403": { $ref: "#/components/responses/Error" },
        "404": { $ref: "#/components/responses/Error" },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Serve API",
      version: currentVersion(),
      description: [
        "Everything the dashboard does, over HTTP. Send a token made in Keys & tokens as `Authorization: Bearer srv_...`.",
        "",
        "A token carries permissions, and never does more than its owner's role allows right now. Each operation lists the permissions it needs; a missing one answers 403 with `missing`.",
        "",
        'Errors are JSON: `{"error": "..."}` with a 4xx or 5xx status.',
      ].join("\n"),
    },
    servers: [{ url: `${baseUrl.replace(/\/$/, "")}/api/v1` }],
    security: [{ token: [] }],
    tags: TAGS.map(([name, description]) => ({ name, description })),
    paths,
    components: {
      securitySchemes: { token: { type: "http", scheme: "bearer", description: "An API token (srv_...)." } },
      responses: {
        Error: {
          description: "An error",
          content: {
            "application/json": {
              schema: { type: "object", properties: { error: { type: "string" }, missing: { type: "array", items: { type: "string" } } }, required: ["error"] },
            },
          },
        },
      },
      "x-permissions": [...PERMISSIONS.map((p) => ({ id: p, ...PERMISSION_INFO[p] })), { id: "admin", label: "Admin", description: "Everything an organization admin may do." }],
    },
  };
}

async function baseUrlOf(request: Request) {
  const { publicBaseUrl } = await import("@/server/git/github-app");
  return (await publicBaseUrl().catch(() => "")) || new URL(request.url).origin;
}

export const handleApi = createRouter(apiRoutes, {
  "/openapi.json": async (request) => Response.json(openApiDocument(await baseUrlOf(request)), { headers: { "access-control-allow-origin": "*" } }),
  "/": async (request) =>
    Response.json({
      name: "Serve API",
      version: currentVersion(),
      openapi: `${await baseUrlOf(request)}/api/v1/openapi.json`,
      auth: "Authorization: Bearer srv_... (Keys & tokens in the dashboard)",
    }),
});
