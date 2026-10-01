/**
 * The service count of a server card. Service statuses are what Serve last saw, so a server it
 * cannot reach shows how many services it holds, not how many run.
 */
export function serverServicesText(s: { services: number; running: number; status: string; isLocal?: boolean }, short = false) {
  const noun = `service${s.services === 1 ? "" : "s"}`;
  if (s.services === 0) return short ? "0 services" : "No services";
  if (!s.isLocal && (s.status === "unreachable" || s.status === "error")) return `${s.services} ${noun} · status unknown`;
  return short ? `${s.running}/${s.services} running` : `${s.running}/${s.services} ${noun} running`;
}

/** Whether a server's last known state can be trusted (it answered on its last check). */
export const serverReachable = (s: { status: string; isLocal?: boolean }) => !!s.isLocal || (s.status !== "unreachable" && s.status !== "error");

/** Statuses read from the containers; on a server Serve cannot reach they are only the last thing it saw. */
const CONTAINER_STATUSES = new Set(["running", "crashed", "restarting"]);

/** The status to show for a service: "unknown" when its server cannot be reached and the status came from its containers. */
export function shownServiceStatus(status: string, server: { status: string; isLocal?: boolean } | null | undefined) {
  return server && !serverReachable(server) && CONTAINER_STATUSES.has(status) ? "unknown" : status;
}
