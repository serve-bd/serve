/** Counting crashes in a row of one container. Pure, so it is tested without Docker. */

/** A replica that stays up this long has stopped crashing: its count starts over. */
export const STABLE_MS = 10 * 60_000;

/** Restart count of a container when it last counted as stable (or was first seen). */
export type CrashTrack = { base: number };

/**
 * Crashes in a row of one container, from Docker's restart count. The count starts over once the
 * container has run for STABLE_MS, and when Docker reset it (a manual start sets it back to 0).
 * A container first seen that is older than `watchingSince` (the worker was restarted) starts
 * from its current count: restarts from before are not known to be in a row.
 */
export function crashesInARow(
  track: CrashTrack | undefined,
  info: { restartCount: number; running: boolean; startedAt: number; createdAt: number },
  now: number,
  watchingSince = 0,
) {
  let base = track?.base ?? (info.createdAt < watchingSince ? info.restartCount : 0);
  if (info.restartCount < base) base = 0;
  if (info.running && now - info.startedAt >= STABLE_MS) base = info.restartCount;
  return { crashes: info.restartCount - base, track: { base } };
}
