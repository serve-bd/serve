/*
 * Signing in the CLI (`serve login`), like signing in a TV: the CLI shows a short code and opens
 * the dashboard, someone signed in approves the code there, and the CLI, polling with its secret
 * device code, receives an API token once.
 */

/** Seconds a code stays valid. */
export const CLI_LOGIN_TTL = 600;
/** Seconds between polls the CLI is asked to keep. */
export const CLI_LOGIN_INTERVAL = 2;

/** Letters without vowels (no words by accident) and digits without 0 and 1 (no O/I mix-ups). */
const LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
const DIGITS = "23456789";

/** A code like BCDF-2345, from `random(n)` giving an integer below n. */
export function newUserCode(random: (n: number) => number): string {
  let out = "";
  for (let i = 0; i < 4; i++) out += LETTERS[random(LETTERS.length)];
  out += "-";
  for (let i = 0; i < 4; i++) out += DIGITS[random(DIGITS.length)];
  return out;
}

/** A code as someone typed or pasted it ("bcdf 2345", "BCDF2345"), or null when it cannot be one. */
export function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z]{4}[0-9]{4}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export type CliLoginStatus = "pending" | "approved" | "denied" | "spent";

/** What a sign-in is now: an approved or pending one past its time has expired. */
export function cliLoginState(row: { status: CliLoginStatus; expiresAt: Date }, now = Date.now()): CliLoginStatus | "expired" {
  if (row.status === "denied" || row.status === "spent") return row.status;
  return row.expiresAt.getTime() <= now ? "expired" : row.status;
}

/** The computer name the CLI sends, kept short and printable. */
export function cleanClientName(input: unknown): string {
  const name = typeof input === "string" ? input.replace(/[^\p{L}\p{N} ._-]/gu, "").trim() : "";
  return name.slice(0, 64) || "unknown computer";
}

/**
 * Whether a poll came sooner than the interval allows (slow_down). Half a second of slack covers
 * timers and network jitter.
 */
export function pollTooSoon(last: number | undefined, now: number, interval = CLI_LOGIN_INTERVAL) {
  return last !== undefined && now - last < interval * 1000 - 500;
}
