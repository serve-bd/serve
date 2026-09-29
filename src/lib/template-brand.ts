/**
 * Brand tiles for one-click templates. Logos (white glyphs from simple-icons,
 * CC0) live in public/templates/<id>.svg; templates without one get a lettered
 * tile in their colour.
 */
const withLogo: Record<string, string> = {
  n8n: "#EA4B71",
  "node-red": "#8F0000",
  changedetection: "#3056D3",
  umami: "#18181B",
  plausible: "#5850EC",
  matomo: "#3152A0",
  metabase: "#509EE3",
  wordpress: "#21759B",
  ghost: "#15171A",
  directus: "#263238",
  wikijs: "#1976D2",
  bookstack: "#0288D1",
  nextcloud: "#0082C9",
  baserow: "#5190EF",
  "paperless-ngx": "#17541F",
  actual: "#6B46C1",
  mealie: "#E58325",
  vikunja: "#196AFF",
  excalidraw: "#6965DB",
  homepage: "#009BD5",
  freshrss: "#0062BE",
  searxng: "#3050FF",
  gitea: "#609926",
  forgejo: "#F97316",
  "code-server": "#1F2328",
  pocketbase: "#16161A",
  appsmith: "#2A2F3D",
  meilisearch: "#FF5CAA",
  rabbitmq: "#FF6600",
  portainer: "#13BEF9",
  "uptime-kuma": "#5CDD8B",
  grafana: "#F46800",
  prometheus: "#E6522C",
  minio: "#C72E49",
  syncthing: "#0891D1",
  immich: "#4250AF",
  "open-webui": "#18181B",
  mattermost: "#0058CC",
  listmonk: "#0055D4",
  ntfy: "#317F6F",
  vaultwarden: "#175DDC",
  keycloak: "#4D4D4D",
  jellyfin: "#00A4DC",
  audiobookshelf: "#82612C",
  pgadmin: "#336791",
  adminer: "#34567C",
  redisinsight: "#DC382D",
};

const lettered: Record<string, string> = {
  docmost: "#111827",
  nocodb: "#7C3AED",
  linkwarden: "#0EA5E9",
  memos: "#16A34A",
  "stirling-pdf": "#B91C1C",
  "it-tools": "#18A058",
  miniflux: "#33373D",
  mailpit: "#2563EB",
  browserless: "#E11D48",
  typesense: "#D52C5E",
  dozzle: "#0F766E",
  filebrowser: "#40C4FF",
  flowise: "#4F46E5",
  gotify: "#1E88E5",
  navidrome: "#0084FF",
};

const palette = ["#2563EB", "#7C3AED", "#DB2777", "#EA580C", "#16A34A", "#0891B2", "#4F46E5", "#B45309"];

export type TemplateBrand = { color: string; logo: string | null };

/** Tile colour and logo for a template id (built-in) or any other name (custom). */
export function templateBrand(id: string): TemplateBrand {
  if (withLogo[id]) return { color: withLogo[id], logo: `/templates/${id}.svg` };
  if (lettered[id]) return { color: lettered[id], logo: null };
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { color: palette[h % palette.length], logo: null };
}
