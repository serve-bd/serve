"use client";

import * as React from "react";
import Link from "next/link";
import useSWR from "swr";
import { AlertTriangle, ArrowUpRight, CheckCircle2, ChevronDown, CircleDashed, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton, CopyField, TimeAgo } from "@/components/ui/misc";
import { useAction } from "@/hooks/use-action";
import { checkDashboardConnection, fixDashboardConnection, type ConnectionStep } from "@/server/actions/dashboard-domain";
import { cn } from "@/lib/utils";

const icons: Record<ConnectionStep["state"], React.ReactNode> = {
  ok: <CheckCircle2 className="size-[18px] text-ok" />,
  warn: <AlertTriangle className="size-[18px] text-warn" />,
  fail: <XCircle className="size-[18px] text-bad" />,
  skip: <CircleDashed className="size-[18px] text-faint" />,
};

const _placeholders: Record<"ip" | "tunnel", { id: string; title: string }[]> = {
  ip: [
    { id: "dns", title: "DNS" },
    { id: "proxy", title: "Proxy" },
    { id: "upstream", title: "Dashboard reachable from the proxy" },
    { id: "https", title: "HTTPS" },
  ],
  tunnel: [
    { id: "dns", title: "DNS" },
    { id: "tunnel", title: "Cloudflare Tunnel" },
    { id: "proxy", title: "Proxy" },
    { id: "upstream", title: "Dashboard reachable from the proxy" },
    { id: "https", title: "HTTPS" },
  ],
};

