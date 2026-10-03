"use client";

import * as React from "react";
import { Check, Globe2, Lock, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpTip } from "@/components/ui/help-tip";
import { Input } from "@/components/ui/input";
import { Card, CardBody, CardHeader, CopyField } from "@/components/ui/misc";
import { SecretField } from "@/components/ui/secret-field";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { saveDatabaseDomain } from "@/server/actions/database-domains";
import type { ActionResult } from "@/server/action";

export type DatabaseDomainInfo = {
  supported: boolean;
  /** Serve can turn on TLS for this engine, so it can take a domain on its own port. */
  directSupported: boolean;
  /** The server's public IP: a domain on its own port is then ready with nothing to run on clients. */
  publicIp: string | null;
  /** The addresses let through the public port (Public access's list): empty is everyone. */
  allow: string[];
  via: "direct" | "tunnel";
  tunnels: { id: string; label: string }[];
  /** What a client runs to reach a tunnel domain, and the URL it then uses. */
  tunnelCommand: string | null;
  localUrl: string;
  hostname: string | null;
  url: string | null;
  /** The database's own public port, which the domain leads to. */
  port: number | null;
  /** Public access or TLS was turned off after the domain was set. */
  unreachable: boolean;
  certificate: { status: string; error: string | null } | null;
  engine: string;
  engineLabel: string;
};

