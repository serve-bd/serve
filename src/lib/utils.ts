import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number | null | undefined, digits = 1) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** "5m ago", or "in 7d" for a date still to come (an invitation or a certificate that expires). */
export function timeAgo(date: Date | string | number) {
  const d = new Date(date).getTime();
  const diff = Math.round((Date.now() - d) / 1000);
  if (Math.abs(diff) < 5) return "just now";
  const span = (n: string) => (diff < 0 ? `in ${n}` : `${n} ago`);
  const sec = Math.abs(diff);
  // The past counts whole units gone by; a date to come rounds, so a link made now for 7 days says "in 7d".
  const whole = diff < 0 ? Math.round : Math.floor;
  if (sec < 60) return span(`${sec}s`);
  const m = whole(sec / 60);
  if (m < 60) return span(`${m}m`);
  const h = whole(sec / 3600);
  if (h < 24) return span(`${h}h`);
  const days = whole(sec / 86400);
  if (days < 30) return span(`${days}d`);
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}