/** Live checklist for the saved dashboard domain: DNS → tunnel → proxy → Serve → end to end. */
export function ConnectionCheck({ domain, tunnel }: { domain: string; tunnel: boolean }) {
  const { data, isValidating, mutate } = useSWR(
    ["dashboard-connection", domain, tunnel],
    async () => {
      const res = await checkDashboardConnection();
      if (!res.ok) throw new Error(res.error);
      return res.data;
    },
    {
      // Keep polling until every step is green, so fixes made elsewhere show up on their own.
      refreshInterval: (d) => (d?.steps.every((s) => s.state === "ok" || s.state === "skip") ? 0 : 6000),
      revalidateOnFocus: true,
    },
  );
  const steps = data?.domain === domain ? data.steps : null;
  const done = steps?.filter((s) => s.state === "ok").length ?? 0;
  const failing = steps?.some((s) => s.state === "fail");
  const allGood = steps !== null && !steps.some((s) => s.state === "fail" || s.state === "warn");
  const url = `https://${domain}`;

  const [showAll, setShowAll] = React.useState(false);
  // Problems always show their steps; a working domain folds into one line.
  const expanded = showAll || (steps !== null && !allGood);

  return (
    <div
      className={cn("overflow-hidden rounded-xl border", steps === null ? "border-line" : allGood ? "border-ok/25 bg-ok-soft/40" : failing ? "border-bad/25" : "border-warn/25")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5">
        <span className="flex-none">{steps === null ? <Loader2 className="size-[18px] animate-spin text-faint" /> : allGood ? icons.ok : failing ? icons.fail : icons.warn}</span>
        <p className="min-w-0 flex-1 text-[13px] text-fg-2">
          {steps === null ? (
            `Checking how ${domain} reaches this dashboard…`
          ) : allGood ? (
            <>
              <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-fg hover:text-accent">
                {domain}
                <ArrowUpRight className="size-3.5" />
              </a>{" "}
              works
              {data && (
                <span className="text-muted">
                  {" "}
                  · checked <TimeAgo date={data.checkedAt} />
                </span>
              )}
            </>
          ) : (
            <>
              <span className="font-medium text-fg">
                {done} of {steps.length} checks pass
              </span>
              {failing && <span className="text-muted"> · checking again every few seconds</span>}
            </>
          )}
        </p>
        <div className="flex flex-none items-center gap-1">
          {allGood && (
            <Button type="button" size="xs" variant="ghost" onClick={() => setShowAll((o) => !o)} aria-expanded={showAll}>
              Details <ChevronDown className={cn("transition-transform", showAll && "rotate-180")} />
            </Button>
          )}
          <Button type="button" size="xs" variant="ghost" onClick={() => void mutate()} loading={isValidating && steps !== null} aria-label="Check again">
            {!(isValidating && steps !== null) && <RefreshCw />}
          </Button>
        </div>
      </div>
      {expanded && steps && (
        <ol className="divide-y divide-line border-t border-line bg-surface">
          {steps.map((s) => (
            <StepRow key={s.id} step={s} onFixed={() => void mutate()} />
          ))}
        </ol>
      )}
    </div>
  );
}

function StepRow({ step, onFixed }: { step: ConnectionStep; onFixed: () => void }) {
  const hasMore = !!(step.detail || step.records?.length || step.command);
  // Problems start open; the user can still fold them.
  const [open, setOpen] = React.useState<boolean | null>(null);
  const expanded = open ?? (step.state === "fail" || step.state === "warn");
  const fix = useAction(fixDashboardConnection, { refresh: false, onSuccess: onFixed });

  return (
    <li className="px-5 py-3.5">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-px flex-none" role="img" aria-label={step.state}>
          {icons[step.state]}
        </span>
        <button
          type="button"
          disabled={!hasMore}
          onClick={() => setOpen(!expanded)}
          className={cn("flex min-w-0 flex-1 flex-col items-start text-left", hasMore && "cursor-pointer")}
          aria-expanded={hasMore ? expanded : undefined}
        >
          <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
            {step.title}
            {hasMore && <ChevronDown className={cn("size-3.5 text-faint transition-transform", expanded && "rotate-180")} />}
          </span>
          <span className={cn("mt-0.5 text-[13px]", step.state === "fail" ? "text-bad" : step.state === "warn" ? "text-warn" : "text-muted")}>{step.summary}</span>
        </button>
        <div className="flex flex-none items-center gap-2">
          {step.link && (
            <Link href={step.link.href} className="hidden text-xs text-muted hover:text-fg sm:inline">
              {step.link.label}
            </Link>
          )}
          {step.fix && (
            <Button size="xs" variant="primary" loading={fix.pending} onClick={() => void fix.run(step.fix!.action)}>
              {step.fix.label}
            </Button>
          )}
        </div>
      </div>
      {hasMore && expanded && (
        <div className="mt-3 ml-[30px] flex flex-col gap-3">
          {step.detail && <p className="text-[13px] leading-relaxed text-fg-2">{step.detail}</p>}
          {step.records && step.records.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-line">
              <div className="hidden grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1.4fr)] gap-3 bg-surface-2 px-3.5 py-2 text-[11px] font-medium tracking-wide text-faint uppercase sm:grid">
                <span>Type</span>
                <span>Name</span>
                <span>Value</span>
              </div>
              {step.records.map((r) => (
                <div
                  key={r.type + r.name}
                  className="flex flex-col gap-1.5 border-line px-3.5 py-2.5 font-mono text-[12.5px] text-fg-2 not-first:border-t sm:grid sm:grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1.4fr)] sm:items-center sm:gap-3 sm:border-t"
                >
                  <span>
                    <span className="mr-2 font-sans text-[11px] text-faint uppercase sm:hidden">Type</span>
                    {r.type}
                  </span>
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="mr-1 font-sans text-[11px] text-faint uppercase sm:hidden">Name</span>
                    <span className="truncate">{r.name}</span>
                    <CopyButton value={r.name} />
                  </span>
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="mr-1 font-sans text-[11px] text-faint uppercase sm:hidden">Value</span>
                    <span className="truncate">{r.value}</span>
                    <CopyButton value={r.value} />
                  </span>
                </div>
              ))}
            </div>
          )}
          {step.command && <CopyField value={step.command} />}
          {step.link && (
            <Link href={step.link.href} className="text-xs text-accent hover:underline sm:hidden">
              {step.link.label}
            </Link>
          )}
        </div>
      )}
    </li>
  );
}
