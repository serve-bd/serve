import { logActivity } from "@/server/activity";

/**
 * What a removal could not take away with it (a DNS record, a read replica on another server, a
 * certificate). The removal itself goes on: these are reported, never hidden.
 */
export const leftover = (list: string[], what: string) => (e: unknown) => void list.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);

/** Kept in the activity log; the text doubles as the warning for whoever is waiting on the removal. */
export async function recordLeftovers(list: string[], at: { organizationId?: string | null; projectId?: string | null; userId?: string | null }) {
  if (!list.length) return null;
  const text = `Not everything could be removed; remove these by hand: ${list.join("; ")}`.slice(0, 2000);
  await logActivity({ ...at, action: "cleanup.leftover", message: text });
  return text;
}
