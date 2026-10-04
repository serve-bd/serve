"use server";

import { requireServerAdmin } from "@/server/servers/access";

import { and, eq } from "drizzle-orm";
import { getSettings } from "@/server/settings";
import { act, UserError } from "@/server/action";
import { db, schema } from "@/server/db";
import { logActivity } from "@/server/activity";
import { enqueue } from "@/server/queue";
import { getServer } from "@/server/servers/context";
import YAML from "yaml";
import { encrypt } from "@/server/crypto";
import { apr1 } from "@/server/services/proxy-config";
import {
  caddySettingsSchema,
  containerOverridesSchema,
  customFilePattern,
  nginxSettingsSchema,
  PROXY_KINDS,
  proxyDefaultsSchema,
  proxyFileSchema,
  proxyLabels,
  traefikSettingsSchema,
  type ProxyDefaults,
  type ProxyFile,
  type ProxyKind,
  type RunningKind,
  type ServerProxyConfig,
} from "@/server/proxy/config";
import { applyServerProxyConfig, ProxyConfigError, proxyStateOf } from "@/server/proxy/nginx";
import { hostPortIssue } from "@/server/proxy/host-relay";
import { visitorIpOf } from "@/server/proxy/trusted-proxies";
import { usesProxyProtocol } from "@/lib/trusted-proxies";

const RUNNING: RunningKind[] = ["nginx", "caddy", "traefik"];

const chains = new Map<string, Promise<unknown>>();
/** One proxy settings change per server at a time: each reads the whole config and writes it back. */
function oneAtATime<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(serverId) ?? Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  chains.set(serverId, tail);
  void tail.then(() => chains.get(serverId) === tail && chains.delete(serverId));
  return next;
}

async function serverRow(serverId: string) {
  const [row] = await db.select().from(schema.server).where(eq(schema.server.id, serverId));
  if (!row) throw new UserError("Server not found.");
  if (!row.isLocal && row.status !== "ready") throw new UserError(`${row.name} is not ready. Validate it first.`);
  return row;
}

/** Queue a switch to another reverse proxy; progress is stored on the server row. */
export async function setProxyKind(serverId: string, kind: ProxyKind) {
  return act(async () => {
    const { ctx } = await requireServerAdmin(serverId);
    if (!PROXY_KINDS.includes(kind)) throw new UserError("Unknown proxy.");
    const row = await serverRow(serverId);
    if (row.proxySwitch?.state === "running" && Date.now() - new Date(row.proxySwitch.startedAt).getTime() < 10 * 60_000) {
      throw new UserError("A proxy switch is already running on this server.");
    }
    await db
      .update(schema.server)
      .set({ proxySwitch: { state: "running", from: row.proxyKind, to: kind, startedAt: new Date().toISOString(), log: "Queued\n" } })
      .where(eq(schema.server.id, serverId));
    await enqueue("proxy.switch", { serverId, to: kind }, { concurrencyKey: `proxy:${serverId}` });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.proxy.switch", message: `Switching ${row.name} to ${proxyLabels[kind]}` });
    return null;
  });
}

/** Current proxy kind and switch progress (polled while a switch runs). */
export async function getProxySwitch(serverId: string) {
  return act(async () => {
    await requireServerAdmin(serverId);
    const [row] = await db.select({ kind: schema.server.proxyKind, sw: schema.server.proxySwitch }).from(schema.server).where(eq(schema.server.id, serverId));
    if (!row) throw new UserError("Server not found.");
    return { kind: row.kind as ProxyKind, switch: row.sw };
  });
}

