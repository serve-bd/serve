import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getServer, type ServerCtx } from "@/server/servers/context";
import { docker as localDocker, imageExists, LABEL, pullImage, removeContainer } from "@/server/docker/client";
import type { OsUpdates, OsPackage, PackageManager } from "@/server/db/schema";

/**
 * Operating system updates of a server: which packages have newer versions, and installing them.
 * Commands run as root on the host itself: through a short-lived helper sharing the host's
 * namespaces on the local server, over SSH (with sudo for a non-root user) elsewhere.
 */

const HELPER_IMAGE = "alpine:3.22.6";

/** Packages whose update restarts the Docker engine, and with it every container on the server. */
export const DOCKER_PACKAGE = /^(docker(-ce|-ce-cli|-ce-rootless-extras|-buildx-plugin|-compose-plugin|-engine|-cli|-buildx|-compose|\.io)?|containerd(\.io)?|moby-[a-z-]+|runc)$/;

/** Names a package manager accepts and a shell keeps as one word. */
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+:@-]{0,127}$/;

const sh = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** Runs a shell script as root on the server's host. */
export async function hostRun(server: ServerCtx, script: string, opts: { onLine?: (line: string) => void; timeoutMs: number }) {
  if (!server.local) {
    const asRoot = server.ssh?.username === "root" ? script : `sudo -n sh -c ${sh(script)}`;
    return server.exec(asRoot, { onLine: opts.onLine, timeoutMs: opts.timeoutMs });
  }
  if (!(await imageExists(HELPER_IMAGE))) await pullImage(HELPER_IMAGE);
  const name = `serve-os-updates-${Date.now().toString(36)}`;
  const container = await localDocker.createContainer({
    name,
    Image: HELPER_IMAGE,
    Cmd: ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "sh", "-c", script],
    Labels: { [LABEL.managed]: "true", [LABEL.kind]: "host-command" },
    HostConfig: { Privileged: true, PidMode: "host", NetworkMode: "host", AutoRemove: false, RestartPolicy: { Name: "no" } },
  });
  let stdout = "";
  try {
    await container.start();
    const stream = (await container.logs({ follow: true, stdout: true, stderr: true })) as unknown as NodeJS.ReadableStream;
    const { PassThrough } = await import("node:stream");
    const out = new PassThrough();
    let partial = "";
    out.on("data", (c: Buffer) => {
      const text = c.toString("utf8");
      stdout += text;
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const l of lines) opts.onLine?.(l);
    });
    localDocker.modem.demuxStream(stream, out, out);
    let timer: NodeJS.Timeout | undefined;
    const result = (await Promise.race([
      container.wait(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Stopped after ${Math.round(opts.timeoutMs / 60_000)} minutes.`)), opts.timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer))) as { StatusCode: number };
    await new Promise((r) => setTimeout(r, 200));
    if (partial) opts.onLine?.(partial);
    return { code: result.StatusCode, stdout, stderr: "" };
  } finally {
    await removeContainer(name, 0).catch(() => {});
  }
}

const DETECT = [
  "if command -v apt-get >/dev/null 2>&1; then echo __PM__=apt",
  "elif command -v dnf >/dev/null 2>&1; then echo __PM__=dnf",
  "elif command -v yum >/dev/null 2>&1; then echo __PM__=yum",
  "elif command -v zypper >/dev/null 2>&1; then echo __PM__=zypper",
  "elif command -v pacman >/dev/null 2>&1; then echo __PM__=pacman",
  "elif command -v apk >/dev/null 2>&1; then echo __PM__=apk",
  "else echo __PM__=none; fi",
].join("; ");

/** The check, for every manager: it prints the manager, then its own list of upgradable packages. */
export const CHECK_SCRIPT = `${DETECT}
case "$(${DETECT} | cut -d= -f2)" in
  apt) export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null 2>&1 || apt-get update -q 2>&1 | tail -3; echo __LIST__; apt list --upgradable 2>/dev/null; [ -f /var/run/reboot-required ] && echo __REBOOT__ ;;
  dnf|yum) PM=$(command -v dnf >/dev/null 2>&1 && echo dnf || echo yum); echo __LIST__; $PM -q check-update 2>/dev/null; command -v needs-restarting >/dev/null 2>&1 && { needs-restarting -r >/dev/null 2>&1 || echo __REBOOT__; } ;;
  zypper) zypper -q -n refresh >/dev/null 2>&1; echo __LIST__; zypper -q -n list-updates 2>/dev/null ;;
  pacman) if command -v checkupdates >/dev/null 2>&1; then echo __LIST__; checkupdates 2>/dev/null; else echo __NOCHECKUPDATES__; fi ;;
  apk) apk update -q >/dev/null 2>&1; echo __LIST__; apk version -l '<' 2>/dev/null ;;
