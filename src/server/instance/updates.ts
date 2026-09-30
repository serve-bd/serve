import fs from "node:fs";
import path from "node:path";
import { docker, demuxDockerBuffer, pullImage } from "@/server/docker/client";
import { env } from "@/server/env";
import { newId } from "@/server/id";
import { getSettings, type UpdateCheck, type UpdateRun, updateSettings } from "@/server/settings";
import { queueInstanceBackupRecord, runInstanceBackup } from "./backups";
import { compareVersions, imageRepository, nextImage } from "./manifest";
import { ROLLED_BACK_EXIT, updaterScript } from "./updater-script";
import { currentVersion, updateRepository } from "./version";
import { notify } from "@/server/notify";

export const UPDATER_CONTAINER = "serve-updater";
const DEFAULT_IMAGE = "ghcr.io/serve-bd/serve:latest";

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

/** SERVE_IMAGE from the install's .env: the image the stack runs now. */
async function installedImage(): Promise<string> {
  const text = await fs.promises.readFile(path.join(env.dataDir, ".env"), "utf8").catch(() => "");
  const line = text.split("\n").find((l) => l.startsWith("SERVE_IMAGE="));
  return line ? line.slice("SERVE_IMAGE=".length).trim() || DEFAULT_IMAGE : DEFAULT_IMAGE;
}

/** Free space an update needs: a new image, a backup and room to spare. */
const MIN_FREE_BYTES = 2 * 1024 ** 3;

async function freeBytes(dir: string) {
  const s = await fs.promises.statfs(dir).catch(() => null);
  return s ? s.bavail * s.bsize : Number.POSITIVE_INFINITY;
}

/** Records the start of an update; the worker's instance.update job carries it out. */
export async function beginUpdate(to: string): Promise<UpdateRun> {
  const run: UpdateRun = { id: newId(), state: "backing-up", from: currentVersion(), to, startedAt: new Date().toISOString(), finishedAt: null, container: null, log: "" };
  await updateSettings({ updateRun: run });
  return run;
}

/**
 * Checks the disk, backs up the instance, pulls the new image, then starts a one-shot container
 * from it that installs the new stack definition and restarts everything, rolling back if the
 * new version does not come up healthy. It has to be a separate container: `up -d` replaces
 * this worker.
 */
export async function runUpdate(to: string) {
  if (installMode() !== "compose") throw new Error("This installation is not managed by Docker Compose; update it by hand.");
  // A job left over from before a restart must not start a second update.
  const started = (await getSettings()).updateRun;
  if (started?.state !== "backing-up" || started.to !== to) return;
  try {
    const free = await freeBytes(env.dataDir);
    if (free < MIN_FREE_BYTES)
      throw new Error(`Only ${(free / 1024 ** 3).toFixed(1)} GB is free on ${env.dataDir}; an update needs at least 2 GB. Free some space (Servers → Clean up) and try again.`);

    await appendLog("==> Backing up this instance first");
    const backupId = await queueInstanceBackupRecord("update");
    await runInstanceBackup(backupId, (l) => void appendLog(l));
    await appendLog("Backup finished");

    const previousImage = await installedImage();
    const image = nextImage(previousImage, to);
    await setRun({ previousImage, image });
    await appendLog(`==> Pulling ${image}`);
    let last = 0;
    await pullImage(image, (line) => {
      // Layer progress is noisy: keep one line every few seconds.
      if (Date.now() - last < 3000) return;
      last = Date.now();
      void appendLog(line);
    });
    await appendLog("Image pulled");

    await docker
      .getContainer(UPDATER_CONTAINER)
      .remove({ force: true })
      .catch(() => {});
    const dir = env.dataDir;
    const container = await docker.createContainer({
      name: UPDATER_CONTAINER,
      Image: image,
      Entrypoint: ["sh", "-c"],
      Cmd: [updaterScript({ dir, previousImage, image })],
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
 * has exited, record the outcome with its output, remove it and the images no longer needed.
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
  const state: UpdateRun["state"] = exitCode === 0 || (info === null && onNewVersion) ? "success" : exitCode === ROLLED_BACK_EXIT ? "rolled-back" : "failed";
  const tail = state !== "failed" ? "" : `\nThe update container exited with code ${exitCode ?? "unknown"}.\n`;
  await updateSettings({ updateRun: { ...run, state, finishedAt: new Date().toISOString(), log: `${run.log}${output}${tail}`.slice(-20_000) } });
  await docker
    .getContainer(run.container)
    .remove({ force: true })
    .catch(() => {});
  if (state === "success") await removeOldImages(run).catch(() => {});
  const s = await getSettings();
  const ok = state === "success";
  await notify(s.rootOrganizationId, ok ? "instance.update.success" : "instance.update.failed", {
    ok,
    title: ok ? `Serve updated to ${run.to}` : state === "rolled-back" ? `Serve update to ${run.to} was rolled back` : `Serve update to ${run.to} failed`,
    body: ok
      ? `Updated from ${run.from}.`
      : state === "rolled-back"
        ? `The new version did not start correctly, so Serve went back to ${run.from}. Open Settings → Updates for the log.`
        : `The update container exited with code ${exitCode ?? "unknown"}. Serve keeps running ${currentVersion()}.`,
    url: "/settings/updates",
    status: ok ? "updated" : "failed",
    dedupKey: `instance-update:${run.to}`,
    data: { from: run.from, to: run.to, exitCode },
  });
}

/** After a successful update: images of this repository other than the new and the previous one. */
async function removeOldImages(run: UpdateRun) {
  if (!run.image) return;
  const repository = imageRepository(run.image);
  const keep = new Set([run.image, run.previousImage].filter(Boolean));
  const images = await docker.listImages({ filters: { reference: [repository] } });
  for (const img of images) {
    const tags = img.RepoTags ?? [];
    if (!tags.length || tags.some((t) => keep.has(t))) continue;
    await docker
      .getImage(img.Id)
      .remove()
      .catch(() => {});
  }
}
