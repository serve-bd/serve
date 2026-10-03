/**
 * Retries for network trouble that passes on its own: a git host or its API that does not
 * answer in time, drops the connection or answers 5xx. Anything else (a wrong branch, no access,
 * a bad token) fails at once, since trying again cannot change it.
 */

const TRANSIENT_TEXT = [
  /aborted due to timeout/i,
  /timed? ?out/i,
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_/,
  /fetch failed|socket hang up/i,
  /could not resolve host|temporary failure in name resolution/i,
  /failed to connect|connection (was )?(reset|refused|closed)/i,
  /early EOF|RPC failed|unexpected disconnect|the remote end hung up/i,
  /requested URL returned error: (5\d\d|429)/i,
  /\bHTTP (5\d\d|429)\b/,
  /server error|bad gateway|service unavailable|gateway time-?out/i,
];

/** Whether an error looks like network trouble that may pass if tried again. */
export function isTransient(error: unknown): boolean {
  const e = error as { name?: string; message?: string; output?: string; cause?: { code?: string; message?: string } } | null;
  if (!e) return false;
  if (e.name === "TimeoutError") return true;
  const text = [e.message, e.output?.slice(-4000), e.cause?.code, e.cause?.message].filter(Boolean).join("\n");
  return TRANSIENT_TEXT.some((r) => r.test(text));
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/**
 * Runs `fn`, and again after each delay in `delays` while it fails with network trouble.
 * `what` names the step in the log line ("Cloning", "Asking GitHub for access").
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: { what: string; delays?: number[]; log?: (line: string) => void; signal?: AbortSignal }): Promise<T> {
  const delays = opts.delays ?? [3000, 10000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (opts.signal?.aborted || attempt >= delays.length || !isTransient(error)) throw error;
      const reason = ((error as Error).message ?? String(error)).split("\n")[0].slice(0, 160);
      opts.log?.(`${opts.what} failed (${reason}). Trying again in ${delays[attempt] / 1000}s (attempt ${attempt + 2} of ${delays.length + 1}).`);
      await wait(delays[attempt], opts.signal);
    }
  }
}