function cleanError(message: string) {
  return [
    ...new Set(
      message
        .split("\n")
        .map((l) =>
          l
            .replace(/^nginx: /, "")
            .replace(/^\d{4}\/\d\d\/\d\d [\d:]+ /, "")
            .replace(/^\[(\w+)\] \d+#\d+: /, "[$1] ")
            .trim(),
        )
        // Caddy prints JSON info/warn logs around the actual error.
        .filter((l) => l && !/test failed|syntax is ok/.test(l) && !/^\{"level":"(info|warn|debug)"/.test(l)),
    ),
  ]
    .slice(0, 6)
    .join("\n");
}

/** Save one proxy kind's settings for a server; applied (and validated) when that proxy is running. */
export async function saveProxySettings(serverId: string, kind: ProxyKind, input: unknown) {
  return act(() =>
    oneAtATime(serverId, async () => {
      const { ctx, row } = await requireServerAdmin(serverId);
      await serverRow(serverId);
      if (kind === "none") throw new UserError("This server runs no proxy.");
      const { config } = await proxyStateOf(serverId);
      const next: ServerProxyConfig = { ...config };
      if (kind === "nginx") {
        const parsed = nginxSettingsSchema.safeParse(input);
        if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid settings.");
        next.nginx = { ...config.nginx, ...parsed.data, maxBodySize: parsed.data.maxBodySize || null };
      } else if (kind === "caddy") {
        const parsed = caddySettingsSchema.safeParse(input);
        if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid settings.");
        next.caddy = { ...config.caddy, ...parsed.data, email: parsed.data.email || null, rawGlobal: parsed.data.rawGlobal?.trim() || null };
      } else {
        const parsed = traefikSettingsSchema.safeParse(input);
        if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid settings.");
        const { dashboard, ...rest } = parsed.data;
        let dash = config.traefik?.dashboard ?? null;
        if (dashboard) {
          if (!dashboard.enabled) dash = dash ? { ...dash, enabled: false } : null;
          else {
            if (!dashboard.hostname || !dashboard.username) throw new UserError("Enter a hostname and user name for the Traefik dashboard.");
            const keep = dash && dash.username === dashboard.username && !dashboard.password;
            if (!dashboard.password && !keep) throw new UserError("Enter a password for the Traefik dashboard.");
            dash = { enabled: true, hostname: dashboard.hostname, username: dashboard.username, passwordHash: keep ? dash!.passwordHash : apr1(dashboard.password!) };
          }
        }
        next.traefik = { ...config.traefik, ...rest, dashboard: dash };
        // Checked on the merged result, so no field order skips it: only an account of the
        // server's owner (Root for instance servers) may issue its certificates.
        if (next.traefik.acmeChallenge === "dns-cloudflare" && next.traefik.cloudflareAccountId) {
          const owner = row.ownerOrganizationId ?? (await getSettings()).rootOrganizationId;
          const [account] = await db
            .select({ id: schema.cloudflareAccount.id, authType: schema.cloudflareCredential.authType })
            .from(schema.cloudflareAccount)
            .innerJoin(schema.cloudflareCredential, eq(schema.cloudflareAccount.credentialId, schema.cloudflareCredential.id))
            .where(and(eq(schema.cloudflareAccount.id, next.traefik.cloudflareAccountId), eq(schema.cloudflareAccount.organizationId, owner ?? "")));
          if (!account) throw new UserError("Cloudflare account not found.");
          if (account.authType !== "token")
            throw new UserError("Traefik needs a Cloudflare account connected with an API token. An account connected with Cloudflare sign-in has a token that expires.");
        }
      }
      await apply(serverId, kind, next, "these settings");
      await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.proxy.config", message: `Updated ${proxyLabels[kind]} settings` });
      return null;
    }),
  );
}

/** Write, validate and reload; everything is restored when the proxy rejects it. */
async function apply(serverId: string, kind: ProxyKind, next: ServerProxyConfig, what: string) {
  try {
    await applyServerProxyConfig(await getServer(serverId), next);
  } catch (error) {
    const message = cleanError((error as Error).message);
    if (error instanceof ProxyConfigError) throw new UserError(`${proxyLabels[kind]} rejected ${what}. Nothing was changed.\n${message}`);
    throw new UserError(`The change could not be applied: ${message}`);
  }
}

function runningKind(kind: string): RunningKind {
  if (!RUNNING.includes(kind as RunningKind)) throw new UserError("Unknown proxy.");
  return kind as RunningKind;
}

const fileHint: Record<RunningKind, string> = {
  nginx: "Use a name like my-rules.conf.",
  caddy: "Use a name like my-site.caddy.",
  traefik: "Use a name like my-routes.yaml.",
};

/** Add or change (and optionally rename) a custom configuration file. */
export async function saveProxyFile(serverId: string, kindInput: string, input: { originalName?: string | null; name: string; content: string }) {
  return act(() =>
    oneAtATime(serverId, async () => {
      const { ctx } = await requireServerAdmin(serverId);
      const kind = runningKind(kindInput);
      await serverRow(serverId);
      const parsed = proxyFileSchema.safeParse({ name: input.name, content: input.content });
      if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid file.");
      const file: ProxyFile = parsed.data;
      if (!customFilePattern[kind].test(file.name)) throw new UserError(`Invalid file name. ${fileHint[kind]} Lowercase letters, digits, dots, dashes and underscores only.`);
      if (kind === "traefik") {
        try {
          const doc = YAML.parse(file.content);
          if (doc !== null && (typeof doc !== "object" || Array.isArray(doc))) throw new Error("The file must be a YAML map (for example http: routers: …).");
        } catch (error) {
          throw new UserError(`The YAML is not valid: ${(error as Error).message.split("\n")[0]}`);
        }
      }
      const { config } = await proxyStateOf(serverId);
      const files = [...(config[kind]?.files ?? [])];
      const original = input.originalName ?? null;
      if (files.some((f) => f.name === file.name && f.name !== original)) throw new UserError(`A file named ${file.name} already exists.`);
      const index = original ? files.findIndex((f) => f.name === original) : -1;
      if (index >= 0) files[index] = file;
      else files.push(file);
      if (files.length > 50) throw new UserError("Keep at most 50 custom files.");
      const issue = hostPortIssue(kind, files, usesProxyProtocol(await visitorIpOf(await getServer(serverId))));
      if (issue) throw new UserError(issue);
      await apply(serverId, kind, { ...config, [kind]: { ...config[kind], files } }, `the file ${file.name}`);
      await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.proxy.config", message: `Saved ${proxyLabels[kind]} file ${file.name}` });
      return null;
    }),
  );
}

export async function deleteProxyFile(serverId: string, kindInput: string, name: string) {
  return act(() =>
    oneAtATime(serverId, async () => {
      const { ctx } = await requireServerAdmin(serverId);
      const kind = runningKind(kindInput);
      await serverRow(serverId);
      const { config } = await proxyStateOf(serverId);
      const files = (config[kind]?.files ?? []).filter((f) => f.name !== name);
      await apply(serverId, kind, { ...config, [kind]: { ...config[kind], files } }, `the change`);
      await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.proxy.config", message: `Deleted ${proxyLabels[kind]} file ${name}` });
      return null;
    }),
  );
}

/** Turn Serve's built-in catch-all (404 page or redirect), 503 page or HTTPS redirects on or off. */
export async function saveProxyDefaults(serverId: string, kindInput: string, input: ProxyDefaults) {
  return act(() =>
    oneAtATime(serverId, async () => {
      const { ctx } = await requireServerAdmin(serverId);
      const kind = runningKind(kindInput);
      await serverRow(serverId);
      const parsed = proxyDefaultsSchema.safeParse(input);
      if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid settings.");
      const defaults = parsed.data;
      const { config } = await proxyStateOf(serverId);
      const catchAll = defaults.catchAll !== false;
      const clean = {
        catchAll,
        unknownRedirect: catchAll ? (defaults.unknownRedirect ?? null) : null,
        unavailablePage: defaults.unavailablePage !== false,
        httpsRedirect: defaults.httpsRedirect !== false,
      };
      await apply(serverId, kind, { ...config, [kind]: { ...config[kind], defaults: clean } }, "the change");
      await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "server.proxy.config", message: `Updated ${proxyLabels[kind]} built-in defaults` });
      return null;
    }),
  );
}

