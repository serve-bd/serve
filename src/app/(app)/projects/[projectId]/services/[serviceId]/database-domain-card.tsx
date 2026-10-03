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

  // Own port when the server has a public IP: the domain then works with a plain URL, nothing to run.
  const ownPortReady = info.directSupported && !!info.publicIp;
  const defaultVia = ownPortReady || info.tunnels.length === 0 ? "direct" : "tunnel";
  const [picked, setVia] = React.useState<"direct" | "tunnel">(info.hostname ? info.via : defaultVia);
  // With a tunnel on the server the route is a choice: with a public IP too, a tunnel lets the
  // domain work with the public port closed. Its own port stays the default then.
  const showRoutes = info.tunnels.length > 0;
  const via = showRoutes ? picked : defaultVia;
  // The card shows what happened (the URL, the certificate): errors and steps left stay in it too, no toasts.
  const [notice, setNotice] = React.useState<{ error: string | null; warnings: string[] }>({ error: null, warnings: [] });
  const save = useAction(async (hostname: string | null, route: "direct" | "tunnel" = via): Promise<ActionResult<{ warnings: string[] } | null>> => {
    setNotice({ error: null, warnings: [] });
    const res = await saveDatabaseDomain(serviceId, hostname, route);
    if (!res.ok) {
      setNotice({ error: res.error, warnings: [] });
      return { ok: true as const, data: null };
    }
    setNotice({ error: null, warnings: res.data.warnings });
    return res;
  });
  const tunnel = via === "tunnel";
  const changed = value.trim().toLowerCase() !== (info.hostname ?? "") || (!!info.hostname && (via !== info.via || info.unreachable));
  const cert = info.certificate;

  return (
    <Card>
      <CardHeader
        actions={
          // The certificate's state, next to the title: the details below stay about connecting.
          info.hostname && info.via !== "tunnel" ? (
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
              The database gets its own port on this server, open to everyone, and turns on TLS with a certificate for the domain, so clients can check they reach the real server.
              Saving restarts the database once.
            </HelpTip>
          </span>
        }
        description={
          !info.supported
            ? undefined
            : tunnel
              ? "Reach the database through Cloudflare, from anywhere, even when this server has no public IP."
              : `Connect from anywhere at your own domain${info.port ? `, on port ${info.port}` : ", on its own port"}, with a real certificate.`
        }
      />
      <CardBody className="flex flex-col gap-4">
        {!info.supported ? (
          <p className="text-[13px] leading-relaxed text-muted">
            Serve cannot turn on TLS for {info.engineLabel}. Create a Cloudflare Tunnel for this server to reach it through Cloudflare, or use Public access.
          </p>
        ) : (
          <>
            {showRoutes && (
              <div role="radiogroup" aria-label="Route" className="grid grid-cols-2 gap-1 rounded-xl bg-sunken p-1">
                {(
                  [
                    ["direct", "Own port", !info.directSupported],
                    ["tunnel", "Cloudflare Tunnel", false],
                  ] as const
                ).map(([value, label, disabled]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={via === value}
                    disabled={disabled || canManage === false}
                    onClick={() => setVia(value)}
                    className={cn(
                      "h-8 rounded-lg text-[13px] transition-colors disabled:opacity-40",
                      via === value ? "bg-surface font-medium text-fg shadow-sm" : "text-muted hover:text-fg",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <form
              className="flex flex-col gap-4"
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
              {!tunnel && (
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
                      if (await save.run(null)) {
                        setValue("");
                        setVia(defaultVia);
                      }
                    }}
                  >
                    Remove
                  </Button>
                )}
                <Button type="submit" variant="primary" size="sm" className="h-9" disabled={!changed || canManage === false} loading={save.pending && !!value}>
                  <Globe2 /> Save
                </Button>
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
            {info.hostname && info.via === "tunnel" && ownPortReady && (
              <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface-2 px-3.5 py-3 text-[13px] leading-relaxed sm:flex-row sm:items-center">
                <p className="min-w-0 flex-1 text-fg-2">
                  This server has a public IP ({info.publicIp}). With Own port, {info.hostname} works with a normal connection URL. Nothing to run on the computers that connect.
                </p>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  className="h-8 flex-none"
                  disabled={canManage === false}
                  loading={save.pending}
                  onClick={async () => {
                    if (await save.run(info.hostname, "direct")) setVia("direct");
                  }}
                >
                  Use Own port
                </Button>
              </div>
            )}
            {info.hostname && info.via === "tunnel" && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2 px-3.5 py-3 text-[13px] leading-relaxed">
                  <p className="flex items-start gap-2 text-fg-2">
                    <Check className="mt-0.5 size-3.5 flex-none text-ok" />
                    <span>This server&apos;s side of the tunnel is ready: cloudflared runs here and routes {info.hostname} to the database.</span>
                  </p>
                  <p className="text-muted">
                    Cloudflare passes database connections only from cloudflared to cloudflared, so each computer or app that connects runs it too. It opens a port on that computer
                    (localhost) that leads through the tunnel.
                  </p>
                </div>
                {info.tunnelCommand && (
                  <Field
                    label="On each computer that connects"
                    description="Needs cloudflared: brew install cloudflared, or see Cloudflare's downloads. Keep it running while you connect."
                  >
                    <CopyField value={info.tunnelCommand} />
                  </Field>
                )}
                <Field label="Then connect to (on that computer)" description="The tunnel encrypts the connection, so the local URL needs no TLS.">
                  <SecretField value={info.localUrl} hidden={hideSecrets} shape={info.localUrl} />
                </Field>
              </div>
            )}
            {info.hostname && info.via !== "tunnel" && (
              <>
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
