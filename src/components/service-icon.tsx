import { Box, Container, Database, GitBranch, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { templateBrand } from "@/lib/template-brand";

const engineColors: Record<string, string> = {
  postgres: "#336791",
  mysql: "#00758f",
  mariadb: "#c0765a",
  mongodb: "#13aa52",
  redis: "#d82c20",
  valkey: "#6b4fbb",
  clickhouse: "#e5b800",
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
  const brand = !engine && icon && !icon.startsWith("custom:") ? templateBrand(icon) : null;
  const color = engine ? engineColors[engine] : brand?.color;
  if (color) {
    return (
      <span
        className={cn("flex shrink-0 items-center justify-center text-white shadow-sm", dims, className)}
        style={{ background: `linear-gradient(160deg, color-mix(in oklab, ${color} 88%, white), ${color})` }}
      >
        {engine ? (
          <Database />
        ) : brand?.logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- tiny static SVG
          <img src={brand.logo} alt="" className="size-[55%]" draggable={false} />
        ) : (
          <span className="text-[13px] font-semibold">{(icon ?? "?").slice(0, 1).toUpperCase()}</span>
        )}
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
