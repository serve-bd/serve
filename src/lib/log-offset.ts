/**
 * The part of a log after `offset` characters, and the offset to ask from next time: a client
 * follows a growing log by sending back the offset it got. A long log loses its start (the
 * stored log keeps its newest part), so an offset past the end starts over from the beginning.
 */
export function logsFrom(logs: string, offset: number | undefined) {
  const from = offset && offset > 0 && offset <= logs.length ? offset : 0;
  return { logs: logs.slice(from), offset: logs.length };
}

/**
 * A `since` for container logs as Docker takes it (Unix seconds, with a fraction), from an
 * RFC 3339 time or Unix seconds. Null when it is neither.
 */
export function dockerSince(value: string): string | null {
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return v;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return null;
  // Date keeps milliseconds; finer digits of the input are kept so no line is shown twice.
  const fraction = /\.(\d+)/.exec(v)?.[1] ?? "";
  const nanos = fraction.length > 3 ? fraction.padEnd(9, "0").slice(0, 9) : String((ms % 1000) * 1_000_000).padStart(9, "0");
  return `${Math.floor(ms / 1000)}.${nanos}`;
}
