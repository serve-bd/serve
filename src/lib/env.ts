/** Parse KEY=VALUE lines (supports quotes, `export` and comments). */
export function parseEnv(text: string) {
  const out: { key: string; value: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, "")
      .trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out.push({ key, value });
  }
  return out;
}

/** Write KEY=VALUE lines that parseEnv reads back; values with spaces, quotes or `#` are quoted. */
export function formatEnv(vars: { key: string; value: string }[]) {
  return vars
    .filter((v) => v.key)
    .map((v) => `${v.key}=${/[\s#"'$\\]/.test(v.value) ? JSON.stringify(v.value) : v.value}`)
    .join("\n");
}
