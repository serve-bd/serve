import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import * as servers from "@/server/actions/servers";
import * as serverProxy from "@/server/actions/server-proxy";
import { deleteProxyFile, saveProxyFile, setProxyKind } from "@/server/actions/proxy-kind";
import { runCleanup } from "@/server/actions/server";
import { saveServerAlerts } from "@/server/actions/monitoring";
import * as certificates from "@/server/actions/certificates";
import * as registries from "@/server/actions/registries";
import * as integrations from "@/server/actions/integrations";
import * as notifications from "@/server/actions/notifications";
import * as secretProviders from "@/server/actions/secret-providers";
import * as templates from "@/server/actions/templates";
import * as instance from "@/server/actions/instance";
import { getTemplates } from "@/server/services/templates";
import { getSettings } from "@/server/settings";
import { defaultChannelEvents } from "@/lib/notifications";
import { channelConfig } from "@/server/notifications/deliver";
import { currentVersion } from "@/server/instance/version";
import { iso, loadServer, orgServers, serverView } from "../data";
import { ApiError, type ApiRoute, route, unwrap } from "../router";

const loose = z.looseObject({});

async function cloudflareAccountOf(organizationId: string, accountId: string) {
  const [row] = await db
    .select({ id: schema.cloudflareAccount.id })
    .from(schema.cloudflareAccount)
    .where(and(eq(schema.cloudflareAccount.id, accountId), eq(schema.cloudflareAccount.organizationId, organizationId)));
  if (!row) throw new ApiError(404, "Cloudflare account not found");
  return row;
}

