import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import type { DeploymentTrigger, DeploymentUpload, StackRunStep } from "@/server/db/schema";

type Run = typeof schema.stackRun.$inferSelect;
type Step = StackRunStep & { upload?: DeploymentUpload | null; awaitingUpload?: boolean };

/** How long a run waits for the CLI's upload of a folder before that service fails. */
const UPLOAD_WAIT_MS = 30 * 60_000;
const TICK_MS = 3000;

export type RunPart = { key: string; serviceId: string; wave: number; needs: StackRunStep["needs"]; deploy: boolean; upload: boolean };

/**
 * Starts deploying a stack: services wave by wave, each once what it needs is ready. `deploy:
 * false` parts count as ready at once (unchanged and running). `upload`: the CLI sends the
 * folder next (attachStackUpload); the service waits for it.
 */
export async function startStackRun(environmentId: string, stackName: string, parts: RunPart[], opts: { userId: string | null; trigger: DeploymentTrigger }) {
  // A newer up takes over: what the older run had not started yet is skipped.
  const older = await db
    .select()
    .from(schema.stackRun)
    .where(and(eq(schema.stackRun.environmentId, environmentId), eq(schema.stackRun.stackName, stackName), eq(schema.stackRun.status, "running")));
  for (const run of older) await cancelStackRun(run, "A newer serve compose up took over.");
  const id = newId();
  const steps: Step[] = parts.map((p) => ({
    key: p.key,
    serviceId: p.serviceId,
    wave: p.wave,
    needs: p.needs,
    state: p.deploy ? "waiting" : "unchanged",
    deploymentId: null,
    note: null,
    awaitingUpload: p.deploy && p.upload,
    upload: null,
  }));
  await db.insert(schema.stackRun).values({ id, environmentId, stackName, steps, userId: opts.userId, status: steps.some((s) => s.state === "waiting") ? "running" : "success" });
  if (steps.some((s) => s.state === "waiting")) await enqueue("stack.advance", { runId: id, trigger: opts.trigger }, { concurrencyKey: `stack:${id}` });
  return id;
}

/** The CLI's upload of a folder for a service waiting in a run. */
export async function attachStackUpload(runId: string, serviceId: string, upload: DeploymentUpload) {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(schema.stackRun).where(eq(schema.stackRun.id, runId)).for("update");
    const steps = (run?.steps ?? []) as Step[];
    const step = steps.find((s) => s.serviceId === serviceId);
    if (!run || run.status !== "running" || !step?.awaitingUpload || step.state !== "waiting") return false;
    step.upload = upload;
    step.awaitingUpload = false;
    await tx.update(schema.stackRun).set({ steps }).where(eq(schema.stackRun.id, runId));
    return true;
  });
}

const done = (s: Step) => s.state === "success" || s.state === "unchanged";
const over = (s: Step) => done(s) || s.state === "failed" || s.state === "skipped";

