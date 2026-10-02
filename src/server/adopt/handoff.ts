import type Docker from "dockerode";

/**
 * A container made outside Serve that a deployment takes over (move) or copies (copy). A copy of
 * a container lists the volumes or folders copied into the service's own volumes.
 */
export type Handoff = {
  containerId: string;
  name: string;
  mode?: "move" | "copy";
  volumes?: { from: string; to: string }[];
  /** Deploy from this repository from the next deployment on: the first one runs the image as it is. */
  git?: GitAfter;
};

export type GitAfter = { repository: string; branch: string; credentialId: string | null };

/** The name the old container keeps once a service runs in its place. */
export const retiredName = (name: string) => `${name}-before-serve`;

/**
 * Stops the old container and keeps it: its restart policy goes off (its own tools cannot start it
 * again by accident) and it is renamed, so its name is free and it is easy to find for a rollback.
 */
export async function retireOld(d: Docker, h: Handoff, line: (s: string) => void, stopSeconds = 30) {
  const c = d.getContainer(h.containerId);
  const info = await c.inspect().catch(() => null);
  if (!info) return line(`${h.name} is gone already`);
  await c.update({ RestartPolicy: { Name: "no" } }).catch(() => {});
  if (info.State.Running) {
    line(`Stopping ${h.name}`);
    await c.stop({ t: stopSeconds }).catch((e: Error) => {
      if (!/not running|304/i.test(e.message)) throw e;
    });
  }
  if (info.Name.replace(/^\//, "") === h.name) await c.rename({ name: retiredName(h.name) }).catch(() => {});
  line(`${h.name} is stopped and kept as ${retiredName(h.name)}, with its restart policy off`);
}

/** Puts the old container back as it was, after a takeover that failed. */
export async function restoreOld(d: Docker, h: Handoff, policy: { Name: string; MaximumRetryCount?: number } | null, line: (s: string) => void) {
  const c = d.getContainer(h.containerId);
  const info = await c.inspect().catch(() => null);
  if (!info) return;
  if (info.Name.replace(/^\//, "") !== h.name) await c.rename({ name: h.name }).catch(() => {});
  if (policy) await c.update({ RestartPolicy: policy as Docker.HostRestartPolicy }).catch(() => {});
  if (!info.State.Running) {
    await c.start().catch(() => {});
    line(`Started ${h.name} again`);
  }
}

/** The old container's restart policy, read before it is changed. */
export async function restartPolicyOf(d: Docker, h: Handoff) {
  const info = await d
    .getContainer(h.containerId)
    .inspect()
    .catch(() => null);
  return info?.HostConfig.RestartPolicy ?? null;
}