/** Reach the database at db.example.com on its own port, over TLS with the domain's certificate. */
export function DatabaseDomainCard({ serviceId, info, hideSecrets, canManage }: { serviceId: string; info: DatabaseDomainInfo; hideSecrets?: boolean; canManage?: boolean }) {
  const [value, setValue] = React.useState(info.hostname ?? "");
  // A domain set up through a Cloudflare Tunnel (no longer offered) keeps working until it is changed or removed.
  const legacyTunnel = !!info.hostname && info.via === "tunnel";
  // A domain leads to the server's IP: without a public one, nothing outside can reach the port.
  const noPublicIp = !info.publicIp;
  // The card shows what happened (the URL, the certificate): errors and steps left stay in it too, no toasts.
  const [notice, setNotice] = React.useState<{ error: string | null; warnings: string[] }>({ error: null, warnings: [] });
  const save = useAction(async (hostname: string | null): Promise<ActionResult<{ warnings: string[] } | null>> => {
    setNotice({ error: null, warnings: [] });
    const res = await saveDatabaseDomain(serviceId, hostname, "direct");
    if (!res.ok) {
      setNotice({ error: res.error, warnings: [] });
      return { ok: true as const, data: null };
    }
    setNotice({ error: null, warnings: res.data.warnings });
    return res;
  });
  const changed = value.trim().toLowerCase() !== (info.hostname ?? "") || (!!info.hostname && !legacyTunnel && info.unreachable);
  const cert = info.certificate;
  // Without a public IP a new domain cannot work: the form is only there to remove one.
  const canAdd = info.directSupported && !noPublicIp;

  return (
    <Card>
      <CardHeader
        actions={
          // The certificate's state, next to the title: the details below stay about connecting.
          info.hostname && !legacyTunnel ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                cert?.status === "active" ? "bg-ok/10 text-ok" : cert?.status === "failed" ? "bg-bad/10 text-bad" : "bg-hover text-muted",
              )}
            >
              <Lock className="size-3" />
              {cert?.status === "active" ? "Certificate active" : cert?.status === "failed" ? "Certificate failed" : cert ? "Getting a certificate…" : "No certificate yet"}
            </span>
          ) : undefined
        }
        title={
          <span className="flex items-center gap-1.5">
            Domain
            <HelpTip label="How database domains work">
              The database gets its own port on this server and turns on TLS with a certificate for the domain, so clients can check they reach the real server. Saving restarts the
              database once.
            </HelpTip>
          </span>
        }
        description={
          canAdd || info.hostname ? `Connect from anywhere at your own domain${info.port ? `, on port ${info.port}` : ", on its own port"}, with a real certificate.` : undefined
        }
      />
      <CardBody className="flex flex-col gap-4">
        {!info.directSupported && !info.hostname ? (
          <p className="text-[13px] leading-relaxed text-muted">
            Serve cannot turn on TLS for {info.engineLabel}, so it cannot take a domain. Use the public port above to reach it from outside.
          </p>
        ) : noPublicIp && !info.hostname ? (
          <p className="flex items-start gap-2 text-[13px] leading-relaxed text-muted">
            <TriangleAlert className="mt-0.5 size-3.5 flex-none text-warn" />
            <span>
              This server has no public IP, so a domain cannot reach the database from outside. Services in this project still connect over the private network. If the server has a
              public IP, set it in the server&apos;s settings.
            </span>
          </p>
        ) : (
          <>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (changed && canAdd) void save.run(value.trim() || null);
              }}
            >
              <Field label="Domain" className="min-w-0 flex-1">
                <Input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="db.example.com"
                  className="font-mono text-[13px]"
                  spellCheck={false}
                  disabled={canManage === false || !canAdd}
                />
              </Field>
              {!legacyTunnel && (
                // One port, one list: the domain leads to the public port, so its allowlist is the port's.
                <p className="text-xs leading-relaxed text-muted">
                  The domain leads to the public port, so the same addresses can connect:{" "}
                  {info.allow.length ? `${info.allow.length} allowed address${info.allow.length === 1 ? "" : "es"}` : "everyone, with the password"}. Change who can connect on
                  Public port above.
                </p>
              )}
              <div className="flex justify-end gap-2">
                {info.hostname && (
                  <Button
                    type="button"
                    variant="danger-ghost"
                    size="sm"
                    className="h-9"
                    disabled={canManage === false}
                    loading={save.pending && !value}
                    onClick={async () => {
                      if (await save.run(null)) setValue("");
                    }}
                  >
                    Remove
                  </Button>
                )}
                {canAdd && (
                  <Button type="submit" variant="primary" size="sm" className="h-9" disabled={!changed || canManage === false} loading={save.pending && !!value}>
                    <Globe2 /> Save
                  </Button>
                )}
              </div>
            </form>
            {notice.error && (
              <p role="alert" className="flex items-start gap-2 text-[12.5px] leading-relaxed text-bad">
                <TriangleAlert className="mt-0.5 size-3.5 flex-none" />
                <span>{notice.error}</span>
              </p>
            )}
            {notice.warnings.map((w) => (
              <p key={w} className="flex items-start gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-fg-2">
                <TriangleAlert className="mt-0.5 size-3.5 flex-none text-warn" />
                <span>{w}</span>
              </p>
            ))}
            {legacyTunnel && (
              <div className="flex flex-col gap-3">
                <p className="flex items-start gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-fg-2">
                  <TriangleAlert className="mt-0.5 size-3.5 flex-none text-warn" />
                  <span>
                    {info.hostname} goes through a Cloudflare Tunnel, which database domains no longer use: every computer that connects must run cloudflared. It keeps working.
                    {canAdd ? " Save it again to move it to its own port, which needs nothing on the computers that connect." : " Remove it when you no longer need it."}
                  </span>
                </p>
                {info.tunnelCommand && (
                  <Field
                    label="On each computer that connects"
                    description="Run it on the computer you connect from (your laptop, not the server), and keep it running while you connect."
                  >
                    <CopyField value={info.tunnelCommand} />
                  </Field>
                )}
                <Field label="Then connect to (on that computer)" description="The tunnel encrypts the connection, so the local URL needs no TLS.">
                  <SecretField value={info.localUrl} hidden={hideSecrets} shape={info.localUrl} />
                </Field>
                {canAdd && (
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    className="self-end"
                    disabled={canManage === false}
                    loading={save.pending}
                    onClick={() => save.run(info.hostname)}
                  >
                    <Check /> Move to its own port
                  </Button>
                )}
              </div>
            )}
            {info.hostname && !legacyTunnel && (
              <>
                {noPublicIp && (
                  <p className="flex items-start gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-fg-2">
                    <TriangleAlert className="mt-0.5 size-3.5 flex-none text-warn" />
                    <span>This server has no public IP, so {info.hostname} cannot reach the database from outside.</span>
                  </p>
                )}
                {cert?.status === "failed" && cert.error && (
                  <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-bad">
                    <TriangleAlert className="mt-0.5 size-3.5 flex-none" />
                    <span>Certificate failed: {cert.error.split("\n")[0].slice(0, 160)}</span>
                  </p>
                )}
                {info.unreachable && (
                  <p className="flex items-start gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-fg-2">
                    <TriangleAlert className="mt-0.5 size-3.5 flex-none text-warn" />
                    <span>Public access or TLS was turned off, so the domain does not answer. Save the domain again to open its port with TLS.</span>
                  </p>
                )}
                {info.url && (
                  <Field
                    label={`Connection URL${info.port ? ` · port ${info.port}` : ""}`}
                    description={
                      cert?.status !== "active"
                        ? "Encrypted. The domain's certificate is used once it is active."
                        : info.engine === "postgres"
                          ? "Encrypted with the domain's certificate. To also check it, use sslmode=verify-full&sslrootcert=system (PostgreSQL 16+ clients)."
                          : "Encrypted with the domain's certificate, which clients check."
                    }
                  >
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