/** One look at a run: follows its deployments and starts what may start. Queued again until it ends. */
export async function advanceStackRun(runId: string, trigger: DeploymentTrigger) {
  // The run's row stays locked: an upload arriving meanwhile waits instead of being written over.
  const again = await db.transaction(async (tx) => {
    const [run] = await tx.select().from(schema.stackRun).where(eq(schema.stackRun.id, runId)).for("update");
    if (!run || run.status !== "running") return false;
    return advance(tx, run, trigger);
  });
  if (again) await enqueue("stack.advance", { runId, trigger }, { concurrencyKey: `stack:${runId}`, runAt: new Date(Date.now() + TICK_MS) });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Moves a locked run on; answers whether it is still going. */
async function advance(tx: Tx, run: Run, trigger: DeploymentTrigger) {
  const runId = run.id;
  const steps = run.steps as Step[];
  const byKey = new Map(steps.map((s) => [s.key, s]));

  for (const s of steps.filter((x) => x.state === "deploying" && x.deploymentId)) {
    let [dep] = await db
      .select()
      .from(schema.deployment)
      .where(eq(schema.deployment.id, s.deploymentId as string));
    // A newer deployment took its place (a push, someone deploying): follow that one.
    if (dep?.status === "superseded") {
      [dep] = await db.select().from(schema.deployment).where(eq(schema.deployment.serviceId, s.serviceId)).orderBy(desc(schema.deployment.createdAt)).limit(1);
      if (dep) s.deploymentId = dep.id;
    }
    if (!dep) {
      s.state = "failed";
      s.note = "Its deployment is gone.";
    } else if (dep.status === "success") {
      s.state = "success";
      s.note = null;
    } else if (dep.status === "failed" || dep.status === "cancelled") {
      s.state = "failed";
      s.note = dep.status === "cancelled" ? "Its deployment was cancelled." : (dep.error?.split("\n")[0] ?? "Its deployment failed.");
    } else if (dep.status === "waiting") s.note = "Waiting for approval.";
  }

  const started = async (s: Step) => {
    if (done(s)) return true;
    if (s.state !== "deploying" || !s.deploymentId) return false;
    const [dep] = await db.select({ status: schema.deployment.status }).from(schema.deployment).where(eq(schema.deployment.id, s.deploymentId));
    return dep?.status === "deploying";
  };

  for (const s of steps.filter((x) => x.state === "waiting")) {
    const blocked = s.needs.map((n) => byKey.get(n.on)).find((d) => d && (d.state === "failed" || d.state === "skipped"));
    if (blocked) {
      s.state = "skipped";
      s.note = `${blocked.key} ${blocked.state === "failed" ? "failed" : "was skipped"}.`;
      continue;
    }
    let ready = true;
    for (const n of s.needs) {
      const d = byKey.get(n.on);
      if (d && !(n.condition === "started" ? await started(d) : done(d))) ready = false;
    }
    if (!ready) continue;
    if (s.awaitingUpload) {
      if (Date.now() - run.createdAt.getTime() > UPLOAD_WAIT_MS) {
        s.state = "failed";
        s.note = "Its folder was never uploaded. Run serve compose up again.";
      } else s.note = "Waiting for its files from the CLI.";
      continue;
    }
    try {
      const { queueDeployment } = await import("@/server/services/create");
      // "cli" reads as a CLI upload: a service the CLI sent no files for deploys as from the API.
      const id = await queueDeployment(s.serviceId, trigger === "cli" && !s.upload ? "api" : trigger, { userId: run.userId, upload: s.upload ?? null });
      const [dep] = await db.select({ status: schema.deployment.status, error: schema.deployment.error }).from(schema.deployment).where(eq(schema.deployment.id, id));
      if (dep?.status === "failed" || dep?.status === "cancelled") {
        s.state = "failed";
        s.note = dep.error?.split("\n")[0] ?? "The deployment did not start.";
      } else {
        s.state = "deploying";
        s.deploymentId = id;
        s.note = null;
      }
    } catch (e) {
      s.state = "failed";
      s.note = (e as Error).message;
    }
  }

  const finished = steps.every(over);
  await tx
    .update(schema.stackRun)
    .set({ steps, ...(finished ? { status: steps.every(done) ? "success" : "failed", finishedAt: new Date() } : {}) })
    .where(eq(schema.stackRun.id, runId));
  return !finished;
}

/** Stops a run: services not started yet are skipped; deployments already running go on. */
export async function cancelStackRun(run: Run, why = "The run was cancelled.") {
  await db.transaction(async (tx) => {
    const [now] = await tx.select().from(schema.stackRun).where(eq(schema.stackRun.id, run.id)).for("update");
    if (!now || now.status !== "running") return;
    const steps = (now.steps as Step[]).map((s) => (s.state === "waiting" ? { ...s, state: "skipped" as const, note: why } : s));
    await tx.update(schema.stackRun).set({ steps, status: "cancelled", finishedAt: new Date() }).where(eq(schema.stackRun.id, run.id));
  });
}

/** A run as the API shows it (uploads left out: they are internal). */
export function runView(run: Run) {
  return {
    id: run.id,
    stack: run.stackName,
    status: run.status,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    services: (run.steps as Step[]).map(({ upload: _u, awaitingUpload, ...s }) => ({ ...s, awaitingUpload: !!awaitingUpload })),
  };
}
