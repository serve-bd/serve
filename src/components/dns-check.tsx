"use client";

import * as React from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { checkDns } from "@/server/actions/server";

/** Resolves a hostname and says whether it points to the given server IP. */
export function DnsCheck({ host, serverIp }: { host: string; serverIp: string | null }) {
  const [result, setResult] = React.useState<{ host: string; records: string[]; pointsHere: boolean } | null>(null);
  const [pending, setPending] = React.useState(false);
  if (!host) return null;
  const current = result?.host === host ? result : null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Button
        size="xs"
        loading={pending}
        onClick={async () => {
          setPending(true);
          const r = await checkDns(host).finally(() => setPending(false));
          // Compare against the server this domain belongs to, not only the local one.
          if (r.ok) setResult({ host, records: r.data.records, pointsHere: serverIp ? r.data.records.includes(serverIp) : r.data.pointsHere });
        }}
      >
        Check DNS
      </Button>
      {current &&
        (current.pointsHere ? (
          <span className="flex items-center gap-1 text-ok">
            <CheckCircle2 className="size-3.5" /> Points to this server
          </span>
        ) : (
          <span className="flex items-center gap-1 text-warn">
            <XCircle className="size-3.5" />
            {current.records.length ? `Points to ${current.records.join(", ")}` : "No A record found"}
            {serverIp ? `, expected ${serverIp}` : ""}
          </span>
        ))}
    </div>
  );
}