export const infraRoutes: ApiRoute[] = [
  // Servers
  route({
    method: "GET",
    path: "/servers",
    tag: "Servers",
    summary: "List servers",
    description: "Servers this organization deploys to: its own and shared ones.",
    needs: ["projects.view"],
    handler: async ({ auth }) => ({ servers: (await orgServers(auth.organizationId)).map(serverView) }),
  }),
  route({
    method: "GET",
    path: "/servers/{serverId}",
    tag: "Servers",
    summary: "Get a server",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      const server = await loadServer(auth, params.serverId);
      const services = await db
        .select({ id: schema.service.id, name: schema.service.name, type: schema.service.type, status: schema.service.status, projectId: schema.service.projectId })
        .from(schema.service)
        .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
        .where(and(eq(schema.service.serverId, server.id), eq(schema.project.organizationId, auth.organizationId)));
      // What the server's admin pages show (setup log, alert thresholds, a proxy switch): only for those who manage it, as
      // in the dashboard. A server shared from another organization stays read-only.
      let admin = {};
      const { requireOrg } = await import("@/server/auth");
      const { canManageServer } = await import("@/server/servers/access");
      if (auth.admin && canManageServer(await requireOrg(), server)) {
        const { alertsFor } = await import("@/server/monitoring/config");
        admin = { setupLog: server.setupLog, alerts: await alertsFor(server.id), proxySwitch: server.proxySwitch ?? null };
      }
      return { server: { ...serverView(server), ...admin, services: services.filter((s) => auth.canAccessProject(s.projectId)) } };
    },
  }),
  route({
    method: "POST",
    path: "/servers",
    tag: "Servers",
    summary: "Add a server over SSH",
    description: "Add an SSH key first (POST /ssh-keys) and put its public key on the server. Then validate the server to set it up.",
    needs: ["admin"],
    body: z.object({
      name: z.string(),
      description: z.string().nullable().optional(),
      host: z.string(),
      port: z.number().int().default(22),
      username: z.string().default("root"),
      privateKeyId: z.string(),
      dataDir: z.string().optional(),
    }),
    status: 201,
    handler: async ({ body }) => unwrap(servers.createServer(body)),
  }),
  route({
    method: "PATCH",
    path: "/servers/{serverId}",
    tag: "Servers",
    summary: "Change a server",
    description:
      "name, description, host, port, username, privateKeyId, publicIp, wildcardDomain, buildConcurrency, imageRetention, metricsEnabled, metricsRetentionHours, proxy ports, ...",
    needs: ["admin"],
    body: loose,
    handler: async ({ params, body }) => (await unwrap(servers.updateServer(params.serverId, body as never))) ?? { ok: true },
  }),
  route({
    method: "DELETE",
    path: "/servers/{serverId}",
    tag: "Servers",
    summary: "Remove a server",
    description:
      "A server with services needs services: stop (they are stopped and deleted; removeData=true also deletes their volumes) or keep (they keep running there and are only forgotten; Serve's proxy and the server's tunnels are removed unless removeProxy=false or removeTunnels=false). removeTailnetDevice=true also takes the machine out of its tailnet.",
    needs: ["admin"],
    query: z.object({
      services: z.enum(["stop", "keep"]).optional(),
      removeData: z.enum(["true", "false"]).optional(),
      removeProxy: z.enum(["true", "false"]).optional(),
      removeTunnels: z.enum(["true", "false"]).optional(),
      removeTailnetDevice: z.enum(["true", "false"]).optional(),
    }),
    handler: async ({ params, query }) => {
      const flag = (v: "true" | "false" | undefined) => (v === undefined ? undefined : v === "true");
      return (
        (await unwrap(
          servers.deleteServer(params.serverId, {
            services: query.services,
            removeData: flag(query.removeData),
            removeProxy: flag(query.removeProxy),
            removeTunnels: flag(query.removeTunnels),
            removeTailnetDevice: flag(query.removeTailnetDevice),
          }),
        )) ?? { ok: true }
      );
    },
  }),
  route({
    method: "POST",
    path: "/servers/{serverId}/validate",
    tag: "Servers",
    summary: "Check and set up a server",
    description: "Connects, checks Docker (installDocker: true installs it) and sets the server up.",
    needs: ["admin"],
    body: z.object({ installDocker: z.boolean().optional() }),
    status: 202,
    handler: async ({ params, body }) => (await unwrap(servers.validateServer(params.serverId, body))) ?? { ok: true },
  }),
  route({
    method: "POST",
    path: "/servers/{serverId}/reset-host-key",
    tag: "Servers",
    summary: "Forget a server's SSH host key",
    description: "After the server was reinstalled. The next setup saves the new key.",
    needs: ["admin"],
    handler: async ({ params }) => (await unwrap(servers.resetHostKey(params.serverId))) ?? { ok: true },
  }),
  route({
    method: "POST",
    path: "/servers/{serverId}/cleanup",
    tag: "Servers",
    summary: "Clean up Docker on a server",
    description: "Removes unused images, build cache and stopped containers Serve no longer needs.",
    needs: ["admin"],
    status: 202,
    handler: async ({ params }) => (await unwrap(runCleanup(params.serverId))) ?? { ok: true },
  }),
  route({
    method: "GET",
    path: "/servers/{serverId}/os-updates",
    tag: "Servers",
    summary: "Operating system updates of a server",
    description:
      "The packages that can be updated as of the last check, and the last install with its log (run.state running while it installs). For admins who manage the server.",
    needs: ["admin"],
    handler: async ({ params }) => {
      const { requireServerAdmin } = await import("@/server/servers/access");
      const { row } = await requireServerAdmin(params.serverId);
      return { osUpdates: row.osUpdates ?? null };
    },
  }),
  route({
    method: "POST",
    path: "/servers/{serverId}/os-updates/check",
    tag: "Servers",
    summary: "Check a server for operating system updates",
    description: "Runs in the background and installs nothing: GET /servers/{serverId}/os-updates shows the result.",
    needs: ["admin"],
    status: 202,
    handler: async ({ params }) => (await unwrap(servers.checkOsUpdatesAction(params.serverId))) ?? { ok: true },
  }),
  route({
    method: "POST",
    path: "/servers/{serverId}/os-updates/install",
    tag: "Servers",
    summary: "Install operating system updates on a server",
    description:
      'packages: "all" (everything but Docker\'s packages) or the names of packages to update. Runs in the background: follow it with GET /servers/{serverId}/os-updates.',
    needs: ["admin"],
    status: 202,
    body: z.object({ packages: z.union([z.literal("all"), z.array(z.string().max(128)).min(1).max(2000)]) }),
    handler: async ({ params, body }) => (await unwrap(servers.installOsUpdatesAction(params.serverId, body.packages))) ?? { ok: true },
  }),
  route({
    method: "POST",
    path: "/servers/{serverId}/default",
    tag: "Servers",
    summary: "Make a server the organization's default",
    description: "New services go to it unless another server is chosen. It must be ready.",
    needs: ["admin"],
    handler: async ({ params }) => (await unwrap(servers.makeDefaultServer(params.serverId))) ?? { ok: true },
  }),
  route({
    method: "GET",
    path: "/proxy/custom-config",
    tag: "Servers",
    summary: "Custom nginx configuration of the instance's proxies",
    needs: ["instance"],
    handler: async () => ({ config: (await getSettings()).proxyCustomConfig ?? "" }),
  }),
  route({
    method: "PUT",
    path: "/proxy/custom-config",
    tag: "Servers",
    summary: "Set the custom nginx configuration of the instance's proxies",
    description:
      "Directives added to the http block of every nginx proxy on the instance's own servers (not those an organization owns). nginx tests it first; a refused configuration changes nothing. Empty removes it.",
    needs: ["instance"],
    body: z.object({ config: z.string().max(20_000) }),
    handler: async ({ body }) => (await unwrap(serverProxy.saveProxyCustomConfig(body.config))) ?? { ok: true },
  }),
  route({
    method: "PUT",
    path: "/servers/{serverId}/alerts",
    tag: "Servers",
    summary: "Set a server's resource alerts",
    needs: ["admin"],
    body: loose,
    handler: async ({ params, body }) => (await unwrap(saveServerAlerts(params.serverId, body as never))) ?? { ok: true },
  }),
  route({
    method: "PUT",
    path: "/servers/{serverId}/proxy/kind",
    tag: "Servers",
    summary: "Switch the proxy (nginx, caddy or traefik)",
    needs: ["admin"],
    body: z.object({ kind: z.enum(["nginx", "caddy", "traefik"]) }),
    status: 202,
    handler: async ({ params, body }) => (await unwrap(setProxyKind(params.serverId, body.kind))) ?? { ok: true },
  }),
  route({
    method: "PUT",
    path: "/servers/{serverId}/proxy/trusted-proxies",
    tag: "Servers",
    summary: "Set which proxies in front are trusted for the visitor IP",
    description:
      'ranges: IP ranges. header: "x-forwarded-for", "x-real-ip", "cf-connecting-ip" or "proxy-protocol". cloudflare: trust Cloudflare. machine: trust a proxy on the same machine. null turns it off.',
    needs: ["admin"],
    body: z.object({ ranges: z.array(z.string()), header: z.string(), cloudflare: z.boolean(), machine: z.boolean().optional() }).nullable(),
    handler: async ({ params, body }) => (await unwrap(serverProxy.saveTrustedProxies(params.serverId, body))) ?? { ok: true },
  }),
  ...(
    [
      ["reload", serverProxy.reloadProxyNow, "Reload the proxy configuration"],
      ["restart", serverProxy.restartProxyNow, "Restart the proxy"],
      ["rebuild", serverProxy.rebuildProxyNow, "Recreate the proxy container"],
      ["stop", serverProxy.stopProxyNow, "Stop the proxy"],
      ["start", serverProxy.startProxyNow, "Start the proxy"],
      ["test", serverProxy.testProxy, "Test the proxy configuration"],
    ] as const
  ).map(([name, fn, summary]) =>
    route({
      method: "POST",
      path: `/servers/{serverId}/proxy/${name}`,
      tag: "Servers",
      summary,
      needs: ["admin"],
      handler: async ({ params }) => (await unwrap((fn as (id: string) => ReturnType<typeof serverProxy.testProxy>)(params.serverId))) ?? { ok: true },
    }),
  ),
  route({
    method: "GET",
    path: "/servers/{serverId}/proxy/files",
    tag: "Servers",
    summary: "List the custom proxy configuration files",
    description: "The files of the server's current proxy (nginx .conf, Caddy .caddy, Traefik .yaml).",
    needs: ["admin"],
    handler: async ({ auth, params }) => {
      await loadServer(auth, params.serverId);
      const { proxyStateOf } = await import("@/server/proxy/nginx");
      const { kind, config } = await proxyStateOf(params.serverId);
      return { kind, files: kind === "none" ? [] : (config[kind]?.files ?? []) };
    },
  }),
  route({
    method: "PUT",
    path: "/servers/{serverId}/proxy/files/{name}",
    tag: "Servers",
    summary: "Add or replace a custom proxy configuration file",
    description:
      "The file is checked by the proxy and applied; a rejected file is rolled back. In nginx files, 127.0.0.1:PORT and localhost:PORT reach this machine's own ports (also ones open on 127.0.0.1 only).",
    needs: ["admin"],
    body: z.object({ content: z.string() }),
    handler: async ({ auth, params, body }) => {
      await loadServer(auth, params.serverId);
      const { proxyStateOf } = await import("@/server/proxy/nginx");
      const { kind, config } = await proxyStateOf(params.serverId);
      if (kind === "none") throw new ApiError(409, "This server has no Serve proxy.");
      const exists = (config[kind]?.files ?? []).some((f) => f.name === params.name);
      return (await unwrap(saveProxyFile(params.serverId, kind, { originalName: exists ? params.name : null, name: params.name, content: body.content }))) ?? { ok: true };
    },
  }),
  route({
    method: "DELETE",
    path: "/servers/{serverId}/proxy/files/{name}",
    tag: "Servers",
    summary: "Delete a custom proxy configuration file",
    needs: ["admin"],
    handler: async ({ auth, params }) => {
      await loadServer(auth, params.serverId);
      const { proxyStateOf } = await import("@/server/proxy/nginx");
      const { kind } = await proxyStateOf(params.serverId);
      if (kind === "none") throw new ApiError(409, "This server has no Serve proxy.");
      return (await unwrap(deleteProxyFile(params.serverId, kind, params.name))) ?? { ok: true };
    },
  }),
  route({
    method: "GET",
    path: "/servers/{serverId}/proxy/logs",
    tag: "Servers",
    summary: "Recent proxy logs",
    needs: ["admin"],
    handler: async ({ params }) => ({ logs: await unwrap(serverProxy.getProxyLogs(params.serverId)) }),
  }),

  // SSH keys
  route({
    method: "GET",
    path: "/ssh-keys",
    tag: "Servers",
    summary: "List SSH keys",
    description: "Public keys only.",
    needs: ["admin"],
    handler: async ({ auth }) => {
      const { getSetting } = await import("@/server/settings");
      const root = auth.organizationId === (await getSetting("rootOrganizationId"));
      const rows = await db
        .select()
        .from(schema.privateKey)
        .where(
          root
            ? or(eq(schema.privateKey.organizationId, auth.organizationId), isNull(schema.privateKey.organizationId))
            : eq(schema.privateKey.organizationId, auth.organizationId),
        )
        .orderBy(asc(schema.privateKey.name));
      return { keys: rows.map((k) => ({ id: k.id, name: k.name, description: k.description, publicKey: k.publicKey, fingerprint: k.fingerprint, createdAt: iso(k.createdAt) })) };
    },
  }),
  route({
    method: "POST",
    path: "/ssh-keys",
    tag: "Servers",
    summary: "Add an SSH key",
    description: "Leave privateKey out to generate a new ed25519 key. The answer has the public key to put on the server.",
    needs: ["admin"],
    body: z.object({ name: z.string(), description: z.string().optional(), privateKey: z.string().optional() }),
    status: 201,
    handler: async ({ body }) => unwrap(servers.createPrivateKey(body)),
  }),
  route({
    method: "DELETE",
    path: "/ssh-keys/{keyId}",
    tag: "Servers",
    summary: "Delete an SSH key",
    needs: ["admin"],
    handler: async ({ params }) => (await unwrap(servers.deletePrivateKey(params.keyId))) ?? { ok: true },
  }),

  // Certificates
  route({
    method: "GET",
    path: "/certificates",
    tag: "Certificates",
    summary: "List certificates",
    needs: ["projects.view"],
    handler: async ({ auth }) => {
      const rows = await db.select().from(schema.certificate).where(eq(schema.certificate.organizationId, auth.organizationId)).orderBy(asc(schema.certificate.name));
      return {
        certificates: rows.map((c) => ({
          id: c.id,
          name: c.name,
          domains: c.domains,
          serverId: c.serverId,
          provider: c.provider,
          status: c.status,
          issuer: c.issuer,
          expiresAt: iso(c.expiresAt),
          autoRenew: c.autoRenew,
          lastError: c.lastError,
          createdAt: iso(c.createdAt),
        })),
      };
    },
  }),
  route({
    method: "POST",
    path: "/certificates",
    tag: "Certificates",
    summary: "Request a certificate",
    description: 'provider "letsencrypt-http", "letsencrypt-cloudflare" (wildcards; needs cloudflareAccountId) or "cloudflare-origin".',
    needs: ["integrations.manage"],
    body: z.object({
      provider: z.enum(["letsencrypt-http", "letsencrypt-cloudflare", "cloudflare-origin"]),
      domains: z.array(z.string()).min(1),
      cloudflareAccountId: z.string().nullable().optional(),
      name: z.string().optional(),
      serverId: z.string().optional(),
    }),
    status: 202,
    handler: async ({ body }) => (await unwrap(certificates.requestCertificate(body))) ?? { ok: true },
  }),
  route({
    method: "POST",
    path: "/certificates/upload",
    tag: "Certificates",
    summary: "Upload a certificate",
    description: "PEM certificate (with its chain) and private key.",
    needs: ["integrations.manage"],
    body: z.object({ name: z.string(), certificate: z.string(), privateKey: z.string(), serverId: z.string().optional() }),
    status: 201,
    handler: async ({ body }) => (await unwrap(certificates.uploadCertificate(body))) ?? { ok: true },
  }),
  route({
    method: "POST",
    path: "/certificates/{certificateId}/renew",
    tag: "Certificates",
    summary: "Renew a certificate now",
    needs: ["integrations.manage"],
    status: 202,
    handler: async ({ params }) => (await unwrap(certificates.renewCertificate(params.certificateId))) ?? { ok: true },
  }),
  route({
    method: "PATCH",
    path: "/certificates/{certificateId}",
    tag: "Certificates",
    summary: "Turn automatic renewal on or off",
    needs: ["integrations.manage"],
    body: z.object({ autoRenew: z.boolean() }),
    handler: async ({ params, body }) => (await unwrap(certificates.setCertificateAutoRenew(params.certificateId, body.autoRenew))) ?? { ok: true },
  }),
  route({
    method: "GET",
    path: "/certificates/{certificateId}/logs",
    tag: "Certificates",
    summary: "Logs of the last issue or renewal",
    needs: ["integrations.manage"],
    handler: async ({ params }) => ({ logs: await unwrap(certificates.certificateLogs(params.certificateId)) }),
  }),
  route({
    method: "DELETE",
    path: "/certificates/{certificateId}",
    tag: "Certificates",
    summary: "Delete a certificate",
    needs: ["integrations.manage"],
    handler: async ({ params }) => (await unwrap(certificates.deleteCertificate(params.certificateId))) ?? { ok: true },
  }),

  // Registries
  route({
    method: "GET",
    path: "/registries",
    tag: "Integrations",
    summary: "List container registries",
    needs: ["projects.view"],
    handler: async ({ auth }) => {
      const rows = await db
        .select()
        .from(schema.containerRegistry)
        .where(eq(schema.containerRegistry.organizationId, auth.organizationId))
        .orderBy(asc(schema.containerRegistry.name));
      return { registries: rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, host: r.host, username: r.username, namespace: r.namespace, createdAt: iso(r.createdAt) })) };
    },
  }),
  route({
    method: "POST",
    path: "/registries",
    tag: "Integrations",
    summary: "Add a container registry",
    needs: ["integrations.manage"],
    body: z.object({ kind: z.string(), name: z.string(), host: z.string().optional(), username: z.string(), password: z.string(), namespace: z.string().optional() }),
    status: 201,
    handler: async ({ body }) => (await unwrap(registries.addRegistry(body as never))) ?? { ok: true },
  }),
  route({
    method: "PUT",
    path: "/registries/{registryId}",
    tag: "Integrations",
    summary: "Change a container registry",
    description: "An empty password keeps the stored one.",
    needs: ["integrations.manage"],
    body: z.object({ kind: z.string(), name: z.string(), host: z.string().optional(), username: z.string(), password: z.string().optional(), namespace: z.string().optional() }),
    handler: async ({ params, body }) => (await unwrap(registries.updateRegistry(params.registryId, body as never))) ?? { ok: true },
  }),
  route({
    method: "POST",
    path: "/registries/{registryId}/test",
    tag: "Integrations",
    summary: "Test a registry login",
    needs: ["integrations.manage"],
    handler: async ({ params }) => (await unwrap(registries.testRegistry(params.registryId))) ?? { ok: true },
  }),
  route({
    method: "DELETE",
    path: "/registries/{registryId}",
    tag: "Integrations",
    summary: "Delete a container registry",
    needs: ["integrations.manage"],
    handler: async ({ params }) => (await unwrap(registries.deleteRegistry(params.registryId))) ?? { ok: true },
  }),

  // S3 storage
  route({
    method: "GET",
    path: "/s3-destinations",
    tag: "Integrations",
    summary: "List S3 storage destinations",
    needs: ["projects.view"],
    handler: async ({ auth }) => {
      const rows = await db.select().from(schema.s3Destination).where(eq(schema.s3Destination.organizationId, auth.organizationId)).orderBy(asc(schema.s3Destination.name));
      return {
        destinations: rows.map((d) => ({
          id: d.id,
          name: d.name,
          endpoint: d.endpoint,
          region: d.region,
          bucket: d.bucket,
          pathPrefix: d.pathPrefix,
          createdAt: iso(d.createdAt),
        })),
      };
    },
  }),
  route({
    method: "POST",
    path: "/s3-destinations",
    tag: "Integrations",
    summary: "Add an S3 storage destination",
    needs: ["integrations.manage"],
    body: z.object({
      name: z.string(),
      endpoint: z.string(),
      region: z.string().optional(),
      bucket: z.string(),
      accessKeyId: z.string(),
      secretAccessKey: z.string(),
      pathPrefix: z.string().optional(),
    }),
    status: 201,
    handler: async ({ body }) => (await unwrap(integrations.addS3Destination(body as never))) ?? { ok: true },
  }),
  route({
    method: "PUT",
    path: "/s3-destinations/{destinationId}",
    tag: "Integrations",
    summary: "Change an S3 storage destination",
    description: "Leave accessKeyId and secretAccessKey out to keep the stored ones.",
    needs: ["integrations.manage"],
    body: z.looseObject({ name: z.string(), endpoint: z.string(), bucket: z.string() }),
    handler: async ({ params, body }) => (await unwrap(integrations.updateS3Destination(params.destinationId, body as never))) ?? { ok: true },
  }),
  route({
    method: "POST",
    path: "/s3-destinations/{destinationId}/test",
    tag: "Integrations",
    summary: "Test an S3 storage destination",
    needs: ["integrations.manage"],
    handler: async ({ params }) => (await unwrap(integrations.testS3Destination(params.destinationId))) ?? { ok: true },
  }),
  route({
    method: "DELETE",
    path: "/s3-destinations/{destinationId}",
    tag: "Integrations",
    summary: "Delete an S3 storage destination",
    needs: ["integrations.manage"],
    handler: async ({ params }) => (await unwrap(integrations.deleteS3Destination(params.destinationId))) ?? { ok: true },
  }),

  // Notifications
  route({
    method: "GET",
    path: "/notification-channels",
    tag: "Integrations",
    summary: "List notification channels",
    description: "Their settings (webhook URLs, tokens) are not shown.",
    needs: ["integrations.manage"],
    handler: async ({ auth }) => {
      const rows = await db
        .select()
        .from(schema.notificationChannel)
        .where(eq(schema.notificationChannel.organizationId, auth.organizationId))
        .orderBy(asc(schema.notificationChannel.name));
      return {
        channels: rows.map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          events: c.events,
          enabled: c.enabled,
          scope: c.scope,
          minSeverity: c.minSeverity,
          lastDeliveryAt: iso(c.lastDeliveryAt),
          lastDeliveryStatus: c.lastDeliveryStatus,
          lastDeliveryError: c.lastDeliveryError,
        })),
      };
    },
  }),
  route({
    method: "GET",
    path: "/notification-channels/types",
    tag: "Integrations",
    summary: "Kinds of notification channels, their fields and the events",
    description:
      "kinds: each kind with the config fields POST /notification-channels takes (secret ones are stored encrypted and never shown again). events: the event ids a channel can get, with their group and severity; defaultEvents are the ones a new channel gets. placeholders: what custom message text can use.",
    needs: ["integrations.manage"],
    handler: async () => {
      const n = await import("@/lib/notifications");
      return {
        kinds: n.providers.map((p) => ({
          id: p.id,
          label: p.label,
          category: p.category,
          description: p.description,
          docs: "docs" in p ? (p.docs ?? null) : null,
          alerting: "alerting" in p ? !!p.alerting : false,
          fields: (p.fields as readonly import("@/lib/notifications").ProviderField[]).map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type ?? "text",
            optional: !!f.optional,
            secret: !!f.secret,
            placeholder: f.placeholder ?? null,
            description: f.description ?? null,
            options: f.options ?? null,
          })),
        })),
        events: n.notifyEventCatalog.map((e) => ({ id: e.id, label: e.label, group: e.group, severity: e.severity })),
        defaultEvents: n.defaultChannelEvents,
        severities: n.severityOptions.map((s) => ({ value: s.value, label: s.label, description: s.description })),
        placeholders: n.placeholders,
      };
    },
  }),
  route({
    method: "POST",
    path: "/notification-channels",
    tag: "Integrations",
    summary: "Add a notification channel",
    description:
      "kind: slack, discord, telegram, email, webhook, ... with its config. Left out like in the dashboard: events (the problems), scope (everything), quietHours (none), throttleMinutes (0), template (none).",
    needs: ["integrations.manage"],
    body: z.looseObject({ name: z.string(), kind: z.string(), config: z.record(z.string(), z.string()), events: z.array(z.string()).optional() }),
    status: 201,
    handler: async ({ auth, body }) =>
      (await unwrap(
        notifications.saveNotificationChannel(null, {
          // Instance and server events belong to the Root organization's channels, as in the dashboard.
          events:
            (await getSettings()).rootOrganizationId === auth.organizationId
              ? defaultChannelEvents
              : defaultChannelEvents.filter((e) => !e.startsWith("instance.") && !e.startsWith("server.")),
          scope: null,
          quietHours: null,
          throttleMinutes: 0,
          template: null,
          ...body,
        } as never),
      )) ?? { ok: true },
  }),
  route({
    method: "PUT",
    path: "/notification-channels/{channelId}",
    tag: "Integrations",
    summary: "Change a notification channel",
    description: "Fields left out keep their saved value; an empty secret in config keeps the stored one.",
    needs: ["integrations.manage"],
    body: z.looseObject({ name: z.string().optional(), kind: z.string().optional() }),
    handler: async ({ auth, params, body }) => {
      const [current] = await db
        .select()
        .from(schema.notificationChannel)
        .where(and(eq(schema.notificationChannel.id, params.channelId), eq(schema.notificationChannel.organizationId, auth.organizationId)));
      if (!current) throw new ApiError(404, "Notification channel not found");
      const { name, kind, events, scope, quietHours, throttleMinutes, template } = current;
      return (
        (await unwrap(
          notifications.saveNotificationChannel(params.channelId, {
            name,
            kind,
            config: channelConfig(current),
            events,
            scope,
            quietHours,
            throttleMinutes,
            template,
            ...body,
          } as never),
        )) ?? { ok: true }
      );
    },
  }),
  route({
    method: "PATCH",
    path: "/notification-channels/{channelId}",
    tag: "Integrations",
    summary: "Turn a notification channel on or off",
    needs: ["integrations.manage"],
    body: z.object({ enabled: z.boolean() }),
    handler: async ({ params, body }) => (await unwrap(notifications.toggleNotificationChannel(params.channelId, body.enabled))) ?? { ok: true },
  }),
  route({
    method: "POST",
    path: "/notification-channels/{channelId}/test",
    tag: "Integrations",
    summary: "Send a test notification",
    needs: ["integrations.manage"],
    handler: async ({ params }) => (await unwrap(notifications.testNotificationChannel(params.channelId))) ?? { ok: true },
  }),
  route({
    method: "DELETE",
    path: "/notification-channels/{channelId}",
    tag: "Integrations",
    summary: "Delete a notification channel",
    needs: ["integrations.manage"],
    handler: async ({ params }) => (await unwrap(notifications.deleteNotificationChannel(params.channelId))) ?? { ok: true },
  }),

  // Secret managers
  route({
    method: "GET",
    path: "/secret-providers",
    tag: "Integrations",
    summary: "List secret managers",
    description: "Vault/OpenBao, Infisical, Doppler and AWS connections. Credentials are not shown.",
    needs: ["integrations.manage"],
    handler: async ({ auth }) => {
      const rows = await db.select().from(schema.secretProvider).where(eq(schema.secretProvider.organizationId, auth.organizationId)).orderBy(asc(schema.secretProvider.name));
      return { providers: rows.map((p) => ({ id: p.id, name: p.name, kind: p.kind, config: p.config, access: p.access, createdAt: iso(p.createdAt) })) };
    },
  }),
  route({
    method: "POST",
    path: "/secret-providers",
    tag: "Integrations",
    summary: "Connect a secret manager",
    needs: ["integrations.manage"],
    body: z.looseObject({ name: z.string(), kind: z.string() }),
    status: 201,
    handler: async ({ body }) => (await unwrap(secretProviders.createSecretProvider(body as never))) ?? { ok: true },
  }),
  route({
    method: "PUT",
    path: "/secret-providers/{providerId}",
    tag: "Integrations",
    summary: "Change a secret manager",
    needs: ["integrations.manage"],
    body: z.looseObject({ name: z.string(), kind: z.string() }),
    handler: async ({ params, body }) => (await unwrap(secretProviders.updateSecretProvider(params.providerId, body as never))) ?? { ok: true },
  }),
  route({
    method: "DELETE",
    path: "/secret-providers/{providerId}",
    tag: "Integrations",
    summary: "Delete a secret manager",
    needs: ["integrations.manage"],
    handler: async ({ params }) => (await unwrap(secretProviders.deleteSecretProvider(params.providerId))) ?? { ok: true },
  }),

  // Cloudflare
  route({
    method: "GET",
    path: "/cloudflare/accounts",
    tag: "Integrations",
    summary: "List connected Cloudflare accounts",
    needs: ["projects.view"],
    handler: async ({ auth }) => {
      const rows = await db
        .select()
        .from(schema.cloudflareAccount)
        .where(eq(schema.cloudflareAccount.organizationId, auth.organizationId))
        .orderBy(asc(schema.cloudflareAccount.name));
      return { accounts: rows.map((a) => ({ id: a.id, name: a.name, email: a.email, cfAccountId: a.cfAccountId, createdAt: iso(a.createdAt) })) };
    },
  }),
  route({
    method: "GET",
    path: "/cloudflare/accounts/{accountId}/zones",
    tag: "Integrations",
    summary: "List the zones of a Cloudflare account",
    needs: ["domains.manage"],
    handler: async ({ auth, params }) => {
      const [row] = await db
        .select({ id: schema.cloudflareAccount.id })
        .from(schema.cloudflareAccount)
        .where(and(eq(schema.cloudflareAccount.id, params.accountId), eq(schema.cloudflareAccount.organizationId, auth.organizationId)));
      if (!row) throw new ApiError(404, "Cloudflare account not found");
      const { Cloudflare } = await import("@/server/cloudflare/api");
      const cf = await Cloudflare.forAccount(row.id);
      return { zones: await cf.zones() };
    },
  }),
  route({
    method: "GET",
    path: "/cloudflare/accounts/{accountId}/zones/{zoneId}/dns",
    tag: "Integrations",
    summary: "List a zone's DNS records",
    description: "type and name narrow the list (name is the full record name, like app.example.com).",
    needs: ["integrations.manage"],
    query: z.object({ type: z.string().max(10).optional(), name: z.string().max(253).optional() }),
    handler: async ({ auth, params, query }) => {
      const [row] = await db
        .select()
        .from(schema.cloudflareAccount)
        .where(and(eq(schema.cloudflareAccount.id, params.accountId), eq(schema.cloudflareAccount.organizationId, auth.organizationId)));
      if (!row) throw new ApiError(404, "Cloudflare account not found");
      const { Cloudflare } = await import("@/server/cloudflare/api");
      const cf = await Cloudflare.forRow(row);
      const zone = await cf.zone(params.zoneId).catch(() => null);
      if (!zone) throw new ApiError(404, "Zone not found in this Cloudflare account");
      const records = await cf.dnsRecords(params.zoneId, { type: query.type?.toUpperCase(), name: query.name }).catch((e: Error) => {
        throw new ApiError(502, `Cloudflare refused: ${e.message}`);
      });
      return {
        zone: { id: zone.id, name: zone.name },
        records: records.map((r) => ({
          id: r.id,
          type: r.type,
          name: r.name,
          content: r.content,
          proxied: r.proxied,
          proxiable: r.proxiable,
          ttl: r.ttl,
          priority: r.priority ?? null,
          comment: r.comment ?? null,
        })),
      };
    },
  }),
  route({
    method: "PUT",
    path: "/cloudflare/accounts/{accountId}/zones/{zoneId}/dns",
    tag: "Integrations",
    summary: "Create or change a DNS record",
    description: "recordId null creates one. Fields: type, name, content, proxied, ttl.",
    needs: ["integrations.manage"],
    body: z.looseObject({ recordId: z.string().nullable().optional(), type: z.string(), name: z.string(), content: z.string() }),
    handler: async ({ params, body }) => {
      const { recordId, ...record } = body as { recordId?: string | null } & Record<string, unknown>;
      return (await unwrap(integrations.upsertDnsRecord(params.accountId, params.zoneId, recordId ?? null, record as never))) ?? { ok: true };
    },
  }),
  route({
    method: "DELETE",
    path: "/cloudflare/accounts/{accountId}/zones/{zoneId}/dns/{recordId}",
    tag: "Integrations",
    summary: "Delete a DNS record",
    needs: ["integrations.manage"],
    handler: async ({ params }) => (await unwrap(integrations.deleteDnsRecord(params.accountId, params.zoneId, params.recordId))) ?? { ok: true },
  }),
  route({
    method: "POST",
    path: "/cloudflare/accounts/{accountId}/zones/{zoneId}/purge-cache",
    tag: "Integrations",
    summary: "Purge a zone's cache",
    needs: ["integrations.manage"],
    handler: async ({ params }) => (await unwrap(integrations.purgeZoneCache(params.accountId, params.zoneId))) ?? { ok: true },
  }),
  route({
    method: "PATCH",
    path: "/cloudflare/accounts/{accountId}/zones/{zoneId}/settings",
    tag: "Integrations",
    summary: "Change a zone's SSL mode or Always Use HTTPS",
    description: "ssl: off, flexible, full or strict. alwaysHttps: redirect http to https at Cloudflare. Fields left out are not changed.",
    needs: ["integrations.manage"],
    body: z.object({ ssl: z.enum(["off", "flexible", "full", "strict"]).optional(), alwaysHttps: z.boolean().optional() }),
    handler: async ({ auth, params, body }) => {
      await cloudflareAccountOf(auth.organizationId, params.accountId);
      if (body.ssl !== undefined) await unwrap(integrations.setZoneSsl(params.accountId, params.zoneId, body.ssl));
      if (body.alwaysHttps !== undefined) await unwrap(integrations.setZoneAlwaysHttps(params.accountId, params.zoneId, body.alwaysHttps));
      return { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/cloudflare/accounts",
    tag: "Integrations",
    summary: "Connect Cloudflare with an API token",
    description:
      "apiToken: a Cloudflare API token with Zone:Read and DNS:Edit (it is stored encrypted and never shown again). Each Cloudflare account the token reaches is connected; name names them. originCaKey: an Origin CA key, for Cloudflare origin certificates.",
    needs: ["integrations.manage"],
    status: 201,
    body: z.object({ name: z.string().max(100).default(""), apiToken: z.string().max(500), originCaKey: z.string().max(500).optional() }),
    handler: async ({ body }) => unwrap(integrations.connectCloudflare(body)),
  }),
  route({
    method: "DELETE",
    path: "/cloudflare/accounts/{accountId}",
    tag: "Integrations",
    summary: "Disconnect a Cloudflare account",
    description: "Its tunnels are stopped and deleted first, with the DNS records Serve made for them: domains served through them stop working.",
    needs: ["integrations.manage"],
    handler: async ({ auth, params }) => {
      await cloudflareAccountOf(auth.organizationId, params.accountId);
      await unwrap(integrations.disconnectCloudflare(params.accountId));
      return { deleted: true };
    },
  }),

  // Git
  route({
    method: "GET",
    path: "/git/credentials",
    tag: "Integrations",
    summary: "List Git connections",
    description: "Tokens, apps and deploy keys. Secrets are not shown.",
    needs: ["projects.view"],
    handler: async ({ auth }) => {
      const rows = await db.select().from(schema.gitCredential).where(eq(schema.gitCredential.organizationId, auth.organizationId)).orderBy(asc(schema.gitCredential.name));
      return { credentials: rows.map((c) => ({ id: c.id, name: c.name, provider: c.provider, baseUrl: c.baseUrl, info: c.publicInfo, createdAt: iso(c.createdAt) })) };
    },
  }),
  route({
    method: "POST",
    path: "/git/credentials/token",
    tag: "Integrations",
    summary: "Add a Git access token",
    description:
      "provider github, gitlab, gitea or bitbucket; baseUrl for a self-hosted GitLab or Gitea. Serve checks the token with the provider and stores it encrypted; it is never shown again. warning: scopes the token lacks.",
    needs: ["integrations.manage"],
    status: 201,
    body: z.object({
      provider: z.enum(["github", "gitlab", "gitea", "bitbucket"]),
      name: z.string().max(100).default(""),
      token: z.string().max(2000),
      baseUrl: z.string().max(500).optional(),
    }),
    handler: async ({ body }) => unwrap(integrations.addGitToken(body)),
  }),
  route({
    method: "POST",
    path: "/git/credentials/deploy-key",
    tag: "Integrations",
    summary: "Make an SSH deploy key",
    description: "Serve makes the key pair and keeps the private key. Add publicKey to the repository as a deploy key (read-only is enough).",
    needs: ["integrations.manage"],
    status: 201,
    body: z.object({ name: z.string().max(100).default("") }),
    handler: async ({ body }) => unwrap(integrations.createDeployKey(body.name)),
  }),
  route({
    method: "DELETE",
    path: "/git/credentials/{credentialId}",
    tag: "Integrations",
    summary: "Remove a Git connection",
    description: "It is removed from Serve only: revoke the token or key at the provider yourself.",
    needs: ["integrations.manage"],
    handler: async ({ auth, params }) => {
      const [row] = await db
        .select({ id: schema.gitCredential.id })
        .from(schema.gitCredential)
        .where(and(eq(schema.gitCredential.id, params.credentialId), eq(schema.gitCredential.organizationId, auth.organizationId)));
      if (!row) throw new ApiError(404, "Git connection not found");
      await unwrap(integrations.deleteGitCredential(row.id));
      return { deleted: true };
    },
  }),
  route({
    method: "GET",
    path: "/git/credentials/{credentialId}/repositories",
    tag: "Integrations",
    summary: "List repositories a Git connection reaches",
    needs: ["services.manage"],
    handler: async ({ params }) => ({ repositories: await unwrap(integrations.fetchRepositories(params.credentialId)) }),
  }),
  route({
    method: "GET",
    path: "/git/branches",
    tag: "Integrations",
    summary: "List the branches of a repository",
    needs: ["services.manage"],
    query: z.object({ repository: z.string(), credentialId: z.string().optional() }),
    handler: async ({ query }) => ({ branches: await unwrap(integrations.fetchBranches(query.repository, query.credentialId ?? null)) }),
  }),

  // Templates
  route({
    method: "GET",
    path: "/templates",
    tag: "Templates",
    summary: "List one-click templates",
    description: "The organization's own templates (custom: true, id custom:<id>) and the built-in ones. Create one with POST /services, type compose and template set to its id.",
    needs: ["projects.view"],
    handler: async ({ auth }) => {
      const custom = await db.select().from(schema.customTemplate).where(eq(schema.customTemplate.organizationId, auth.organizationId)).orderBy(asc(schema.customTemplate.name));
      return {
        templates: [
          ...custom.map((t) => ({
            id: `custom:${t.id}`,
            name: t.name,
            description: t.description,
            category: t.category,
            website: null,
            vars: t.vars,
            custom: true,
            updatedAt: iso(t.updatedAt),
          })),
          ...(await getTemplates()).map((t) => ({ id: t.id, name: t.name, description: t.description, category: t.category, website: t.website, vars: t.vars, custom: false })),
        ],
      };
    },
  }),
  route({
    method: "GET",
    path: "/templates/{templateId}",
    tag: "Templates",
    summary: "Get a template with its compose file",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      if (params.templateId.startsWith("custom:")) {
        const [t] = await db
          .select()
          .from(schema.customTemplate)
          .where(and(eq(schema.customTemplate.id, params.templateId.slice(7)), eq(schema.customTemplate.organizationId, auth.organizationId)));
        if (!t) throw new ApiError(404, "Template not found");
        return {
          template: {
            id: `custom:${t.id}`,
            name: t.name,
            description: t.description,
            category: t.category,
            iconUrl: t.iconUrl,
            compose: t.compose,
            vars: t.vars,
            exposeService: t.exposeService,
            exposePort: t.exposePort,
            custom: true,
          },
        };
      }
      const t = (await getTemplates()).find((x) => x.id === params.templateId);
      if (!t) throw new ApiError(404, "Template not found");
      return { template: { ...t, custom: false } };
    },
  }),
  route({
    method: "POST",
    path: "/templates",
    tag: "Templates",
    summary: "Save a custom template",
    needs: ["integrations.manage"],
    body: loose,
    status: 201,
    handler: async ({ body }) => (await unwrap(templates.saveCustomTemplate(null, body as never))) ?? { ok: true },
  }),
  route({
    method: "DELETE",
    path: "/templates/{templateId}",
    tag: "Templates",
    summary: "Delete a custom template",
    description: "Its id with or without custom: in front.",
    needs: ["integrations.manage"],
    handler: async ({ params }) => (await unwrap(templates.deleteCustomTemplate(params.templateId.replace(/^custom:/, "")))) ?? { ok: true },
  }),

  // Instance (Root admins)
  route({
    method: "GET",
    path: "/instance/updates",
    tag: "Instance",
    summary: "Version and update status",
    needs: ["instance"],
    handler: async () => {
      const s = await getSettings();
      return { version: currentVersion(), check: s.updateCheck, run: s.updateRun ? { ...s.updateRun, log: s.updateRun.log.slice(-4000) } : null };
    },
  }),
  route({
    method: "POST",
    path: "/instance/updates/check",
    tag: "Instance",
    summary: "Check for a new release now",
    needs: ["instance"],
    handler: async () => ({ check: await unwrap(instance.checkUpdatesNow()) }),
  }),
  route({
    method: "POST",
    path: "/instance/updates/install",
    tag: "Instance",
    summary: "Install the newest release",
    description: "Backs up the instance first, then updates. It rolls back by itself if the new version does not start.",
    needs: ["instance"],
    status: 202,
    handler: async () => (await unwrap(instance.startSelfUpdate())) ?? { ok: true },
  }),
  route({
    method: "GET",
    path: "/instance/backups",
    tag: "Instance",
    summary: "List instance backups",
    needs: ["instance"],
    handler: async () => ({ backups: ((await getSettings()).instanceBackups ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }),
  }),
  route({
    method: "POST",
    path: "/instance/backups",
    tag: "Instance",
    summary: "Back up this instance now",
    needs: ["instance"],
    status: 202,
    handler: async () => (await unwrap(instance.startInstanceBackup())) ?? { ok: true },
  }),
  route({
    method: "DELETE",
    path: "/instance/backups/{backupId}",
    tag: "Instance",
    summary: "Delete an instance backup",
    description: "Its file on this server and its S3 copy.",
    needs: ["instance"],
    handler: async ({ params }) => {
      await unwrap(instance.removeInstanceBackup(params.backupId));
      return { ok: true };
    },
  }),
  route({
    method: "GET",
    path: "/deployments",
    tag: "Deployments",
    summary: "Recent deployments across services",
    description: "Newest first. status filters, for example status=building.",
    needs: ["projects.view"],
    query: z.object({ status: z.string().optional(), limit: z.coerce.number().int().optional() }),
    handler: async ({ auth, query }) => {
      const rows = await db
        .select({ deployment: schema.deployment, projectId: schema.service.projectId, serviceName: schema.service.name })
        .from(schema.deployment)
        .innerJoin(schema.service, eq(schema.deployment.serviceId, schema.service.id))
        .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
        .where(
          and(
            eq(schema.project.organizationId, auth.organizationId),
            // In SQL, so a token limited to some projects still gets up to `limit` of theirs.
            auth.projectIds ? inArray(schema.service.projectId, auth.projectIds) : undefined,
            query.status ? eq(schema.deployment.status, query.status as never) : undefined,
          ),
        )
        .orderBy(desc(schema.deployment.createdAt))
        .limit(Math.min(Math.max(query.limit ?? 50, 1), 200));
      const { deploymentView } = await import("../data");
      return { deployments: rows.map((r) => ({ ...deploymentView(r.deployment), serviceName: r.serviceName })) };
    },
  }),
];
