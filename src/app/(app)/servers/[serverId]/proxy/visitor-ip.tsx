"use client";

import * as React from "react";
import { useRouter } from "@/hooks/use-router";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { saveTrustedProxies } from "@/server/actions/server-proxy";
import { CLIENT_IP_HEADERS, clientIpHeaderNames, normalizeTrustedRanges, type ClientIpHeader, type TrustedProxies } from "@/lib/trusted-proxies";
import type { RunningKind } from "@/server/proxy/config";
import { ErrorBox } from "./dynamic-configs";

const headerHints: Record<ClientIpHeader, string> = {
  "x-forwarded-for": "Recommended. Every proxy and CDN sets it, Cloudflare too; chains are read right to left.",
  "x-real-ip": "When your load balancer sets only this header.",
  "cf-connecting-ip": "Only when Cloudflare is the only proxy in front.",
  "true-client-ip": "When your CDN sets this header.",
};

type Form = { on: boolean; ranges: string; header: ClientIpHeader; cloudflare: boolean };

const formOf = (t: TrustedProxies | null): Form => ({ on: !!t, ranges: (t?.ranges ?? []).join("\n"), header: t?.header ?? "x-forwarded-for", cloudflare: t?.cloudflare ?? false });

/** Proxies in front of the server (a CDN or load balancer) whose visitor IP header the proxy believes. */
export function VisitorIpCard({ serverId, kind, initial, disabled }: { serverId: string; kind: RunningKind; initial: TrustedProxies | null; disabled: boolean }) {
  const router = useRouter();
  const [value, setValue] = React.useState(() => formOf(initial));
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const dirty = JSON.stringify(value) !== JSON.stringify(formOf(initial));
  const set = (patch: Partial<Form>) => setValue((v) => ({ ...v, ...patch }));
  const parsed = normalizeTrustedRanges(value.ranges.split("\n"));
  const rangeError = "error" in parsed ? parsed.error : null;
  const count = "ranges" in parsed ? parsed.ranges.length : 0;
  const empty = value.on && !rangeError && !count && !value.cloudflare;

  const save = async () => {
    setPending(true);
    setError(null);
    const res = await saveTrustedProxies(serverId, value.on ? { ranges: value.ranges.split("\n"), header: value.header, cloudflare: value.cloudflare } : null);
    setPending(false);
    if (!res.ok) return setError(res.error);
    toast.success(value.on ? "Trusted proxies applied" : "Trusted proxies turned off");
    router.refresh();
  };

  return (
    <Card>
      <CardHeader
        title="Visitor IP"
        description="With a CDN or load balancer in front of this server, sites see its address instead of the visitor's. Trust it here so logs, allow lists and rate limits get the real visitor IP. Cloudflare Tunnel needs nothing here."
      />
      <CardBody className="flex flex-col gap-4 py-5">
        <SwitchRow
          title="Trust proxies in front of this server"
          description={value.on ? "Requests from the addresses below may set the visitor IP." : "Off: only Cloudflare Tunnel traffic carries the visitor IP."}
          checked={value.on}
          onCheckedChange={(on) => set({ on })}
          disabled={disabled}
        />
        {value.on && (
          <>
            <Field
              label="Proxy addresses"
              description="One per line: the IPs or ranges your CDN or load balancer connects from, like 203.0.113.0/24 or 10.0.0.5."
              error={rangeError ?? (empty ? "Add the addresses of your proxy, or choose Cloudflare below." : null)}
            >
              <Textarea
                value={value.ranges}
                onChange={(e) => set({ ranges: e.target.value })}
                rows={4}
                spellCheck={false}
                placeholder={"203.0.113.0/24\n10.0.0.5"}
                className="font-mono text-[12.5px]"
                disabled={disabled}
              />
            </Field>
            <label className="flex items-start gap-2 text-[13px] text-fg-2">
              <Checkbox checked={value.cloudflare} onCheckedChange={(c) => set({ cloudflare: !!c })} disabled={disabled} className="mt-0.5" />
              <span>
                I use Cloudflare&apos;s proxy (orange cloud)
                <span className="block text-xs text-muted">
                  Trusts Cloudflare&apos;s published addresses, kept up to date. Not needed without Cloudflare, for DNS-only records or for a tunnel.
                </span>
              </span>
            </label>
            <Field label="Visitor IP header" description={kind === "traefik" ? "Traefik reads X-Forwarded-For only." : headerHints[value.header]}>
              <Select
                value={kind === "traefik" ? "x-forwarded-for" : value.header}
                onValueChange={(h) => set({ header: h as ClientIpHeader })}
                options={CLIENT_IP_HEADERS.map((h) => ({ value: h, label: clientIpHeaderNames[h] }))}
                disabled={disabled || kind === "traefik"}
                aria-label="Visitor IP header"
                className="sm:max-w-xs"
              />
            </Field>
            {kind === "caddy" && (value.header === "x-real-ip" || value.header === "true-client-ip") && (
              <p className="text-xs leading-relaxed text-muted">Caddy reads one header for all traffic, so Cloudflare Tunnel visitors then show the tunnel&apos;s address.</p>
            )}
            <p className="flex items-start gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-fg-2">
              <TriangleAlert className="mt-0.5 size-3.5 flex-none text-warn" />
              <span>
                Every host in these ranges can set any visitor IP. List only proxies you control.
                {kind === "traefik" ? " On Traefik, deny lists and maintenance allow lists still match the proxy's address." : ""}
              </span>
            </p>
          </>
        )}
        {error && <ErrorBox message={error} />}
      </CardBody>
      <CardFooter>
        <span className="truncate text-xs text-muted">{dirty ? "Unsaved changes" : "Validated by the proxy before it applies"}</span>
        <div className="flex flex-none gap-2">
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => (setValue(formOf(initial)), setError(null))}>
              Discard
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={save} disabled={!dirty || disabled || (value.on && (!!rangeError || empty))} loading={pending}>
            Test and apply
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
