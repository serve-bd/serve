import { ZodError } from "zod";

export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

export class UserError extends Error {}

/** Wrap a server action body: returns data or a readable error for toasts. */
export async function act<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    // Let Next.js redirects/notFound propagate.
    if (error && typeof error === "object" && "digest" in error && String((error as { digest: unknown }).digest).startsWith("NEXT_")) {
      throw error;
    }
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      return { ok: false, error: issue ? `${issue.path.join(".") || "Value"}: ${issue.message}` : "Invalid input" };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UserError) return { ok: false, error: message };
    console.error("[action]", error);
    // Never leak SQL or stack details to the browser.
    if (/^Failed query|syntax error|violates|relation "/i.test(message)) {
      return { ok: false, error: "Something went wrong while saving. Check the server logs for details." };
    }
    return { ok: false, error: message };
  }
}
