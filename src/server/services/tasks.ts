import { and, desc, eq, lt, notInArray } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { notify, orgOfService } from "@/server/notify";
import { execCommand, getService, pickContainer } from "./exec";
import { getSetting } from "@/server/settings";

/** Execute one task run (called by the worker). */
export async function runTask(runId: string) {
  const [run] = await db.select().from(schema.taskRun).where(eq(schema.taskRun.id, runId));
  if (run?.status !== "running") return;
  const service = await getService(run.serviceId);
  const task = run.taskId ? (await db.select().from(schema.scheduledTask).where(eq(schema.scheduledTask.id, run.taskId)))[0] : null;
  let exitCode = 1;
  let output = "";
  // One write at a time, all done before the final one: a late progress write must not replace it.
  let progress: Promise<unknown> = Promise.resolve();
  try {
    if (!service) throw new Error("Service no longer exists.");
    const container = await pickContainer(service, task?.composeService);
    let buffer = "";
    let last = Date.now();
    const result = await execCommand(container.id, run.command, {
      timeoutSeconds: task?.timeoutSeconds ?? 3600,
      docker: container.docker,
      onData: (text) => {
        buffer += text;
        // Persist progress every couple of seconds so the UI can follow long runs.
        if (Date.now() - last > 2000) {
          last = Date.now();
          const snapshot = buffer.slice(-256_000);
          progress = progress
            .then(() =>
              db
                .update(schema.taskRun)
                .set({ output: snapshot })
                .where(and(eq(schema.taskRun.id, runId), eq(schema.taskRun.status, "running"))),
            )
            .catch(() => {});
        }
      },
    });
    exitCode = result.exitCode;
    output = result.output + (result.timedOut ? "\nTask timed out." : "");
  } catch (error) {
    output += `${(error as Error).message}\n`;
  }
  await progress;
  const status = exitCode === 0 ? "success" : "failed";
  await db
    .update(schema.taskRun)
    .set({ status, exitCode, output: output.slice(-256_000), finishedAt: new Date() })
    .where(eq(schema.taskRun.id, runId));
  if (task) {
    await db.update(schema.scheduledTask).set({ lastRunAt: new Date(), lastStatus: status }).where(eq(schema.scheduledTask.id, task.id));
    await pruneRuns(task.id);
  }
  if (status === "failed" && service) {
    void notify(await orgOfService(service.id), "task.failed", {
      ok: false,
      title: `Task ${task?.name ?? run.command} failed on ${service.name}`,
      body: output.trim().split("\n").slice(-5).join("\n").slice(0, 500) || `Exit code ${exitCode}`,
      url: `/projects/${service.projectId}/services/${service.id}/tasks`,
      serviceId: service.id,
      data: { taskId: task?.id ?? null, runId, exitCode },
    });
  }
}

async function pruneRuns(taskId: string) {
  const keep = await db.select({ id: schema.taskRun.id }).from(schema.taskRun).where(eq(schema.taskRun.taskId, taskId)).orderBy(desc(schema.taskRun.startedAt)).limit(50);
  if (keep.length < 50) return;
  await db.delete(schema.taskRun).where(
    and(
      eq(schema.taskRun.taskId, taskId),
      notInArray(
        schema.taskRun.id,
        keep.map((k) => k.id),
      ),
    ),
  );
}

export async function startTaskRun(opts: { serviceId: string; taskId?: string | null; command: string; trigger: string; userId?: string | null }) {
  const id = newId();
  await db.insert(schema.taskRun).values({
    id,
    serviceId: opts.serviceId,
    taskId: opts.taskId ?? null,
    command: opts.command,
    trigger: opts.trigger,
    userId: opts.userId ?? null,
  });
  await enqueue("task.run", { runId: id }, { concurrencyKey: opts.taskId ? `task:${opts.taskId}` : undefined });
  return id;
}

const lastFired = new Map<string, number>();

/** Called every minute by the worker. */
export async function scheduleTasks() {
  const tasks = await db.select().from(schema.scheduledTask).where(eq(schema.scheduledTask.enabled, true));
  const now = new Date();
  const tz = await getSetting("timezone");
  for (const t of tasks) {
    try {
      const prev = CronExpressionParser.parse(t.schedule, { currentDate: now, tz }).prev().toDate().getTime();
      if (now.getTime() - prev < 60_000 && lastFired.get(t.id) !== prev) {
        lastFired.set(t.id, prev);
        await startTaskRun({ serviceId: t.serviceId, taskId: t.id, command: t.command, trigger: "schedule" });
      }
    } catch {
      // invalid cron expression: skip
    }
  }
  await scheduleRestarts(now, tz);
  // Runs stuck after a worker restart.
  await db
    .update(schema.taskRun)
    .set({ status: "failed", finishedAt: new Date(), output: "Interrupted." })
    .where(and(eq(schema.taskRun.status, "running"), lt(schema.taskRun.startedAt, new Date(Date.now() - 24 * 3600_000))));
}

const lastRestart = new Map<string, number>();

/** Restart running services whose restartSchedule (cron) fired in the last minute. */
async function scheduleRestarts(now: Date, tz: string) {
  const services = await db
    .select({ id: schema.service.id, runtime: schema.service.runtime, status: schema.service.status })
    .from(schema.service)
    .where(eq(schema.service.status, "running"));
  for (const s of services) {
    const cron = s.runtime.restartSchedule;
    if (!cron) continue;
    try {
      const prev = CronExpressionParser.parse(cron, { currentDate: now, tz }).prev().toDate().getTime();
      if (now.getTime() - prev < 60_000 && lastRestart.get(s.id) !== prev) {
        lastRestart.set(s.id, prev);
        await enqueue("service.restart", { serviceId: s.id }, { concurrencyKey: `service:${s.id}` });
      }
    } catch {
      // invalid cron expression: skip
    }
  }
}
