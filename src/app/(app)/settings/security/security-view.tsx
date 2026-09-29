"use client";

import Link from "next/link";
import { ArrowRight, CircleCheck, Info, Plus, TriangleAlert } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import type { SecurityCheck } from "@/server/security-checks";
import { cn } from "@/lib/utils";
import { SettingsCard } from "../_components/settings-card";

const ICON = {
  ok: <CircleCheck className="size-4 text-ok" />,
  warn: <TriangleAlert className="size-4 text-warn" />,
  info: <Info className="size-4 text-info" />,
};

const ORDER = { warn: 0, info: 1, ok: 2 };

export function SecurityView({
  checks,
  allowlist,
  dashboardDomain,
  viewerIp,
}: {
  checks: SecurityCheck[];
  allowlist: string[];
  dashboardDomain: string | null;
  viewerIp: string | null;
}) {
  const warnings = checks.filter((c) => c.status === "warn").length;
  const sorted = [...checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]);

  return (
    <>
      <Card>
        <CardHeader
          title="Security review"
          description={
            warnings ? `${warnings} thing${warnings === 1 ? "" : "s"} to fix. Checked each time you open this page.` : "Nothing to fix. Checked each time you open this page."
          }
        />
        <ul className="divide-y divide-line">
          {sorted.map((c) => (
            <li key={c.id} className={cn("flex flex-wrap items-start gap-x-3 gap-y-2.5 px-5 py-3.5 sm:flex-nowrap", c.status === "warn" && "bg-warn-soft/40")}>
              <span className="mt-0.5 flex-none">{ICON[c.status]}</span>
              <div className="flex min-w-0 flex-1 basis-[calc(100%-2rem)] flex-col gap-0.5 sm:basis-auto">
                <span className="text-[13.5px] font-medium text-fg">{c.title}</span>
                <span className="text-[12.5px] leading-relaxed text-muted">{c.detail}</span>
              </div>
              {c.href && c.status === "warn" && (
                <Link href={c.href} className={buttonVariants({ size: "xs", className: "ml-7 flex-none sm:ml-0" })}>
                  {c.action ?? "Fix"} <ArrowRight />
                </Link>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <SettingsCard
        title="Dashboard access"
        description={
          dashboardDomain ? (
            <>
              Only these IP addresses or ranges can open <span className="font-medium text-fg-2">{dashboardDomain}</span>. Leave empty to allow everyone.
            </>
          ) : (
            "Set a dashboard domain first. The list applies to the dashboard domain only."
          )
        }
        initial={{ dashboardAllowlist: allowlist }}
        transform={(v) => ({ dashboardAllowlist: [...new Set(v.dashboardAllowlist.map((l) => l.trim()).filter(Boolean))] })}
        footerNote={allowlist.length ? `${allowlist.length} allowed` : "Everyone allowed"}
      >
        {(v, set) => {
          const lines = v.dashboardAllowlist;
          const entries = lines.map((l) => l.trim()).filter(Boolean);
          const hasViewer = !!viewerIp && entries.includes(viewerIp);
          return (
            <>
              <Field label="Allowed addresses" description="One per line, like 203.0.113.7 or 10.0.0.0/8.">
                <Textarea
                  value={lines.join("\n")}
                  onChange={(e) => set("dashboardAllowlist")(e.target.value.split("\n"))}
                  rows={5}
                  spellCheck={false}
                  placeholder={"203.0.113.7\n10.0.0.0/8"}
                  className="font-mono text-[12.5px]"
                />
              </Field>
              {viewerIp && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2 px-3.5 py-2.5 text-[13px]">
                  <span className="text-muted">
                    Your address: <code className="font-mono text-fg-2">{viewerIp}</code>
                  </span>
                  {!hasViewer && (
                    <Button size="xs" onClick={() => set("dashboardAllowlist")([...entries, viewerIp])}>
                      <Plus /> Add my IP
                    </Button>
                  )}
                </div>
              )}
              {entries.length > 0 && (
                <p className="flex items-start gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-fg-2">
                  <TriangleAlert className="mt-0.5 size-3.5 flex-none text-warn" />
                  <span>
                    {viewerIp && !hasViewer ? "Your address is not in the list, so saving locks you out of the domain. " : ""}
                    If you get locked out, open the dashboard on its port (:8000) and clear this list. Behind Cloudflare&apos;s proxy, visitors appear with Cloudflare addresses.
                  </span>
                </p>
              )}
            </>
          );
        }}
      </SettingsCard>
    </>
  );
}
