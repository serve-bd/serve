import { db, schema, sql } from "@/server/db";
import { instanceAdminPage } from "@/server/auth";
import { currentCommit, currentVersion, updateRepository } from "@/server/instance/version";
import { installMode, updateAvailable } from "@/server/instance/updates";
import { AGENT_VERSION, AGENT_BASE } from "@/server/mesh/agent";
import { proxyImages, proxyLabels } from "@/server/proxy/config";
import { getSettings } from "@/server/settings";
import { type Component, UpdatesView } from "./updates-view";

export const metadata = { title: "Updates" };

/** What an update moves, with the version each part runs now. */
async function components(workerVersion: string | null): Promise<Component[]> {
  const version = currentVersion();
  const [pg] = await sql<{ v: string }[]>`select current_setting('server_version') as v`.catch(() => [] as { v: string }[]);
  const servers = await db
    .select({ name: schema.server.name, proxyKind: schema.server.proxyKind, proxyConfig: schema.server.proxyConfig, mesh: schema.server.mesh })
    .from(schema.server);
  const proxies = new Map<string, string[]>();
  for (const s of servers) {
    if (s.proxyKind === "none") continue;
    const custom = s.proxyConfig?.[s.proxyKind]?.container?.image;
    const label = `${proxyLabels[s.proxyKind]} · ${custom || proxyImages[s.proxyKind]}${custom ? " (set by you)" : ""}`;
    proxies.set(label, [...(proxies.get(label) ?? []), s.name]);
  }
  const meshServers = servers.filter((s) => s.mesh).length;
  return [
    { name: "Dashboard", value: `v${version}`, note: "The web app and its database migrations.", ok: true },
    {
      name: "Worker",
      value: workerVersion ? `v${workerVersion}` : "Not running",
      note: "Deploys, backups and checks. Restarted with the dashboard.",
      ok: workerVersion === version,
    },
    { name: "Database", value: pg ? `PostgreSQL ${pg.v.split(" ")[0]}` : "Unknown", note: "Patch releases arrive with updates. Data is kept.", ok: true },
    ...[...proxies].map(([value, names]) => ({
      name: "Proxy",
      value,
      note: `On ${names.join(", ")}. Recreated on every server when an update moves its version.`,
      ok: true,
    })),
    {
      name: "Private network agent",
      value: `${AGENT_VERSION} · ${AGENT_BASE}`,
      note: meshServers
        ? `WireGuard tools, rebuilt on ${meshServers} server${meshServers === 1 ? "" : "s"} when an update changes it. The WireGuard module comes with each server's kernel.`
        : "Built on servers when they join a private network.",
      ok: true,
    },
  ];
}

export default async function UpdatesPage() {
  await instanceAdminPage();
  const s = await getSettings();
  return (
    <UpdatesView
      version={currentVersion()}
      commit={currentCommit()}
      repository={updateRepository()}
      mode={installMode()}
      enabled={s.updateCheckEnabled}
      check={s.updateCheck}
      available={updateAvailable(s.updateCheck)}
      run={s.updateRun}
      components={await components(s.workerVersion)}
    />
  );
}
