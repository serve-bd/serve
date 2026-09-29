import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getServer } from "@/server/servers/context";
import { proxyImages, proxyLabels, type ProxyKind, type ProxySwitchState } from "./config";
import { ensureServerProxy, proxyStateOf, reloadProxy, removeProxyContainers, syncServerProxy, waitHealthy, writeAllFiles } from "./nginx";
import { imageExists, pullImage } from "@/server/docker/client";
import { PROXY_IMAGE } from "./templates";

/**
 * Switch a server's reverse proxy: write the new proxy's configuration for
 * every site, pull its image, replace the container (a few seconds without
 * traffic), and check it answers. Any failure restores the previous proxy.
 */
export async function switchProxy(serverId: string, to: ProxyKind) {
  const ctx = await getServer(serverId);
  const { kind: from, config, stopped } = await proxyStateOf(serverId);
  const state: ProxySwitchState = { state: "running", from, to, startedAt: new Date().toISOString(), log: "" };
  let pending: Promise<unknown> = Promise.resolve();
  const save = () => {
    pending = pending.then(() => db.update(schema.server).set({ proxySwitch: { ...state, log: state.log.slice(-20_000) } }).where(eq(schema.server.id, serverId)));
    return pending;
  };
  const log = (line: string) => {
    state.log += `${line}\n`;
    void save();
  };
  await save();

  let replaced = false;
  try {
    if (from === to) {
      log(`${proxyLabels[to]} is already running; rebuilding its configuration.`);
      await syncServerProxy(ctx, log);
    } else {
      log(`==> Switching from ${proxyLabels[from]} to ${proxyLabels[to]}`);
      const images = to === "none" ? [] : [config[to]?.container?.image || proxyImages[to], ...(to === "traefik" ? [PROXY_IMAGE] : [])];
      for (const image of images) {
        if (await imageExists(image, ctx.docker)) continue;
        log(`Pulling ${image}`);
        await pullImage(image, undefined, null, ctx.docker);
      }
      if (to !== "none") {
        log("==> Writing the configuration for every site");
        await writeAllFiles(ctx, to, config);
      }

      log(to === "none" ? "==> Removing the proxy container (domains stop answering)" : "==> Replacing the proxy container (sites are unreachable for a few seconds)");
      replaced = true;
      await removeProxyContainers(ctx);
      await db.update(schema.server).set({ proxyKind: to }).where(eq(schema.server.id, serverId));
      await ensureServerProxy(ctx, log);
      if (to === "none") {
        log("No proxy runs on this server now. Use published ports or your own proxy.");
      } else if (stopped) {
        log(`The proxy is stopped, so ${proxyLabels[to]} stays stopped. Start it on the Proxy page.`);
      } else {
        if (!(await waitHealthy(ctx))) throw new Error(`${proxyLabels[to]} did not start. See the proxy logs.`);
        log(`${proxyLabels[to]} is running`);
        log("==> Checking the configuration");
        await syncServerProxy(ctx, log);
        await reloadProxy(ctx, []);
      }
    }
    state.state = "success";
    log("==> Done");
  } catch (error) {
    const message = (error as Error).message;
    state.state = "failed";
    state.error = message;
    log(`==> Failed: ${message}`);
    if (replaced) {
      log(`==> Restoring ${proxyLabels[from]}`);
      try {
        await db.update(schema.server).set({ proxyKind: from }).where(eq(schema.server.id, serverId));
        await removeProxyContainers(ctx);
        await writeAllFiles(ctx, from, config);
        await ensureServerProxy(ctx, log);
        await waitHealthy(ctx);
        await syncServerProxy(ctx, log);
        log(`${proxyLabels[from]} restored`);
      } catch (restoreError) {
        log(`Restore failed: ${(restoreError as Error).message}. Use Rebuild on the Proxy page.`);
      }
    }
  } finally {
    state.finishedAt = new Date().toISOString();
    await save();
  }
  if (state.state === "failed") throw new Error(state.error ?? "Proxy switch failed");
}
