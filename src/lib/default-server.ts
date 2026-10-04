type ServerChoice = { id: string; status: string; isLocal: boolean };

/** A server new services can go to right now. */
const usable = (s: ServerChoice) => s.isLocal || s.status === "ready";

/**
 * The organization's default server among those it may use: the one it chose while that is still
 * usable, else the first usable one (the local server first). Null when it can use none.
 */
export function pickDefault<T extends ServerChoice>(servers: T[], chosen: string | null): T | null {
  return servers.find((s) => s.id === chosen && usable(s)) ?? servers.find(usable) ?? null;
}
