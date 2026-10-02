"use client";

import * as React from "react";
import { Cloud, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, TimeAgo } from "@/components/ui/misc";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { useCan } from "@/components/permissions";
import { DomainProof } from "@/components/domain-proof";
import { checkDomainOwnership, removeVerifiedDomain } from "@/server/actions/verified-domains";

type Row = { id: string; name: string; method: string; createdAt: string };

/** Domains the organization proved it owns; custom domains under them can be added to services. */
export function VerifiedDomainsCard({ rows }: { rows: Row[] }) {
  const canEdit = useCan()("domains.manage");
  const confirm = useConfirm();
  const [name, setName] = React.useState("");
  const [proof, setProof] = React.useState<{ recordName: string; recordValue: string } | null>(null);
  const check = useAction(() => checkDomainOwnership(name), {
    onSuccess: (r) => {
      if (r.verified) {
        setName("");
        setProof(null);
      } else setProof({ recordName: r.recordName, recordValue: r.recordValue });
    },
  });
  const remove = useAction((id: string) => removeVerifiedDomain(id));

  return (
    <Card>
      <CardHeader title="Verified domains" description="Prove you own a domain once; then add it, or any of its subdomains, to your services." />
      <CardBody className="flex flex-col gap-4 py-5">
        {rows.length > 0 ? (
          <div className="divide-y divide-line rounded-xl border border-line">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-3.5 py-2.5 text-[13px]">
                {r.method === "cloudflare" ? <Cloud className="size-4 flex-none text-[#f38020]" /> : <ShieldCheck className="size-4 flex-none text-ok" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12.5px] text-fg">{r.name}</span>
                  <span className="text-[11px] text-muted">
                    {r.method === "cloudflare" ? "Zone in your Cloudflare account" : "TXT record"} · <TimeAgo date={r.createdAt} />
                  </span>
                </span>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove the verification of ${r.name}`}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Remove the verification of ${r.name}?`,
                          description: "Domains already added keep working. Adding new ones under it needs the proof again.",
                          confirmLabel: "Remove",
                          danger: true,
                        })
                      )
                        remove.run(r.id);
                    }}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-muted">No verified domains yet. Domains in a connected Cloudflare account are verified automatically when you add them.</p>
        )}
        {canEdit && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void check.run();
            }}
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value.trim().toLowerCase());
                  setProof(null);
                }}
                placeholder="example.com"
                className="font-mono text-[13px]"
                aria-label="Domain to verify"
              />
              <Button type="submit" size="sm" className="h-9 sm:w-auto" loading={check.pending} disabled={!name.trim()}>
                <ShieldCheck /> {proof ? "Check again" : "Verify"}
              </Button>
            </div>
            {proof && <DomainProof recordName={proof.recordName} recordValue={proof.recordValue} domain={name} />}
          </form>
        )}
      </CardBody>
    </Card>
  );
}
