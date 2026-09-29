/** White-label branding: product name, logos, favicon and accent colour. Pure helpers, shared by server and tests. */

export const DEFAULT_PRODUCT_NAME = "Serve";
export const MAX_BRAND_IMAGE_BYTES = 512 * 1024;

export type BrandAssetKind = "logo" | "logoDark" | "favicon";
export const brandAssetKinds: BrandAssetKind[] = ["logo", "logoDark", "favicon"];

export type BrandImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml" | "image/x-icon";

/** Stored with the settings: which images exist, by content hash (the bytes live in their own rows). */
export type BrandingConfig = {
  /** Show the product name next to a custom logo. */
  showName: boolean;
  /** Accent colour as #rrggbb, or null for the default. */
  accent: string | null;
  logo: { hash: string; mime: BrandImageMime } | null;
  logoDark: { hash: string; mime: BrandImageMime } | null;
  favicon: { hash: string; mime: BrandImageMime } | null;
};

export const defaultBranding: BrandingConfig = { showName: true, accent: null, logo: null, logoDark: null, favicon: null };

/** Types each asset accepts. The favicon also takes .ico; logos do not. */
export const acceptedTypes: Record<BrandAssetKind, BrandImageMime[]> = {
  logo: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
  logoDark: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
  favicon: ["image/png", "image/svg+xml", "image/x-icon"],
};

const startsWith = (buf: Uint8Array, bytes: number[], offset = 0) => bytes.every((b, i) => buf[offset + i] === b);

/** The real type of an image from its first bytes; the file name and the browser's claim are ignored. */
export function detectImageType(buf: Uint8Array): BrandImageMime | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (startsWith(buf, [0x00, 0x00, 0x01, 0x00]) && buf.length > 6) return "image/x-icon";
  const head = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, 1024)).replace(/^﻿/, "").trimStart();
  // Optional XML declaration and comments before the root element.
  const rest = head.replace(/^<\?xml[^>]*\?>\s*/i, "").replace(/^(<!--[\s\S]*?-->\s*)+/, "");
  if (/^<svg[\s>]/i.test(rest)) return "image/svg+xml";
  return null;
}

/**
 * Why an SVG is refused, or null when it is safe to serve. Logos are only ever shown
 * through <img> and served with a strict CSP, so scripts cannot run anyway; this keeps
 * active content out of storage in the first place.
 */
export function unsafeSvgReason(svg: string): string | null {
  const s = svg.toLowerCase();
  if (/<!doctype|<!entity/.test(s)) return "SVG files with a DOCTYPE or entities are not allowed.";
  if (/<script\b/.test(s)) return "SVG files with scripts are not allowed.";
  if (/<foreignobject\b/.test(s)) return "SVG files with embedded HTML are not allowed.";
  if (/\son[a-z]+\s*=/.test(s)) return "SVG files with event handlers are not allowed.";
  if (/javascript:/.test(s)) return "SVG files with javascript: links are not allowed.";
  // External references (images, fonts, stylesheets) would load from other sites.
  if (/(?:href|src)\s*=\s*["']\s*(?:https?:)?\/\//.test(s) || /url\(\s*["']?\s*(?:https?:)?\/\//.test(s) || /@import/.test(s)) {
    return "SVG files that load other files are not allowed.";
  }
  return null;
}

/** Why an upload is refused, or null. Also returns the detected type. */
export function checkBrandImage(kind: BrandAssetKind, buf: Uint8Array): { mime: BrandImageMime; error: null } | { mime: null; error: string } {
  if (!buf.length) return { mime: null, error: "The file is empty." };
  if (buf.length > MAX_BRAND_IMAGE_BYTES) return { mime: null, error: `The file is ${Math.ceil(buf.length / 1024)} KB. The limit is 512 KB.` };
  const mime = detectImageType(buf);
  if (!mime || !acceptedTypes[kind].includes(mime)) {
    return { mime: null, error: kind === "favicon" ? "Use a PNG, SVG or ICO file." : "Use a PNG, JPEG, WebP or SVG file." };
  }
  if (mime === "image/svg+xml") {
    const reason = unsafeSvgReason(new TextDecoder().decode(buf));
    if (reason) return { mime: null, error: reason };
  }
  return { mime, error: null };
}

export function normalizeHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const long = /^#?([0-9a-f]{6})$/.exec(v);
  return long ? `#${long[1]}` : null;
}

type Rgb = [number, number, number];

function toRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb) {
  return `#${[r, g, b]
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** WCAG relative luminance. */
export function luminance(hex: string) {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const LIGHT_BG = "#f5f5f7";
const DARK_BG = "#0b0b0d";

export type AccentTokens = { accent: string; strong: string; fg: string; soft: string; ring: string };

/**
 * The accent variables for one theme. The colour is nudged until it stands out from the
 * page (3:1, like other controls), and its text colour is whichever of white or black reads best.
 */
function themeTokens(hex: string, theme: "light" | "dark"): AccentTokens {
  const bg = theme === "light" ? LIGHT_BG : DARK_BG;
  let rgb = toRgb(hex);
  for (let i = 0; i < 12 && contrast(toHex(rgb), bg) < 3; i++) rgb = mix(rgb, theme === "light" ? BLACK : WHITE, 0.12);
  const accent = toHex(rgb);
  const strong = toHex(mix(rgb, theme === "light" ? BLACK : WHITE, 0.14));
  // White text like the default accent, unless the colour is too light for it.
  const fg = contrast(accent, "#ffffff") >= 3 ? "#ffffff" : "#000000";
  const [r, g, b] = rgb.map(Math.round);
  return {
    accent,
    strong,
    fg,
    soft: `rgb(${r} ${g} ${b} / ${theme === "light" ? 0.1 : 0.16})`,
    ring: `rgb(${r} ${g} ${b} / ${theme === "light" ? 0.45 : 0.55})`,
  };
}

export function accentTokens(hex: string): { light: AccentTokens; dark: AccentTokens } | null {
  const valid = normalizeHex(hex);
  if (!valid) return null;
  return { light: themeTokens(valid, "light"), dark: themeTokens(valid, "dark") };
}

/** CSS that overrides the accent variables in both themes. Only built from validated hex values. */
export function accentCss(hex: string | null): string | null {
  const tokens = hex ? accentTokens(hex) : null;
  if (!tokens) return null;
  const block = (t: AccentTokens) => `--accent:${t.accent};--accent-strong:${t.strong};--accent-fg:${t.fg};--accent-soft:${t.soft};--ring:${t.ring};`;
  return `:root:root{${block(tokens.light)}}:root:root[data-theme="dark"]{${block(tokens.dark)}}`;
}

export function cleanProductName(name: string) {
  return name
    .replace(/[\r\n\t<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}
