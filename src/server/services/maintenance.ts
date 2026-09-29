import { isCidr } from "./proxy-config";
import type { MaintenanceConfig } from "./types";

export { isCidr };

export const MAINTENANCE_DEFAULTS: Omit<MaintenanceConfig, "enabled"> = {
  title: "We'll be back soon",
  message: "We're doing some planned maintenance. Please check back in a few minutes.",
  allow: [],
  retryAfterMinutes: 10,
};

/** File name of a service's maintenance page in the proxy's pages directory. */
export const maintenancePageName = (serviceId: string) => `maintenance-${serviceId}.html`;

/** What the proxy needs to serve maintenance for a service, or null when it is off. */
export function maintenanceOf(serviceId: string, cfg: MaintenanceConfig | null | undefined) {
  if (!cfg?.enabled) return null;
  return {
    page: maintenancePageName(serviceId),
    retryAfter: Math.max(60, Math.round((cfg.retryAfterMinutes || MAINTENANCE_DEFAULTS.retryAfterMinutes) * 60)),
    allow: (cfg.allow ?? []).filter(isCidr),
  };
}

export type ProxyMaintenance = NonNullable<ReturnType<typeof maintenanceOf>>;

const escapeHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The maintenance page itself: plain HTML, no external assets, light and dark. */
export function maintenanceHtml(cfg: Pick<MaintenanceConfig, "title" | "message">) {
  const title = escapeHtml(cfg.title.trim() || MAINTENANCE_DEFAULTS.title);
  const paragraphs = (cfg.message.trim() || MAINTENANCE_DEFAULTS.message)
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n    ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #0a0a0a; --muted: #6b6b6b; --line: #e5e5e5; --dot: #f59e0b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0a0a0a; --fg: #fafafa; --muted: #a3a3a3; --line: #262626; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
         font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px; }
  main { max-width: 460px; text-align: center; }
  .badge { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); border: 1px solid var(--line);
           border-radius: 999px; padding: 4px 12px; }
  .badge i { width: 7px; height: 7px; border-radius: 50%; background: var(--dot); }
  h1 { font-size: 28px; line-height: 1.2; margin: 18px 0 10px; letter-spacing: -.02em; }
  p { color: var(--muted); margin: 0 0 10px; }
</style>
</head>
<body>
  <main>
    <span class="badge"><i></i>Maintenance</span>
    <h1>${title}</h1>
    ${paragraphs}
  </main>
</body>
</html>
`;
}
