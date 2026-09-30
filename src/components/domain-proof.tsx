"use client";

import { ShieldCheck } from "lucide-react";
import { CopyButton } from "@/components/ui/misc";

/** The TXT record an organization adds to prove it controls a domain. */
export function DomainProof({ recordName, recordValue, domain }: { recordName: string; recordValue: string; domain?: string }) {
  const rows = [
    { label: "Type", value: "TXT", copy: false },
    { label: "Name", value: recordName, copy: true },
    { label: "Value", value: recordValue, copy: true },
  ];
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-3">
      <p className="flex items-start gap-2 text-[13px] text-fg-2">
        <ShieldCheck className="mt-0.5 size-4 flex-none text-warn" />
        <span>
          <span className="font-medium text-fg">Prove you own {domain ?? "this domain"}.</span> Add this DNS record, then check again. A record on a parent domain, like{" "}
          <span className="font-mono text-[12px]">_serve-verify.example.com</span>, covers all its subdomains.
        </span>
      </p>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0">
            <span className="w-11 flex-none text-[11px] font-medium text-faint">{r.label}</span>
            <span className="min-w-0 flex-1 font-mono text-[12px] break-all text-fg">{r.value}</span>
            {r.copy && <CopyButton value={r.value} />}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted">New records can take a few minutes to show up.</p>
    </div>
  );
}
