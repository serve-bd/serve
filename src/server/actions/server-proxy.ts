"use server";

import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireInstanceAdmin } from "@/server/auth";
import { logActivity } from "@/server/activity";
import { updateSettings } from "@/server/settings";
import { applyCustomConfig, ProxyConfigError, proxyLogs, readSiteFile, reloadProxy, restartProxy, testProxyConfig } from "@/server/proxy/nginx";

async function audit(userId: string, organizationId: string, action: string, message: string) {
  await logActivity({ userId, organizationId, action, message });
}

/** Validate with nginx -t and apply, or return the nginx error without changing anything. */
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

export async function reloadProxyNow() {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    try {
      await reloadProxy();
    } catch (error) {
      if (error instanceof ProxyConfigError) throw new UserError(`nginx rejected the configuration.\n${cleanNginxError(error.message)}`);
      throw error;
    }
    await audit(ctx.user.id, ctx.org.id, "server.proxy.reload", "Reloaded the proxy");
    return null;
  });
}

export async function restartProxyNow() {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    await restartProxy();
    await audit(ctx.user.id, ctx.org.id, "server.proxy.restart", "Restarted the proxy container");
    return null;
  });
}

export async function testProxy() {
  return act(async () => {
    await requireInstanceAdmin();
    return testProxyConfig();
  });
}

export async function getSiteFile(file: string) {
  return act(async () => {
    await requireInstanceAdmin();
    try {
      return await readSiteFile(file);
    } catch {
      throw new UserError("This file no longer exists.");
    }
  });
}

export async function getProxyLogs() {
  return act(async () => {
    await requireInstanceAdmin();
    return proxyLogs(300);
  });
}
