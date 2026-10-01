"use client";

import * as React from "react";
import { Globe2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpTip } from "@/components/ui/help-tip";
import { Input } from "@/components/ui/input";
import { Card, CardBody, CardHeader } from "@/components/ui/misc";
import { SecretField } from "@/components/ui/secret-field";
import { toast } from "@/components/ui/toast";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { saveDatabaseDomain } from "@/server/actions/database-domains";

export type DatabaseDomainInfo = {
  supported: boolean;
  hostname: string | null;
  url: string | null;
  /** Port clients use: the engine's usual one, shared by every database on a domain. */
  ports: { port: number; label: string }[];
  certificate: { status: string; error: string | null } | null;
  engineLabel: string;
};

/** Reach the database at db.example.com on the engine's usual port, over TLS. */
export function DatabaseDomainCard({ serviceId, info, hideSecrets, canManage }: { serviceId: string; info: DatabaseDomainInfo; hideSecrets?: boolean; canManage?: boolean }) {
  const [value, setValue] = React.useState(info.hostname ?? "");
  const save = useAction((hostname: string | null) => saveDatabaseDomain(serviceId, hostname), {
    success: (r) => (r.warnings.length ? "Domain saved, one step left" : "Domain saved"),
    onSuccess: (r) => {
      for (const w of r.warnings) toast.warning("Domain", w);
    },
  });
  const changed = value.trim().toLowerCase() !== (info.hostname ?? "");
  const cert = info.certificate;
  const portText = info.ports.map((p) => (info.ports.length > 1 ? `${p.port} (${p.label})` : String(p.port))).join(" and ");

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            Domain
            <HelpTip label="How database domains work">
              One router on this server listens on port {portText} for every database with a domain. It reads the domain from the TLS handshake and sends the connection to the
              right database, so many databases share the same port. Clients must connect with TLS.
            </HelpTip>
          </span>
        }
        description={info.supported ? `Connect from anywhere at your own domain, on port ${portText}, with a real certificate.` : undefined}
      />
      <CardBody className="flex flex-col gap-4">
        {!info.supported ? (
          <p className="text-[13px] leading-relaxed text-muted">
            {info.engineLabel} cannot share a port by domain: its server speaks first, before the client sends a name. Use Public access with its own port, and point a DNS name at
            the server if you like.
          </p>
        ) : (
          <>
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                if (changed) void save.run(value.trim() || null);
              }}
            >
              <Field label="Domain" className="min-w-0 flex-1">
                <Input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="db.example.com"
                  className="font-mono text-[13px]"
                  spellCheck={false}
                  disabled={canManage === false}
                />
              </Field>
              <div className="flex gap-2">
                {info.hostname && (
                  <Button type="button" variant="ghost" size="sm" className="h-9" disabled={canManage === false} loading={save.pending && !value} onClick={() => save.run(null)}>
                    Remove
                  </Button>
                )}
                <Button type="submit" variant="primary" size="sm" className="h-9" disabled={!changed || canManage === false} loading={save.pending && !!value}>
                  <Globe2 /> Save
                </Button>
              </div>
            </form>
            {info.hostname && (
              <>
                <p className="flex items-center gap-2 text-[13px]">
                  <Lock className="size-3.5 text-muted" />
                  <span className={cn(cert?.status === "active" ? "text-ok" : cert?.status === "failed" ? "text-bad" : "text-muted")}>
                    {cert?.status === "active"
                      ? "Certificate active"
                      : cert?.status === "failed"
                        ? `Certificate failed${cert.error ? `: ${cert.error.split("\n")[0].slice(0, 160)}` : ""}`
                        : cert
                          ? "Getting a certificate…"
                          : "No certificate yet"}
                  </span>
                </p>
                {info.url && (
                  <Field label="Connection URL" description="Clients must use TLS. Connections without TLS carry no domain name and are not routed.">
                    <SecretField value={info.url} hidden={hideSecrets} shape={info.url} />
                  </Field>
                )}
              </>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