/** Change the proxy container itself (image, arguments, environment, volumes, ports). `null` resets to Serve's defaults. */
export async function saveProxyContainer(serverId: string, kindInput: string, input: unknown) {
  return act(() =>
    oneAtATime(serverId, async () => {
      const { ctx } = await requireServerAdmin(serverId);
      const kind = runningKind(kindInput);
      await serverRow(serverId);
      const { config } = await proxyStateOf(serverId);
      let container;
      if (input !== null) {
        const parsed = containerOverridesSchema.safeParse(input);
        if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid container settings.");
        const previous = new Map((config[kind]?.container?.env ?? []).map((e) => [e.name, e.value]));
        const names = new Set<string>();
        const env = (parsed.data.env ?? []).map((e) => {
          if (names.has(e.name)) throw new UserError(`The variable ${e.name} is listed twice.`);
          names.add(e.name);
          if (e.value) return { name: e.name, value: encrypt(e.value) };
          const kept = previous.get(e.name);
          if (!kept) throw new UserError(`Enter a value for ${e.name}.`);
          return { name: e.name, value: kept };
        });
        const reserved = new Set([80, 443]);
        for (const p of parsed.data.ports ?? []) {
          const container = Number(p.split(":").at(-1)!.split("/")[0]);
          if (reserved.has(container) && !p.endsWith("/udp"))
            throw new UserError(`Container port ${container} is already published. Change the proxy ports on the Domains page instead.`);
        }
        container = { image: parsed.data.image || null, args: parsed.data.args?.filter(Boolean) ?? [], env, volumes: parsed.data.volumes ?? [], ports: parsed.data.ports ?? [] };
      }
      const next = { ...config, [kind]: { ...config[kind], container } };
      await apply(serverId, kind, next, "the container settings");
      await logActivity({
        userId: ctx.user.id,
        organizationId: ctx.org.id,
        action: "server.proxy.config",
        message: input === null ? `Reset the ${proxyLabels[kind]} container` : `Updated the ${proxyLabels[kind]} container`,
      });
      return null;
    }),
  );
}