esac
exit 0`;

/** Reads the check's output into the manager and its upgradable packages. */
export function parseCheck(output: string): { manager: PackageManager | null; packages: OsPackage[]; rebootRequired: boolean } {
  const manager = (output.match(/__PM__=(\w+)/)?.[1] ?? "none") as PackageManager | "none";
  const list = output.split("__LIST__")[1] ?? "";
  const rebootRequired = output.includes("__REBOOT__");
  const packages: OsPackage[] = [];
  const add = (name: string, next: string | null, current: string | null) => {
    if (!PACKAGE_NAME.test(name) || packages.some((p) => p.name === name)) return;
    packages.push({ name, next, current, docker: DOCKER_PACKAGE.test(name) });
  };
  for (const raw of list.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("__")) continue;
    if (manager === "apt") {
      // openssl/jammy-updates 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]
      const m = line.match(/^([^/\s]+)\/\S+\s+(\S+)\s+\S+(?:\s+\[upgradable from:\s*([^\]]+)\])?/);
      if (m) add(m[1], m[2], m[3]?.trim() ?? null);
    } else if (manager === "dnf" || manager === "yum") {
      // openssl.x86_64   1:3.0.7-27.el9   baseos
      const m = line.match(/^(\S+)\.[a-z0-9_]+\s+(\S+)\s+\S+$/);
      if (m && !/^(Obsoleting|Last metadata)/.test(line)) add(m[1], m[2], null);
    } else if (manager === "zypper") {
      // v | Main | openssl-3 | 3.1.4-1 | 3.1.4-2 | x86_64
      const cols = line.split("|").map((c) => c.trim());
      if (cols.length >= 5 && cols[0] === "v") add(cols[2], cols[4], cols[3]);
    } else if (manager === "pacman") {
      // openssl 3.3.1-1 -> 3.3.2-1
      const m = line.match(/^(\S+)\s+(\S+)\s+->\s+(\S+)/);
      if (m) add(m[1], m[3], m[2]);
    } else if (manager === "apk") {
      // openssl-3.3.1-r0 < 3.3.2-r0
      const m = line.match(/^(.+)-([^-]+-r\d+)\s+<\s+(\S+)/);
      if (m) add(m[1], m[3], m[2]);
    }
  }
  return { manager: manager === "none" ? null : manager, packages, rebootRequired };
}

/**
 * Arch without checkupdates: refreshing pacman's own database to check would leave a half-upgraded
 * system behind if a package is then installed, so Serve does not check there.
 */
export const NO_CHECKUPDATES = "Install pacman-contrib on this server: its checkupdates finds updates without touching pacman's database.";

/** The command that installs updates of `names` (every listed one on pacman, which cannot do some). */
export function upgradeCommand(manager: PackageManager, names: string[], skipDocker: string[]) {
  for (const n of [...names, ...skipDocker]) if (!PACKAGE_NAME.test(n)) throw new Error(`"${n}" is not a package name.`);
  const list = names.map(sh).join(" ");
  switch (manager) {
    case "apt":
      // Waits for the lock the system's own automatic updates may hold, instead of failing at once.
      return `export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a; apt-get install -y --only-upgrade -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold ${list}`;
    case "dnf":
    case "yum":
      return `${manager} -y upgrade ${list}`;
    case "zypper":
      return `zypper -n update ${list}`;
    case "apk":
      return `apk upgrade ${list}`;
    case "pacman":
      // Arch supports no partial upgrades: everything, Docker's packages left out unless chosen.
      return `pacman -Syu --noconfirm${skipDocker.length ? ` --ignore ${skipDocker.map(sh).join(",")}` : ""}`;
  }
}

async function save(serverId: string, patch: (now: OsUpdates) => OsUpdates) {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ osUpdates: schema.server.osUpdates }).from(schema.server).where(eq(schema.server.id, serverId)).for("update");
    await tx
      .update(schema.server)
      .set({ osUpdates: patch(row?.osUpdates ?? { checkedAt: null, manager: null, packages: [], rebootRequired: false, error: null, run: null }) })
      .where(eq(schema.server.id, serverId));
  });
}

/** Checks a server for package updates and saves the result. Installs nothing. */
export async function checkOsUpdates(serverId: string) {
  const server = await getServer(serverId);
  try {
    const res = await hostRun(server, CHECK_SCRIPT, { timeoutMs: 10 * 60_000 });
    const parsed = parseCheck(res.stdout);
    if (!res.stdout.includes("__PM__=")) throw new Error((res.stderr || res.stdout).trim().slice(0, 500) || "The check did not run. A non-root user needs passwordless sudo.");
    await save(serverId, (now) => ({
      ...now,
      checkedAt: new Date().toISOString(),
      ...parsed,
      error: res.stdout.includes("__NOCHECKUPDATES__")
        ? NO_CHECKUPDATES
        : parsed.manager
          ? null
          : "No supported package manager (apt, dnf, yum, zypper, pacman or apk) on this server.",
    }));
    return parsed;
  } catch (error) {
    await save(serverId, (now) => ({ ...now, checkedAt: new Date().toISOString(), error: (error as Error).message.slice(0, 1000) }));
    throw error;
  }
}

/**
 * Installs the updates of `names` (or every listed package with "all"). Docker's packages are left
 * out of "all"; on the local server they are refused, since updating them stops Serve itself.
 */
export async function installOsUpdates(serverId: string, what: "all" | string[]) {
  try {
    await install(serverId, what);
  } catch (error) {
    // A refusal before the install began (nothing left to update, not checked) leaves the run the action marked as running.
    await failOsUpdateRun(serverId, (error as Error).message);
    throw error;
  }
  // The list changes with what was installed.
  await checkOsUpdates(serverId).catch(() => {});
}

/** Marks a run that is still "running" as failed: refused, cut off or past its time limit. A finished run stays as it is. */
export async function failOsUpdateRun(serverId: string, error: string) {
  await save(serverId, (now) =>
    now.run?.state === "running" ? { ...now, run: { ...now.run, state: "failed", finishedAt: new Date().toISOString(), error: error.slice(0, 1000) } } : now,
  );
}

async function install(serverId: string, what: "all" | string[]) {
  const server = await getServer(serverId);
  const [row] = await db.select({ osUpdates: schema.server.osUpdates }).from(schema.server).where(eq(schema.server.id, serverId));
  const state = row?.osUpdates;
  if (!state?.manager) throw new Error("Check for updates first.");
  const listed = state.packages;
  const chosen = what === "all" ? listed.filter((p) => !p.docker).map((p) => p.name) : what.filter((n) => listed.some((p) => p.name === n));
  if (server.local && chosen.some((n) => DOCKER_PACKAGE.test(n)))
    throw new Error("Docker's packages cannot be updated from here on this server: it would stop Serve itself. Update them in a terminal on the host.");
  if (state.manager === "pacman" && what !== "all") throw new Error("Arch Linux updates everything at once: use Update all.");
  if (!chosen.length) throw new Error("Nothing to update.");
  const skipDocker = listed.filter((p) => p.docker && !chosen.includes(p.name)).map((p) => p.name);
  const command = upgradeCommand(state.manager, chosen, skipDocker);

  const startedAt = new Date().toISOString();
  let log = "";
  let pending: Promise<void> = Promise.resolve();
  let lastWrite = 0;
  const flush = () =>
    save(serverId, (now) => ({ ...now, run: { ...(now.run ?? { state: "running", startedAt, finishedAt: null, what, error: null, log: "" }), log: log.slice(-60_000) } }));
  await save(serverId, (now) => ({ ...now, run: { state: "running", startedAt, finishedAt: null, what, error: null, log: `$ ${command}\n` } }));
  log = `$ ${command}\n`;
  try {
    const res = await hostRun(server, command, {
      timeoutMs: 60 * 60_000,
      onLine: (line) => {
        log += `${line}\n`;
        // About once a second, so the page follows without a write per line.
        if (Date.now() - lastWrite > 1000) {
          lastWrite = Date.now();
          pending = pending.then(flush).catch(() => {});
        }
      },
    });
    await pending;
    // 124: the time limit cut it off. Over SSH the package manager may go on without Serve.
    if (res.code === 124)
      throw new Error("No result after 60 minutes: Serve stopped waiting. The package manager may still be running on the server; check it there before installing again.");
    if (res.code !== 0) throw new Error(`The package manager exited with code ${res.code}.${res.stderr ? ` ${res.stderr.trim().slice(-400)}` : ""}`);
    await save(serverId, (now) => ({ ...now, run: { state: "success", startedAt, finishedAt: new Date().toISOString(), what, error: null, log: log.slice(-60_000) } }));
  } catch (error) {
    await pending;
    await save(serverId, (now) => ({
      ...now,
      run: { state: "failed", startedAt, finishedAt: new Date().toISOString(), what, error: (error as Error).message.slice(0, 1000), log: log.slice(-60_000) },
    }));
    throw error;
  }
}

/** Weekly: servers not checked for a week are checked, and their organization hears of updates. Installs nothing. */
export async function weeklyOsUpdateCheck(enqueueCheck: (serverId: string) => Promise<unknown>) {
  const rows = await db.select({ id: schema.server.id, status: schema.server.status, isLocal: schema.server.isLocal, osUpdates: schema.server.osUpdates }).from(schema.server);
  for (const r of rows) {
    if (!r.isLocal && r.status !== "ready") continue;
    const checked = r.osUpdates?.checkedAt ? new Date(r.osUpdates.checkedAt).getTime() : 0;
    if (Date.now() - checked > 7 * 24 * 3600_000) await enqueueCheck(r.id);
  }
}

/** Tells the server's organization how many updates a check found, at most once a week. */
export async function notifyOsUpdates(serverId: string) {
  const [row] = await db.select().from(schema.server).where(eq(schema.server.id, serverId));
  const state = row?.osUpdates;
  if (!row || !state?.packages.length) return;
  if (state.notifiedAt && Date.now() - new Date(state.notifiedAt).getTime() < 6 * 24 * 3600_000) return;
  const { notify } = await import("@/server/notify");
  const { getSetting } = await import("@/server/settings");
  const n = state.packages.length;
  await notify(row.ownerOrganizationId ?? (await getSetting("rootOrganizationId")), "server.updates", {
    ok: true,
    title: `${n} package update${n === 1 ? "" : "s"} for ${row.name}`,
    body: `${state.packages
      .slice(0, 8)
      .map((p) => p.name)
      .join(", ")}${n > 8 ? ", …" : ""}${state.rebootRequired ? ". The server also waits for a reboot." : ""}`,
    url: `/servers/${serverId}/updates`,
    serverId,
    data: { count: n, rebootRequired: state.rebootRequired },
  }).catch(() => {});
  await save(serverId, (now) => ({ ...now, notifiedAt: new Date().toISOString() }));
}
