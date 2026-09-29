import { NextResponse } from "next/server";
import { requireOrg } from "@/server/auth";
import { docker, LABEL } from "@/server/docker/client";
import { latestServiceSamples, statsToSample } from "@/server/metrics";

export const dynamic = "force-dynamic";

type Sample = { cpu: number; memory: number; memoryLimit: number | null };

// Several open tabs share one round of `docker stats` calls.
const store = globalThis as unknown as { __serveHostStats?: { at: number; data: Promise<Record<string, Sample>> } };

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

async function collect(): Promise<Record<string, Sample>> {
  const [containers, samples] = await Promise.all([docker.listContainers(), latestServiceSamples()]);
  const byService = new Map(samples.map((s) => [s.serviceId, s]));
  const perService = new Map<string, number>();
  for (const c of containers) {
    const id = c.Labels[LABEL.service];
    if (id) perService.set(id, (perService.get(id) ?? 0) + 1);
  }

  const out: Record<string, Sample> = {};
  const queue: string[] = [];
  for (const c of containers) {
    const serviceId = c.Labels[LABEL.service];
    const sample = serviceId ? byService.get(serviceId) : undefined;
    // The worker already samples services; reuse it when the service has one container.
    if (sample && perService.get(serviceId) === 1) out[c.Id] = { cpu: sample.cpu, memory: sample.memory, memoryLimit: sample.memoryLimit };
    else queue.push(c.Id);
  }

  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const id = queue[next++];
      const stats = await withTimeout(docker.getContainer(id).stats({ stream: false }).catch(() => null), 3500);
      if (stats) {
        const s = statsToSample(stats as unknown as Parameters<typeof statsToSample>[0]);
        out[id] = { cpu: s.cpu, memory: s.memory, memoryLimit: s.memoryLimit || null };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(10, queue.length) }, worker));
  return out;
}

/** CPU and memory for every running container on the host. */
export async function GET() {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const cached = store.__serveHostStats;
  if (!cached || Date.now() - cached.at > 8000) {
    store.__serveHostStats = { at: Date.now(), data: collect() };
  }
  try {
    return NextResponse.json({ stats: await store.__serveHostStats!.data });
  } catch {
    store.__serveHostStats = undefined;
    return NextResponse.json({ stats: {} });
  }
}
