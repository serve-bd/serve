/**
 * Longest a worker job may run. A handler stuck on a call that never returns (an SSH command
 * without a timeout) would otherwise hold its concurrency key until the worker restarts, and with
 * it every later job of that key (every deploy of the service, every backup of the database).
 * The limits are generous: they only catch jobs that are stuck, never ones that are slow.
 */

const HOUR = 60;

/** Minutes per job type. Copies of data scale with the data, so they get the most room. */
const LIMITS: Record<string, number> = {
  deploy: 2 * HOUR,
  "backup.run": 6 * HOUR,
  "backup.restore": 6 * HOUR,
  "backup.import": 6 * HOUR,
  "environment.copy-data": 6 * HOUR,
  "preview.database": 6 * HOUR,
  "database.branch": 6 * HOUR,
  "instance.backup": 6 * HOUR,
  // Backs up the instance first.
  "instance.update": 6 * HOUR,
  "server.setup": 2 * HOUR,
  "server.os-updates": 2 * HOUR,
  "task.run": 2 * HOUR,
  cleanup: HOUR,
  "service.stop": HOUR,
  "service.start": HOUR,
  "service.restart": HOUR,
  "service.delete": HOUR,
  "proxy.switch": 30,
  "proxy.sync": 30,
  "certificate.issue": 30,
  "certificate.retire": 15,
  "certificate.renew-all": 30,
  "mesh.sync": 15,
  "tunnel.sync": 15,
  "notification.deliver": 15,
};

/** What a job set for itself, read before it starts. */
export type JobTimeoutHints = {
  /** The service's build timeout (deploys). */
  buildTimeoutMinutes?: number | null;
  /** The task's own timeout (task runs). */
  taskTimeoutSeconds?: number | null;
  /** The deployment time limit of the service's server (deploys). */
  serverDeployMinutes?: number | null;
  /** The backup's own time limit, which stops the dump itself (backups). */
  backupTimeoutMinutes?: number | null;
};

/** Minutes a job of this type may run before the worker gives up on it. */
export function jobTimeoutMinutes(type: string, hints: JobTimeoutHints = {}): number {
  const base = LIMITS[type] ?? HOUR;
  // The server's own limit for deployments is the owner's choice: it wins, longer or shorter.
  if (type === "deploy" && hints.serverDeployMinutes) return hints.serverDeployMinutes;
  // A service may allow its build up to 4 hours, and a task up to a day: the job outlives both.
  if (type === "deploy" && hints.buildTimeoutMinutes) return Math.max(base, hints.buildTimeoutMinutes + HOUR);
  // A backup's own limit stops the dump and its processes: the job waits a little longer, for that and the upload.
  if (type === "backup.run" && hints.backupTimeoutMinutes) return Math.max(base, hints.backupTimeoutMinutes + HOUR);
  if (type === "task.run" && hints.taskTimeoutSeconds) return Math.max(base, Math.ceil(hints.taskTimeoutSeconds / 60) + 15);
  return base;
}

/** The abort reason of a job that ran past its limit, so a handler can tell it from a cancel. */
export class JobTimeout extends Error {
  constructor(
    public minutes: number,
    why = "the job ran longer than its time limit and looked stuck",
  ) {
    super(`Stopped after ${minutes} minutes: ${why}.`);
    this.name = "JobTimeout";
  }
}
