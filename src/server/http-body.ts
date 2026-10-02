/**
 * A request body as text, read no further than `max` bytes: null when it is larger. The
 * content-length header is checked first, but a chunked body has none, so the stream is counted too.
 */
export async function readBodyLimited(request: Request, max: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A JSON request body read no further than `max` bytes; `fallback` when it is larger, unreadable or not JSON. */
export async function readJsonLimited(request: Request, max: number, fallback: unknown): Promise<unknown> {
  const text = await readBodyLimited(request, max).catch(() => null);
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
