import { CronExpressionParser } from "cron-parser";
import type { InstanceBackup } from "@/server/settings";

/**
 * Parts of the data directory an instance backup carries. Service volumes, build
 * workspaces, git clones, logs and database backups are left out: they are large and
 * either rebuilt on the next deploy or backed up on their own.
 */
export const INSTANCE_BACKUP_PATHS = ["certs", "letsencrypt", "proxy", "ssh", "services", "docker-compose.yml"] as const;

/** Excluded inside the included paths (tar --exclude patterns, relative to the data dir). */
export const INSTANCE_BACKUP_EXCLUDES = ["proxy/logs", "services/*/repo", "services/*/builds", ".env"] as const;

export type InstanceManifest = {
  format: 1;
  kind: "serve-instance-backup";
  version: string;
  commit: string | null;
  schemaVersion: string;
  createdAt: string;
  database: { file: "database.dump"; format: "pg_dump custom"; serverVersion: string | null };
  files: string[];
  excluded: string[];
  /** The key that decrypts secrets stored in the database is never part of a backup. */
  encryptionKeyIncluded: false;
};

export function buildManifest(input: {
  version: string;
  commit: string | null;
  schemaVersion: string;
  createdAt: Date;
  files: string[];
  pgServerVersion: string | null;
}): InstanceManifest {
  return {
    format: 1,
    kind: "serve-instance-backup",
    version: input.version,
    commit: input.commit,
    schemaVersion: input.schemaVersion,
    createdAt: input.createdAt.toISOString(),
    database: { file: "database.dump", format: "pg_dump custom", serverVersion: input.pgServerVersion },
    files: [...input.files].sort(),
    excluded: [...INSTANCE_BACKUP_EXCLUDES],
    encryptionKeyIncluded: false,
  };
}

/** File name of a bundle: sortable, no characters that need quoting. */
export function bundleName(createdAt: Date, version: string) {
  const stamp = createdAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `serve-${stamp}-v${version.replace(/[^0-9a-z.-]/gi, "")}.tar.gz`;
}

/**
 * Backups to delete so `keep` successful ones remain. Failed backups older than the newest
 * success go too; a running backup is never touched.
 */
export function expiredBackups(backups: InstanceBackup[], keep: number): InstanceBackup[] {
  const sorted = [...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const successes = sorted.filter((b) => b.status === "success");
  const kept = new Set(successes.slice(0, Math.max(1, keep)).map((b) => b.id));
  const newestSuccess = successes[0]?.createdAt ?? null;
  return sorted.filter((b) => {
    if (b.status === "running") return false;
    if (b.status === "success") return !kept.has(b.id);
    return newestSuccess !== null && b.createdAt < newestSuccess;
  });
}

/** Whether a cron schedule fired in the last minute and that run has not been handled. */
export function scheduleDue(cron: string, now: Date, tz: string, lastRunAt: string | null): string | null {
  try {
    const prev = CronExpressionParser.parse(cron, { currentDate: now, tz }).prev().toDate();
    if (now.getTime() - prev.getTime() >= 60_000) return null;
    const key = prev.toISOString();
    return lastRunAt && lastRunAt >= key ? null : key;
  } catch {
    return null;
  }
}

/** Compare dotted versions ("0.10.1" > "0.9.3"). A leading "v" is ignored; pre-release tags sort below the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/i, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The image reference to run after an update. A pinned tag moves to the new version;
 * `latest` (or no tag) stays as it is and is pulled again.
 */
export function nextImage(current: string, version: string): string {
  const at = current.lastIndexOf(":");
  const slash = current.lastIndexOf("/");
  if (at <= slash) return current;
  const tag = current.slice(at + 1);
  if (tag === "latest") return current;
  return `${current.slice(0, at)}:${version.replace(/^v/i, "")}`;
}
