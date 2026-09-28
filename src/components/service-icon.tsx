import { Box, Container, Database, GitBranch, Layers } from "lucide-react";
import { cn } from "@/lib/utils";

const engineColors: Record<string, string> = {
  postgres: "#336791",
  mysql: "#00758f",
  mariadb: "#c0765a",
  mongodb: "#13aa52",
  redis: "#d82c20",
  valkey: "#6b4fbb",
  clickhouse: "#e5b800",
};

const templateColors: Record<string, string> = {
  n8n: "#ea4b71",
  "uptime-kuma": "#5cdd8b",
  umami: "#1a1a1a",
  plausible: "#5850ec",
  ghost: "#15171a",
  wordpress: "#21759b",
  minio: "#c72e49",
  gitea: "#609926",
  vaultwarden: "#175ddc",
  metabase: "#509ee3",
  pgadmin: "#336791",
  adminer: "#34567c",
  grafana: "#f46800",
  "code-server": "#007acc",
};

export function ServiceIcon({
  type,
  engine,
  icon,
  source,
  size = "md",
  className,
}: {
  type: string;
  engine?: string | null;
  icon?: string | null;
  source?: "git" | "image" | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const dims = { sm: "size-7 rounded-lg [&_svg]:size-3.5", md: "size-9 rounded-[10px] [&_svg]:size-4", lg: "size-11 rounded-xl [&_svg]:size-5" }[size];
  const color = engine ? engineColors[engine] : icon ? templateColors[icon] : undefined;
  if (color) {
    return (
      <span
        className={cn("flex shrink-0 items-center justify-center text-white shadow-sm", dims, className)}
        style={{ background: `linear-gradient(160deg, color-mix(in oklab, ${color} 88%, white), ${color})` }}
      >
        {engine ? <Database /> : <span className="text-[13px] font-semibold">{(icon ?? "?").slice(0, 1).toUpperCase()}</span>}
      </span>
    );
  }
  const Icon = type === "compose" ? Layers : source === "image" ? Container : source === "git" ? GitBranch : type === "database" ? Database : Box;
  return (
    <span className={cn("flex shrink-0 items-center justify-center border border-line bg-surface-2 text-fg-2 shadow-sm", dims, className)}>
      <Icon />
    </span>
  );
}
