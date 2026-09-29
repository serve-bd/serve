/** Bytes per second from byte counters (Docker counts since the container started). A reset (restart) gives null. */
export function counterRate<K extends string>(series: ({ t: number } & Record<K, number | null>)[], key: K) {
  const out: { t: number; v: number | null }[] = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1][key];
    const b = series[i][key];
    const dt = (series[i].t - series[i - 1].t) / 1000;
    out.push({ t: series[i].t, v: a !== null && b !== null && b >= a && dt > 0 ? (b - a) / dt : null });
  }
  return out;
}
