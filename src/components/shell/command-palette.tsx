"use client";

import * as React from "react";
import { useRouter } from "@/hooks/use-router";
import { Command } from "cmdk";
import useSWR from "swr";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import {
  Activity,
  Blocks,
  Box,
  Cloud,
  Database,
  FolderGit2,
  Globe,
  Layers,
  LayoutGrid,
  Plus,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Users,
  KeyRound,
  Waypoints,
} from "lucide-react";
import { StatusDot } from "@/components/ui/status";
import { projectColor } from "./project-color";

type Ctx = { open: boolean; setOpen: (open: boolean) => void };
const PaletteContext = React.createContext<Ctx>({ open: false, setOpen: () => {} });
export const useCommandPalette = () => React.useContext(PaletteContext);

type SearchResult = {
  services: { id: string; name: string; type: string; status: string; projectId: string; projectName: string }[];
};

const itemClass =
  "flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-fg-2 select-none data-[selected=true]:bg-hover data-[selected=true]:text-fg [&_svg]:size-4 [&_svg]:text-muted";

export function CommandPalette({
  children,
  projects,
  isInstanceAdmin,
}: {
  children: React.ReactNode;
  projects: { id: string; name: string; color: string }[];
  isInstanceAdmin: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  const { data } = useSWR<SearchResult>(open ? "/api/search" : null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const icon = (type: string) => (type === "database" ? <Database /> : type === "compose" ? <Layers /> : <Box />);

  return (
    <PaletteContext.Provider value={{ open, setOpen }}>
      {children}
      <BaseDialog.Root open={open} onOpenChange={setOpen}>
        <BaseDialog.Portal>
          <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-[var(--backdrop)] transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <BaseDialog.Viewport className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[14vh]">
            <BaseDialog.Popup className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface shadow-lg outline-none transition-[transform,opacity] duration-150 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0">
              <BaseDialog.Title className="sr-only">Search</BaseDialog.Title>
              <Command loop className="flex flex-col">
                <div className="flex items-center gap-2.5 border-b border-line px-4">
                  <Search className="size-4 text-faint" />
                  <Command.Input
                    autoFocus
                    placeholder="Search projects, services, pages…"
                    className="h-12 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint"
                  />
                </div>
                <Command.List className="scrollbar-thin max-h-[min(60vh,420px)] overflow-y-auto p-2">
                  <Command.Empty className="px-3 py-8 text-center text-[13px] text-muted">No results.</Command.Empty>

                  {!!data?.services.length && (
                    <Command.Group
                      heading="Services"
                      className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint [&_[cmdk-group-heading]]:uppercase"
                    >
                      {data.services.map((s) => (
                        <Command.Item
                          key={s.id}
                          value={`${s.name} ${s.projectName} ${s.id}`}
                          onSelect={() => go(`/projects/${s.projectId}/services/${s.id}`)}
                          className={itemClass}
                        >
                          {icon(s.type)}
                          <span className="flex-1 truncate">{s.name}</span>
                          <span className="text-xs text-faint">{s.projectName}</span>
                          <StatusDot status={s.status} />
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}

                  {projects.length > 0 && (
                    <Command.Group
                      heading="Projects"
                      className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint [&_[cmdk-group-heading]]:uppercase"
                    >
                      {projects.map((p) => (
                        <Command.Item key={p.id} value={`project ${p.name} ${p.id}`} onSelect={() => go(`/projects/${p.id}`)} className={itemClass}>
                          <span className="size-2.5 rounded-[3px]" style={{ background: projectColor(p.color) }} />
                          {p.name}
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}

                  <Command.Group
                    heading="Go to"
                    className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint [&_[cmdk-group-heading]]:uppercase"
                  >
                    <Command.Item onSelect={() => go("/projects/new")} className={itemClass}>
                      <Plus /> New project
                    </Command.Item>
                    <Command.Item onSelect={() => go("/")} className={itemClass}>
                      <LayoutGrid /> Overview
                    </Command.Item>
                    <Command.Item onSelect={() => go("/projects")} className={itemClass}>
                      <Blocks /> Projects
                    </Command.Item>
                    <Command.Item onSelect={() => go("/domains")} className={itemClass}>
                      <Globe /> Domains
                    </Command.Item>
                    <Command.Item onSelect={() => go("/certificates")} className={itemClass}>
                      <ShieldCheck /> Certificates
                    </Command.Item>
                    <Command.Item onSelect={() => go("/integrations/cloudflare")} className={itemClass}>
                      <Cloud /> Cloudflare
                    </Command.Item>
                    <Command.Item onSelect={() => go("/integrations/git")} className={itemClass}>
                      <FolderGit2 /> Git providers
                    </Command.Item>
                    <Command.Item onSelect={() => go("/organization/members")} className={itemClass}>
                      <Users /> Members
                    </Command.Item>
                    <Command.Item onSelect={() => go("/keys")} className={itemClass}>
                      <KeyRound /> Keys &amp; tokens
                    </Command.Item>
                    <Command.Item onSelect={() => go("/activity")} className={itemClass}>
                      <Activity /> Activity
                    </Command.Item>
                    {isInstanceAdmin && (
                      <Command.Item onSelect={() => go("/servers")} className={itemClass}>
                        <Server /> Servers
                      </Command.Item>
                    )}
                    {isInstanceAdmin && (
                      <Command.Item onSelect={() => go("/private-networks")} className={itemClass}>
                        <Waypoints /> Private networks
                      </Command.Item>
                    )}
                    {isInstanceAdmin && (
                      <Command.Item onSelect={() => go("/settings")} className={itemClass}>
                        <Settings /> Settings
                      </Command.Item>
                    )}
                  </Command.Group>
                </Command.List>
              </Command>
            </BaseDialog.Popup>
          </BaseDialog.Viewport>
        </BaseDialog.Portal>
      </BaseDialog.Root>
    </PaletteContext.Provider>
  );
}
