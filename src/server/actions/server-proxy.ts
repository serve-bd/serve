"use server";

import { requireServerAdmin } from "@/server/servers/access";

import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireInstanceAdmin } from "@/server/auth";
import { logActivity } from "@/server/activity";
import { updateSettings } from "@/server/settings";
import {
  applyCustomConfig,
  ProxyConfigError,
  proxyLogs,
  readSiteFile,
  reloadProxy,
  restartProxy,
  startProxy,
  stopProxy,
  syncServerProxy,
  testProxyConfig,
} from "@/server/proxy/nginx";
import { getServer } from "@/server/servers/context";

async function serverCtx(serverId: string) {
  try {
    return await getServer(serverId);
  } catch (error) {
    throw new UserError((error as Error).message);
  }
}

async function audit(userId: string, organizationId: string, action: string, message: string) {
  await logActivity({ userId, organizationId, action, message });
}

/**
 * Validate with nginx -t and apply on every server, or return the nginx error
 * without changing anything. Custom directives are shared by all proxies, so
 * this action takes no server id.
 */
export async function saveProxyCustomConfig(config: string) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const value = z.string().max(20_000, "Keep custom configuration under 20,000 characters").parse(config);
    try {
      await applyCustomConfig(value);
    } catch (error) {
      if (error instanceof ProxyConfigError) throw new UserError(`nginx rejected the configuration. Nothing was changed.\n${cleanNginxError(error.message)}`);
      throw error;
    }
    await updateSettings({ proxyCustomConfig: value.trim() ? value : null });
    await audit(ctx.user.id, ctx.org.id, "server.proxy.config", "Updated custom proxy configuration");
    return null;
  });
}

/** Keep only the useful nginx lines ("[emerg] … in file:line"). */
function cleanNginxError(output: string) {
  const lines = output.split("\n").filter((l) => /\[(emerg|error|crit|alert)\]/.test(l));
  const clean = (lines.length ? lines : output.split("\n").slice(0, 3)).map((l) =>
    l
      .replace(/^nginx: /, "")
      .replace(/^\d{4}\/\d{2}\/\d{2} [\d:]+ /, "")
      .replace(/^\[(\w+)\] \d+#\d+: /, "[$1] ")
      .trim(),
  );
  return [...new Set(clean)].join("\n");
}

export async function reloadProxyNow(serverId: string) {
  return act(async () => {
    const { ctx } = await requireServerAdmin(serverId);
    const server = await serverCtx(serverId);
    try {
      await reloadProxy(server);
    } catch (error) {
      if (error instanceof ProxyConfigError) throw new UserError(`The proxy rejected the configuration.\n${cleanNginxError(error.message)}`);
      throw error;
    }
    await audit(ctx.user.id, ctx.org.id, "server.proxy.reload", `Reloaded the proxy on ${server.name}`);
    return null;
  });
}

export async function restartProxyNow(serverId: string) {
  return act(async () => {
    const { ctx } = await requireServerAdmin(serverId);
    const server = await serverCtx(serverId);
    await restartProxy(server);
    await audit(ctx.user.id, ctx.org.id, "server.proxy.restart", `Restarted the proxy container on ${server.name}`);
    return null;
  });
}

/** Recreate (if needed) and regenerate every site file on one server's proxy. */
export async function rebuildProxyNow(serverId: string) {
  return act(async () => {
    const { ctx } = await requireServerAdmin(serverId);
    const server = await serverCtx(serverId);
    try {
      await syncServerProxy(server);
    } catch (error) {
      if (error instanceof ProxyConfigError) throw new UserError(`The proxy rejected the configuration.\n${cleanNginxError(error.message)}`);
      throw error;
    }
    await audit(ctx.user.id, ctx.org.id, "server.proxy.rebuild", `Rebuilt the proxy configuration on ${server.name}`);
    return null;
  });
}

export async function testProxy(serverId: string) {
  return act(async () => {
    await requireServerAdmin(serverId);
    return testProxyConfig(await serverCtx(serverId));
  });
}

export async function getSiteFile(serverId: string, file: string) {
  return act(async () => {
    await requireServerAdmin(serverId);
    const server = await serverCtx(serverId);
    try {
      return await readSiteFile(server, file);
    } catch {
      throw new UserError("This file no longer exists.");
    }
  });
}

export async function getProxyLogs(serverId: string) {
  return act(async () => {
    await requireServerAdmin(serverId);
    return proxyLogs(await serverCtx(serverId), 300);
  });
}

/** Stop the proxy; every site on the server goes offline until it is started again. */
export async function stopProxyNow(serverId: string) {
  return act(async () => {
    const { ctx } = await requireServerAdmin(serverId);
    const server = await serverCtx(serverId);
    await stopProxy(server);
    await audit(ctx.user.id, ctx.org.id, "server.proxy.stop", `Stopped the proxy on ${server.name}`);
    return null;
  });
}

export async function startProxyNow(serverId: string) {
  return act(async () => {
    const { ctx } = await requireServerAdmin(serverId);
    const server = await serverCtx(serverId);
    try {
      await startProxy(server);
    } catch (error) {
      throw new UserError((error as Error).message);
    }
    await audit(ctx.user.id, ctx.org.id, "server.proxy.start", `Started the proxy on ${server.name}`);
    return null;
  });
}
