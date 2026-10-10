import { Server } from "lucide-react";
import type { ServiceCardData } from "@/server/project-data";

/** An app that runs on more than one server: "+ hetzner", or "+2 servers", naming them all on hover. */
export function ServersChip({ s }: { s: Pick<ServiceCardData, "serverName" | "alsoOn"> }) {
  if (!s.alsoOn.length) return null;
  return (
    <span
      title={`Runs on ${[s.serverName, ...s.alsoOn.map((o) => o.name)].join(", ")}`}
      className="flex flex-none items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 py-px text-[10.5px] font-medium text-muted"
    >
      <Server className="size-3" />
      {s.alsoOn.length === 1 ? `+ ${s.alsoOn[0].name}` : `+${s.alsoOn.length} servers`}
    </span>
  );
}
