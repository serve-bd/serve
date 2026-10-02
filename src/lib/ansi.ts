/** Terminal colour codes in log lines: parsed into styled parts, or removed for search and download. */

// CSI sequences (private modes like \x1b[?25l and colon colours included) and OSC ones (window titles).
const ESCAPE = /\x1b(?:\[([0-9;:?<=>]*)([A-Za-z])|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

const palette: Record<number, string> = {
  30: "#8e8e93",
  31: "#ff6961",
  32: "#30d158",
  33: "#ffd60a",
  34: "#64d2ff",
  35: "#da8fff",
  36: "#5ac8fa",
  37: "#e5e5ea",
  90: "#8e8e93",
  91: "#ff8a80",
  92: "#63e6a0",
  93: "#ffe066",
  94: "#8fd8ff",
  95: "#e5a8ff",
  96: "#8ee3f5",
  97: "#ffffff",
};

export type AnsiPart = { text: string; color?: string; bold?: boolean; dim?: boolean };

export function hasAnsi(text: string) {
  return text.includes("\x1b");
}

export function stripAnsi(text: string) {
  return text.replace(ESCAPE, "");
}

export function parseAnsi(text: string): AnsiPart[] {
  const parts: AnsiPart[] = [];
  let style: Omit<AnsiPart, "text"> = {};
  let last = 0;
  for (const m of text.matchAll(ESCAPE)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), ...style });
    last = m.index + m[0].length;
    if (m[2] !== "m") continue; // cursor movement and the like: dropped
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number); // colon colours give NaN: ignored
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) style = {};
      else if (c === 1) style = { ...style, bold: true };
      else if (c === 2) style = { ...style, dim: true };
      else if (c === 22) style = { ...style, bold: false, dim: false };
      else if (c === 39) style = { ...style, color: undefined };
      else if (palette[c]) style = { ...style, color: palette[c] };
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) i += 2;
      else if ((c === 38 || c === 48) && codes[i + 1] === 2) i += 4;
    }
  }
  if (last < text.length) parts.push({ text: text.slice(last), ...style });
  return parts;
}
