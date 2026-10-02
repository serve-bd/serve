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
    // A quoted value may be followed by a comment; an unquoted one ends at " #". A value wrapped
    // in quotes as a whole still counts as quoted with a stray quote inside.
    const closing = closingQuote(value);
    const end =
      closing > 0 && /^(\s+#.*)?$/.test(value.slice(closing + 1)) ? closing : /^["']/.test(value) && value.length >= 2 && value.at(-1) === value[0] ? value.length - 1 : -1;
    if (end > 0) {
      const quoted = value.slice(0, end + 1);
      if (quoted.startsWith('"')) {
        try {
          value = JSON.parse(quoted);
        } catch {
          value = quoted.slice(1, -1);
        }
      } else {
        value = quoted.slice(1, -1);
      }
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out.push({ key, value });
  }
  return out;
}

/** Index of the quote that closes a value starting with one (skipping \" in double quotes), else -1. */
function closingQuote(value: string) {
  const q = value[0];
  if (q !== '"' && q !== "'") return -1;
  for (let i = 1; i < value.length; i++) {
    if (q === '"' && value[i] === "\\") i++;
    else if (value[i] === q) return i;
  }
  return -1;
}

/** Write KEY=VALUE lines that parseEnv reads back; values with spaces, quotes or `#` are quoted. */
export function formatEnv(vars: { key: string; value: string }[]) {
  return vars
    .filter((v) => v.key)
    .map((v) => `${v.key}=${/[\s#"'$\\]/.test(v.value) ? JSON.stringify(v.value) : v.value}`)
    .join("\n");
}
