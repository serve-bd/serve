"use client";

import * as React from "react";
import { Bell, ExternalLink, Eye, Megaphone, Palette, Rows3, Settings2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tab, Tabs, TabsList, TabsPanel } from "@/components/ui/tabs";
import { useAction } from "@/hooks/use-action";
import { setStatusVisibility } from "@/server/actions/status-pages";
import type { EditorData } from "@/server/status-pages/admin";
import { ComponentsTab } from "./components-tab";
import { NoticesTab } from "./notices-tab";
import { DesignTab } from "./design-tab";
import { SettingsTab } from "./settings-tab";
import { SubscribersTab } from "./subscribers-tab";
import { cn } from "@/lib/utils";

const TABS = ["components", "incidents", "subscribers", "design", "settings"] as const;
type TabKey = (typeof TABS)[number];

export type PoweredBy = { name: string; url: string | null };

export function StatusPageEditor({ data, canManage, poweredBy, tab }: { data: EditorData; canManage: boolean; poweredBy: PoweredBy; tab?: string }) {
  const [current, setCurrent] = React.useState<TabKey>((TABS as readonly string[]).includes(tab ?? "") ? (tab as TabKey) : "components");
  const publish = useAction(() => setStatusVisibility(data.page.id, { visibility: "public" }));
  const open = data.notices.filter((n) => n.kind === "incident" && !n.resolvedAt).length;

  const pick = (value: TabKey) => {
    setCurrent(value);
    // Kept in the address: a reload or a shared link opens the same tab.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", value);
    window.history.replaceState(window.history.state, "", url);
  };

  return (
    <div className="flex flex-col gap-5">
      {data.page.visibility === "draft" && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
          <Eye className="size-4 flex-none text-muted" />
          <p className="min-w-0 flex-1 text-[13px] text-fg-2">This page is a draft. Only members of your organization can open it.</p>
          {canManage && (
            <Button size="sm" variant="primary" loading={publish.pending} onClick={() => publish.run()}>
              Publish
            </Button>
          )}
        </div>
      )}
      <Tabs value={current} onValueChange={(v) => pick(v as TabKey)}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <Tab value="components">
              <Rows3 /> Components
            </Tab>
            <Tab value="incidents">
              <Megaphone /> Incidents
              {open > 0 && <span className="ml-0.5 rounded-full bg-bad px-1.5 text-[11px] leading-[18px] font-semibold text-white tabular-nums">{open}</span>}
            </Tab>
            <Tab value="subscribers">
              <Bell /> Subscribers
              {data.subscriberCounts.confirmed > 0 && <span className="ml-0.5 text-[11px] text-muted tabular-nums">{data.subscriberCounts.confirmed}</span>}
            </Tab>
            <Tab value="design">
              <Palette /> Design
            </Tab>
            <Tab value="settings">
              <Settings2 /> Settings
            </Tab>
          </TabsList>
          <a href={data.page.url} target="_blank" rel="noopener" className={cn(buttonVariants({ size: "sm" }))}>
            <ExternalLink /> Open page
          </a>
        </div>
        <TabsPanel value="components" className="mt-5">
          <ComponentsTab data={data} canManage={canManage} />
        </TabsPanel>
        <TabsPanel value="incidents" className="mt-5">
          <NoticesTab data={data} canManage={canManage} />
        </TabsPanel>
        <TabsPanel value="subscribers" className="mt-5">
          <SubscribersTab data={data} canManage={canManage} />
        </TabsPanel>
        <TabsPanel value="design" className="mt-5">
          <DesignTab data={data} canManage={canManage} poweredBy={poweredBy} />
        </TabsPanel>
        <TabsPanel value="settings" className="mt-5">
          <SettingsTab data={data} canManage={canManage} />
        </TabsPanel>
      </Tabs>
    </div>
  );
}
