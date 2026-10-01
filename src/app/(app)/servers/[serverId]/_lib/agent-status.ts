import type { ServerRow } from "@/server/servers/context";
import type { AgentStatus } from "../server-settings";

/** How samples of a remote server arrive, from what its agent last did. */
export function agentStatus(row: { status: string; agent: ServerRow["agent"] }): AgentStatus {
  const a = row.agent;
  if (!a) return { kind: row.status === "ready" ? "none" : "starting" };
  if (a.error) return { kind: "error", message: a.error };
  if (a.seenAt && Date.now() - new Date(a.seenAt).getTime() < 5 * 60_000) return { kind: a.via === "ssh" ? "ssh" : "push", seenAt: a.seenAt, version: a.version ?? null };
  if (Date.now() - new Date(a.installedAt).getTime() < 3 * 60_000) return { kind: "starting" };
  return { kind: "error", message: a.seenAt ? "no samples for a while" : "it has not reported yet" };
}
