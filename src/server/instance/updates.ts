import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { docker, demuxDockerBuffer } from "@/server/docker/client";
import { env } from "@/server/env";
import { newId } from "@/server/id";
import { getSettings, type UpdateCheck, type UpdateRun, updateSettings } from "@/server/settings";
import { queueInstanceBackupRecord, runInstanceBackup } from "./backups";
import { compareVersions, nextImage } from "./manifest";
import { currentVersion, updateRepository } from "./version";
import { notify } from "@/server/notify";

export const UPDATER_CONTAINER = "serve-updater";
const DEFAULT_IMAGE = "ghcr.io/shahriyardx/serve:latest";

/**
 * How this instance was installed. Only the Docker Compose install (install.sh) can update
 * itself; a checkout run with pnpm is updated by hand.
 */
export function installMode(): "compose" | "manual" {
  const composeFile = path.join(env.dataDir, "docker-compose.yml");
  return process.env.SERVE_ROLE && fs.existsSync(composeFile) && fs.existsSync(env.dockerSocket) ? "compose" : "manual";
}

/** Ask GitHub for the newest release. Stored so the dashboard can show it without calling out. */
export async function checkForUpdates(): Promise<UpdateCheck> {
  const checkedAt = new Date().toISOString();
  let check: UpdateCheck;
  try {
    const res = await fetch(`https://api.github.com/repos/${updateRepository()}/releases/latest`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `serve/${currentVersion()}`,
        // Only needed while the repository is private.
        ...(process.env.SERVE_UPDATE_TOKEN ? { authorization: `Bearer ${process.env.SERVE_UPDATE_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      check = { checkedAt, latest: null, url: null, notes: null, publishedAt: null, error: null };
    } else if (!res.ok) {
      check = { checkedAt, latest: null, url: null, notes: null, publishedAt: null, error: `GitHub answered ${res.status}` };
    } else {
      const r = (await res.json()) as { tag_name?: string; html_url?: string; body?: string; published_at?: string };
      check = {
        checkedAt,
        latest: r.tag_name ? r.tag_name.replace(/^v/i, "") : null,
        url: r.html_url ?? null,
        notes: r.body ? r.body.slice(0, 8000) : null,
        publishedAt: r.published_at ?? null,
        error: null,
      };
    }
  } catch (e) {
    check = { checkedAt, latest: null, url: null, notes: null, publishedAt: null, error: (e as Error).message };
  }
  await updateSettings({ updateCheck: check });
  return check;
}

export function updateAvailable(check: UpdateCheck | null): boolean {
  return !!check?.latest && compareVersions(check.latest, currentVersion()) > 0;
}

/** Worker tick: re-check every few hours while checks are on. */
export async function periodicUpdateCheck() {
  const s = await getSettings();
  if (!s.updateCheckEnabled) return;
  const age = s.updateCheck ? Date.now() - new Date(s.updateCheck.checkedAt).getTime() : Number.POSITIVE_INFINITY;
  if (age <= 6 * 3600_000) return;
  const previous = s.updateCheck?.latest ?? null;
  const check = await checkForUpdates();
  // Tell once per new version, not on every check.
  if (updateAvailable(check) && check.latest !== previous) {
    await notify(s.rootOrganizationId, "instance.update.available", {
      ok: true,
      title: `Serve ${check.latest} is available`,
      body: `This instance runs ${currentVersion()}. Open Settings → Updates to see what changed.`,
      url: "/settings/updates",
      status: "available",
      data: { current: currentVersion(), latest: check.latest, releaseUrl: check.url },
    });
  }
}

async function setRun(patch: Partial<UpdateRun>) {
  const run = (await getSettings()).updateRun;
  if (run) await updateSettings({ updateRun: { ...run, ...patch } });
}

const appendLog = async (line: string) => {
  const run = (await getSettings()).updateRun;
  if (run) await updateSettings({ updateRun: { ...run, log: `${run.log}${line}\n`.slice(-20_000) } });
};

/** Image of the container this process runs in (web or worker). */
async function ownImage(): Promise<string | null> {
  const info = await docker
    .getContainer(os.hostname())
    .inspect()
    .catch(() => null);
  return info?.Config.Image ?? null;
}

/** Pins SERVE_IMAGE in the install's .env to the new version (unless it tracks :latest). */
async function pinImage(version: string): Promise<string> {
  const file = path.join(env.dataDir, ".env");
  const text = await fs.promises.readFile(file, "utf8").catch(() => "");
  const line = text.split("\n").find((l) => l.startsWith("SERVE_IMAGE="));
  const current = line ? line.slice("SERVE_IMAGE=".length).trim() : DEFAULT_IMAGE;
  const next = nextImage(current, version);
  if (next !== current) {
    const updated = line ? text.replace(line, `SERVE_IMAGE=${next}`) : `${text.replace(/\n?$/, "\n")}SERVE_IMAGE=${next}\n`;
    await fs.promises.writeFile(file, updated, { mode: 0o600 });
  }
  return next;
}

/** Records the start of an update; the worker's instance.update job carries it out. */
export async function beginUpdate(to: string): Promise<UpdateRun> {
  const run: UpdateRun = { id: newId(), state: "backing-up", from: currentVersion(), to, startedAt: new Date().toISOString(), finishedAt: null, container: null, log: "" };
  await updateSettings({ updateRun: run });
  return run;
}

/**
 * Backs up the instance, then starts a one-shot container that pulls the new image and
 * recreates the stack. It has to be a separate container: `up -d` replaces this worker.
 */
export async function runUpdate(to: string) {
  if (installMode() !== "compose") throw new Error("This installation is not managed by Docker Compose; update it by hand.");
  try {
    await appendLog("==> Backing up this instance first");
    const backupId = await queueInstanceBackupRecord("update");
    await runInstanceBackup(backupId, (l) => void appendLog(l));
    await appendLog("Backup finished");

    const image = await pinImage(to);
    await appendLog(`==> Updating to ${image}`);
    const runner = (await ownImage()) ?? image;
    await docker
      .getContainer(UPDATER_CONTAINER)
      .remove({ force: true })
      .catch(() => {});
    const dir = env.dataDir;
    const compose = `docker compose --project-directory '${dir}' -f '${dir}/docker-compose.yml'`;
    const container = await docker.createContainer({
      name: UPDATER_CONTAINER,
      Image: runner,
      Entrypoint: ["sh", "-c"],
      Cmd: [`set -e\n${compose} pull serve serve-worker\n${compose} up -d serve serve-worker\necho "Serve restarted on the new version."`],
      Labels: { "serve.managed": "true", "serve.kind": "updater" },
      HostConfig: { Binds: [`${env.dockerSocket}:/var/run/docker.sock`, `${dir}:${dir}`], RestartPolicy: { Name: "no" } },
    });
    await container.start();
    await setRun({ state: "running", container: UPDATER_CONTAINER });
    await appendLog("The update container is running. The dashboard restarts in a moment.");
  } catch (e) {
    await appendLog(`==> ${(e as Error).message}`);
    await setRun({ state: "failed", finishedAt: new Date().toISOString() });
    throw e;
  }
}

/** Output of the update container while it runs (or before it is cleaned up). */
export async function updaterLogs(): Promise<string | null> {
  const buf = await docker
    .getContainer(UPDATER_CONTAINER)
    .logs({ stdout: true, stderr: true, tail: 200 })
    .catch(() => null);
  return buf ? demuxDockerBuffer(buf as unknown as Buffer) : null;
}

/**
 * Worker tick (and boot, since the update restarts the worker): once the update container
 * has exited, record the outcome with its output and remove it.
 */
export async function reconcileUpdate() {
  const run = (await getSettings()).updateRun;
  if (run?.state !== "running" || !run.container) return;
  const info = await docker
    .getContainer(run.container)
    .inspect()
    .catch(() => null);
  if (info?.State.Running) return;
  const output = (await updaterLogs()) ?? "";
  const exitCode = info?.State.ExitCode ?? null;
  const onNewVersion = compareVersions(currentVersion(), run.to) >= 0;
  const ok = exitCode === 0 || (info === null && onNewVersion);
  await updateSettings({
    updateRun: {
      ...run,
      state: ok ? "success" : "failed",
      finishedAt: new Date().toISOString(),
      log: `${run.log}${output}${ok ? "" : `\nThe update container exited with code ${exitCode ?? "unknown"}.\n`}`.slice(-20_000),
    },
  });
  await docker
    .getContainer(run.container)
    .remove({ force: true })
    .catch(() => {});
  const s = await getSettings();
  await notify(s.rootOrganizationId, ok ? "instance.update.success" : "instance.update.failed", {
    ok,
    title: ok ? `Serve updated to ${run.to}` : `Serve update to ${run.to} failed`,
    body: ok ? `Updated from ${run.from}.` : `The update container exited with code ${exitCode ?? "unknown"}. Serve keeps running ${currentVersion()}.`,
    url: "/settings/updates",
    status: ok ? "updated" : "failed",
    dedupKey: `instance-update:${run.to}`,
    data: { from: run.from, to: run.to, exitCode },
  });
}
