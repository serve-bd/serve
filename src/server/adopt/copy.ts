import type Docker from "dockerode";
import { db, schema } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { imageExists, LABEL, pullImage } from "@/server/docker/client";
import { newId } from "@/server/id";
import { engines } from "@/server/databases/engines";
import { databaseCreds } from "@/server/databases/options";
import { execCommand } from "@/server/services/exec";
import { STORAGE_HELPER_IMAGE } from "@/server/backups/storage";
import type { Handoff } from "./handoff";

type Service = typeof schema.service.$inferSelect;

/** Databases of the container being copied, without the engine's own; null where the engine has one. */
async function outsideDatabases(docker: Docker, h: Handoff, service: Service) {
  const cfg = service.database!;
  if (!engines[cfg.engine].backupDatabasesCommand) return null;
  const { userScripts, parseListing, usersSupported } = await import("@/server/databases/users");
  if (!usersSupported(cfg)) return null;
  const creds = { ...databaseCreds(cfg, decrypt(cfg.password)), tlsRequired: false };
  const res = await execCommand(h.containerId, userScripts(cfg.engine, creds).list(), { docker, timeoutSeconds: 60 });
  if (res.exitCode !== 0) throw new Error(`Could not list the databases of ${h.name}: ${res.output.replaceAll(creds.password, "***").trim().slice(-300)}`);
  return [...new Set([cfg.database, ...parseListing(cfg.engine, res.output).databases])].sort();
}

/**
 * Copies a running database container's data into a new database service (same engine and
 * account): dumped with the engine's own tools while it keeps running, restored as an import.
 */
export async function copyDatabaseInto(service: Service, docker: Docker, h: Handoff, line: (s: string) => void) {
  const cfg = service.database!;
  const { backupFile, dumpOutsideDatabase, restoreBackup } = await import("@/server/backups");
  const databases = await outsideDatabases(docker, h, service);
  line(`Copying ${databases ? databases.join(", ") : "the data"} from ${h.name}, which keeps running`);
  const id = newId();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const ext =
    databases && engines[cfg.engine].backupDatabasesCommand
      ? engines[cfg.engine].backupDatabasesCommand!({ username: "", password: "", database: "" }, databases).extension
      : engines[cfg.engine].backupExtension;
  const filename = `${service.slug}-copy-${stamp}.${ext}`;
  const file = backupFile(service.id, filename);
  const fs = await import("node:fs");
  await fs.promises.mkdir((await import("node:path")).dirname(file), { recursive: true });
  const { size } = await dumpOutsideDatabase(
    docker,
    h.containerId,
    cfg.engine,
    { username: cfg.username, password: decrypt(cfg.password), database: cfg.database },
    databases,
    file,
  );
  line(`Dumped ${(size / 1024).toFixed(1)} KB`);
  // Kept as an import of the service: it can be restored again from the Backups tab.
  await db.insert(schema.backup).values({
    id,
    serviceId: service.id,
    trigger: "import",
    status: "success",
    filename,
    size,
    databases: databases && databases.length > 1 ? databases : null,
    log: `Copied from the container ${h.name}\n`,
  });
  await restoreBackup(id);
  line("Restored the copy");
}

/**
 * Copies the volumes and folders of a container into the new service's own volumes. The container
 * stops meanwhile, so files are not copied while it writes them, and starts again after.
 */
export async function copyVolumesInto(docker: Docker, h: Handoff, line: (s: string) => void) {
  const pairs = h.volumes ?? [];
  if (!pairs.length) return;
  const old = docker.getContainer(h.containerId);
  const info = await old.inspect().catch(() => null);
  const wasRunning = !!info?.State.Running;
  if (!(await imageExists(STORAGE_HELPER_IMAGE, docker))) await pullImage(STORAGE_HELPER_IMAGE, undefined, null, docker);
  if (wasRunning) {
    line(`Stopping ${h.name} while its data is copied`);
    await old.stop({ t: 30 }).catch(() => {});
  }
  try {
    for (const p of pairs) {
      line(`Copying ${p.from} into ${p.to}`);
      const c = await docker.createContainer({
        Image: STORAGE_HELPER_IMAGE,
        Cmd: ["sh", "-c", "cp -a /from/. /to/"],
        Labels: { [LABEL.managed]: "true", [LABEL.kind]: "storage-backup" },
        HostConfig: { Binds: [`${p.from}:/from:ro`, `${p.to}:/to`], NetworkMode: "none" },
      });
      try {
        await c.start();
        const { StatusCode } = (await c.wait()) as { StatusCode: number };
        if (StatusCode !== 0) {
          const logs = (await c.logs({ stdout: true, stderr: true })).toString().slice(-800);
          throw new Error(`Copying ${p.from} failed: ${logs.trim() || `exit code ${StatusCode}`}`);
        }
      } finally {
        await c.remove({ force: true }).catch(() => {});
      }
    }
  } finally {
    if (wasRunning) {
      await old.start().catch(() => {});
      line(`Started ${h.name} again`);
    }
  }
}
