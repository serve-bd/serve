"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, InputGroup } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch";
import { DnsCheck } from "@/components/dns-check";
import { detectIp } from "@/server/actions/server";
import { updateServer } from "@/server/actions/servers";
import { SettingsCard } from "@/app/(app)/settings/_components/settings-card";
import { ProductName } from "@/components/brand";

export function DomainSettings({
  serverId,
  isLocal,
  host,
  addressing,
  ports,
}: {
  serverId: string;
  isLocal: boolean;
  host: string;
  addressing: { publicIp: string; wildcardDomain: string; sslipFallback: boolean };
  ports: { proxyHttpPort: number; proxyHttpsPort: number };
}) {
  const [detecting, setDetecting] = React.useState(false);
  const ip = addressing.publicIp || null;
  return (
    <>
      <SettingsCard
        title="Addressing"
        description="How domains reach this server."
        initial={addressing}
        onSave={(v) => updateServer(serverId, { publicIp: v.publicIp || null, wildcardDomain: v.wildcardDomain || null, sslipFallback: v.sslipFallback })}
      >
        {(v, set) => (
          <>
            <Field
              label="Public IPv4"
              description={
                <>
                  Used for DNS records <ProductName /> creates and for sslip.io domains.
                </>
              }
            >
              <div className="flex gap-2 sm:max-w-sm">
                <Input value={v.publicIp} onChange={(e) => set("publicIp")(e.target.value)} className="font-mono" placeholder={isLocal ? "203.0.113.10" : host} />
                {isLocal ? (
                  <Button
                    loading={detecting}
                    onClick={async () => {
                      setDetecting(true);
                      const r = await detectIp();
                      setDetecting(false);
                      if (r.ok) set("publicIp")(r.data);
                    }}
                  >
                    Detect
                  </Button>
                ) : (
                  /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && (
                    <Button onClick={() => set("publicIp")(host)} disabled={v.publicIp === host}>
                      Use {host}
                    </Button>
                  )
                )}
              </div>
            </Field>
            <Field
              label="Wildcard domain"
              optional
              description={
                <>
                  Point <code className="font-mono">*.{v.wildcardDomain || "apps.example.com"}</code> to this server. New services here get a subdomain.
                </>
              }
            >
              <InputGroup prefix="*.">
                <Input value={v.wildcardDomain} onChange={(e) => set("wildcardDomain")(e.target.value)} placeholder="apps.example.com" />
              </InputGroup>
            </Field>
            {v.wildcardDomain && <DnsCheck host={`serve-check.${v.wildcardDomain}`} serverIp={v.publicIp || ip} />}
            <SwitchRow
              title="Fall back to sslip.io"
              description={
                <>
                  Without a wildcard domain, services get <code className="font-mono">name.{v.publicIp || "<ip>"}.sslip.io</code>.
                </>
              }
              checked={v.sslipFallback}
              onCheckedChange={set("sslipFallback")}
            />
          </>
        )}
      </SettingsCard>
    </>
  );
}
