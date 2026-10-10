import { z } from "zod";
import * as drains from "@/server/actions/log-drains";
import { ApiError, type ApiRoute, route, unwrap } from "../router";

/*
 * Log drains: where the containers' logs are sent. Secrets (header values, passwords) are
 * written, never shown: the list names which are set.
 */

const kind = z.enum(["http", "loki", "elasticsearch", "splunk", "syslog"]);

const fields = {
  headerName: z.string().optional(),
  headerValue: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  projectIds: z.array(z.string()).optional(),
  serviceIds: z.array(z.string()).optional(),
  index: z.string().optional(),
  sourcetype: z.string().optional(),
  insecure: z.boolean().optional(),
};

const FIELDS_HELP =
  "kind: http (headerName and headerValue), loki or elasticsearch (username, password), splunk (password: the HEC token; index, sourcetype) or syslog (tcp://, tls:// or udp:// with a port). projectIds and serviceIds pick whose logs are sent; neither sends nothing. insecure accepts a self-signed certificate.";

async function listDrains(organizationId: string) {
  const { logDrainsProps } = await import("@/server/log-drains/view");
  return (await logDrainsProps(organizationId, true)).drains;
}

export const logDrainRoutes: ApiRoute[] = [
  route({
    method: "GET",
    path: "/log-drains",
    tag: "Integrations",
    summary: "List log drains",
    description: "Header values and passwords are not shown: headerName, username and hasSecret say what is set.",
    needs: ["integrations.manage"],
    handler: async ({ auth }) => {
      // Drains cover every project (their URLs can hold keys): not for tokens limited to some projects.
      if (auth.projectIds) throw new ApiError(403, "Log drains cover every project: this token is limited to some projects.");
      return { drains: await listDrains(auth.organizationId) };
    },
  }),
  route({
    method: "POST",
    path: "/log-drains",
    tag: "Integrations",
    summary: "Add a log drain",
    description: FIELDS_HELP,
    needs: ["integrations.manage"],
    body: z.object({ name: z.string(), kind, url: z.string(), ...fields }),
    status: 201,
    handler: async ({ body }) =>
      unwrap(
        drains.addLogDrain({
          name: body.name,
          kind: body.kind,
          url: body.url,
          headerName: body.headerName ?? "",
          headerValue: body.headerValue ?? "",
          username: body.username ?? "",
          password: body.password ?? "",
          projectIds: body.projectIds ?? [],
          serviceIds: body.serviceIds ?? [],
          index: body.index ?? "",
          sourcetype: body.sourcetype ?? "",
          insecure: body.insecure ?? false,
        }),
      ),
  }),
  route({
    method: "PUT",
    path: "/log-drains/{drainId}",
    tag: "Integrations",
    summary: "Change a log drain",
    description: `Fields left out keep their value; an empty or left out headerValue or password keeps the stored one (as long as the URL stays the same). enabled turns it off or on. ${FIELDS_HELP}`,
    needs: ["integrations.manage"],
    body: z.object({ name: z.string().optional(), kind: kind.optional(), url: z.string().optional(), enabled: z.boolean().optional(), ...fields }),
    handler: async ({ auth, params, body }) => {
      const current = (await listDrains(auth.organizationId)).find((d) => d.id === params.drainId);
      if (!current) throw new ApiError(404, "Log drain not found");
      const { enabled, ...rest } = body;
      if (Object.values(rest).some((v) => v !== undefined))
        await unwrap(
          drains.updateLogDrain(params.drainId, {
            name: body.name ?? current.name,
            kind: body.kind ?? current.kind,
            url: body.url ?? current.url,
            headerName: body.headerName ?? current.headerName ?? "",
            headerValue: body.headerValue ?? "",
            username: body.username ?? current.username ?? "",
            password: body.password ?? "",
            projectIds: body.projectIds ?? current.projectIds ?? [],
            serviceIds: body.serviceIds ?? current.serviceIds ?? [],
            index: body.index ?? current.index ?? "",
            sourcetype: body.sourcetype ?? current.sourcetype ?? "",
            insecure: body.insecure ?? current.insecure,
          }),
        );
      if (enabled !== undefined && enabled !== current.enabled) await unwrap(drains.setLogDrainEnabled(params.drainId, enabled));
      return { drain: (await listDrains(auth.organizationId)).find((d) => d.id === params.drainId) ?? null };
    },
  }),
  route({
    method: "POST",
    path: "/log-drains/{drainId}/test",
    tag: "Integrations",
    summary: "Send a test line to a log drain",
    description: "One sample line, sent the way the log collector sends them. An error says what the destination answered.",
    needs: ["integrations.manage"],
    handler: async ({ params }) => (await unwrap(drains.testLogDrain(params.drainId))) ?? { ok: true },
  }),
  route({
    method: "DELETE",
    path: "/log-drains/{drainId}",
    tag: "Integrations",
    summary: "Delete a log drain",
    needs: ["integrations.manage"],
    handler: async ({ params }) => (await unwrap(drains.deleteLogDrain(params.drainId))) ?? { ok: true },
  }),
];
