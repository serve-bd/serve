/** .env files, read the way docker compose reads them. Safe in the browser. */

/** KEY=value lines, like docker compose: # comments, `export `, quotes ('…' as is, "…" with \n). */
export function parseEnvFile(text: string): { values: Record<string, string> } | { error: string } {
  const values: Record<string, string> = {};
  const lines = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) return { error: `line ${i + 1}: use KEY=value` };
    let v = m[2];
    if (v.startsWith("'") || v.startsWith('"')) {
      const q = v[0];
      // A quoted value may run over several lines.
      while (!closes(v, q) && i + 1 < lines.length) v += `\n${lines[++i]}`;
      const end = v.lastIndexOf(q);
      if (end === 0) return { error: `line ${i + 1}: the quote is not closed` };
      v = v.slice(1, end);
      if (q === '"') v = v.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c));
    } else {
      v = v.replace(/\s+#.*$/, "").trim();
    }
    values[m[1]] = v;
  }
  return { values };
}

function closes(v: string, q: string) {
  for (let i = 1; i < v.length; i++) {
    if (q === '"' && v[i] === "\\") i++;
    else if (v[i] === q) return true;
  }
  return false;
}
