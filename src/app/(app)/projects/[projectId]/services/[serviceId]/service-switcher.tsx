"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Check, ChevronsUpDown } from "lucide-react";
import { Menu, MenuContent, MenuLabel, MenuLinkItem, MenuTrigger } from "@/components/ui/menu";
import { ServiceIcon } from "@/components/service-icon";
import { StatusDot } from "@/components/ui/status";

export type SiblingService = {
  id: string;
  name: string;
  type: string;
  icon: string | null;
  engine: string | null;
  sourceType: "git" | "image" | "dockerfile" | null;
  status: string;
};

/** Tabs a service of this type has, so switching can keep the one in view. */
function hasTab(type: string, tab: string, engine: string | null) {
  if (tab === "branches") return type === "database";
  if (tab === "data") return type === "database";
  if (tab === "users") return type === "database" && ["postgres", "mysql", "mariadb", "mongodb"].includes(engine ?? "");
  if (tab === "domains" || tab === "tasks") return type !== "database";
  return true;
}

/** The service's name in the breadcrumb, opening a list of the other services in its environment. */
export function ServiceSwitcher({ projectId, current, services }: { projectId: string; current: SiblingService; services: SiblingService[] }) {
  const pathname = usePathname();
  // Same tab on the other service (a deployment's page falls back to the list).
  const tab = pathname.split(`/services/${current.id}/`)[1]?.split("/")[0] ?? "";
  const hrefOf = (s: SiblingService) => `/projects/${projectId}/services/${s.id}${tab && hasTab(s.type, tab, s.engine) ? `/${tab}` : ""}`;

  if (services.length < 2) return <span className="truncate text-fg-2">{current.name}</span>;
  return (
    <Menu>
      <MenuTrigger className="-mx-1.5 flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-fg-2 outline-none transition-colors hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg focus-visible:ring-2 focus-visible:ring-accent/40">
        <span className="truncate">{current.name}</span>
        <ChevronsUpDown className="size-3.5 flex-none text-faint" />
      </MenuTrigger>
      <MenuContent align="start" className="max-h-[min(24rem,70vh)] w-64 overflow-y-auto">
        <MenuLabel>Services</MenuLabel>
        {services.map((s) => (
          <MenuLinkItem key={s.id} render={<Link href={hrefOf(s)} />} className="gap-2.5">
            <ServiceIcon type={s.type} engine={s.engine} icon={s.icon} source={s.sourceType} size="sm" />
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            {s.id === current.id ? <Check className="flex-none text-accent!" /> : <StatusDot status={s.status} className="flex-none" />}
          </MenuLinkItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
