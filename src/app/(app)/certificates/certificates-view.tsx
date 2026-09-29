"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Cloud, FileKey2, MoreHorizontal, Plus, RefreshCw, ScrollText, ShieldCheck, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/misc";
import { StatusLabel } from "@/components/ui/status";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { LogViewer } from "@/components/log-viewer";
import { useAction } from "@/hooks/use-action";
import { certificateLogs, deleteCertificate, renewCertificate, requestCertificate, setCertificateAutoRenew, uploadCertificate } from "@/server/actions/certificates";
import { cn } from "@/lib/utils";

type Cert = {
  id: string;
  name: string;
  domains: string[];
  provider: string;
  status: string;
  issuer: string | null;
  expiresAt: string | null;
  autoRenew: boolean;
  lastError: string | null;
  createdAt: string;
};

const providerLabel: Record<string, string> = {
  "letsencrypt-http": "Let's Encrypt · HTTP",
  "letsencrypt-cloudflare": "Let's Encrypt · Cloudflare DNS",
  "cloudflare-origin": "Cloudflare Origin CA",
  custom: "Uploaded",
};

function daysLeft(iso: string | null) {
  if (!iso) return null;
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86400000);
}

function RequestDialog({ open, onOpenChange, accounts, hasAcme }: { open: boolean; onOpenChange: (o: boolean) => void; accounts: { id: string; name: string }[]; hasAcme: boolean }) {
  const [tab, setTab] = React.useState<"request" | "upload">("request");
  const [provider, setProvider] = React.useState<"letsencrypt-http" | "letsencrypt-cloudflare" | "cloudflare-origin">(accounts.length ? "letsencrypt-cloudflare" : "letsencrypt-http");
  const [domains, setDomains] = React.useState("");
  const [account, setAccount] = React.useState(accounts[0]?.id ?? "");
  const [name, setName] = React.useState("");
  const [cert, setCert] = React.useState("");
  const [key, setKey] = React.useState("");
  const close = () => onOpenChange(false);
  const request = useAction(
    () =>
      requestCertificate({
        provider,
        domains: domains.split(/[\s,]+/).filter(Boolean),
        cloudflareAccountId: provider === "letsencrypt-http" ? null : account,
      }),
    { success: "Certificate requested", onSuccess: close },
  );
  const upload = useAction(() => uploadCertificate({ name, certificate: cert, privateKey: key }), { success: "Certificate uploaded", onSuccess: close });
  const needsCf = provider !== "letsencrypt-http";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void (tab === "request" ? request.run() : upload.run());
          }}
        >
          <DialogHeader title="Add certificate" description="Request a free certificate or upload one you already have." />
          <DialogBody>
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-sunken p-1">
              {(["request", "upload"] as const).map((t) => (
                <button key={t} type="button" onClick={() => setTab(t)} className={cn("h-8 rounded-lg text-[13px] font-medium transition-all", tab === t ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}>
                  {t === "request" ? "Request certificate" : "Upload certificate"}
                </button>
              ))}
            </div>
            {tab === "request" ? (
              <>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {(
                    [
                      ["letsencrypt-http", "HTTP validation", "Port 80 must reach this server."],
                      ["letsencrypt-cloudflare", "Cloudflare DNS", "Wildcards, works behind proxies."],
                      ["cloudflare-origin", "Origin certificate", "15 years, for proxied domains."],
                    ] as const
                  ).map(([id, title, body]) => {
                    const disabled = id !== "letsencrypt-http" && !accounts.length;
                    return (
                      <button
                        key={id}
                        type="button"
                        disabled={disabled}
                        onClick={() => setProvider(id)}
                        className={cn(
                          "flex flex-col gap-1 rounded-xl border p-3 text-left transition-all disabled:opacity-40",
                          provider === id ? "border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]" : "border-line hover:border-line-strong",
                        )}
                      >
                        <span className="text-[13px] font-semibold text-fg">{title}</span>
                        <span className="text-xs leading-relaxed text-muted">{body}</span>
                      </button>
                    );
                  })}
                </div>
                {!accounts.length && (
                  <p className="text-xs text-muted">
                    <Link href="/integrations/cloudflare" className="text-accent hover:underline">Connect Cloudflare</Link> to use DNS validation and origin certificates.
                  </p>
                )}
                <Field label="Domains" description={provider === "letsencrypt-http" ? "One per line or comma separated." : "Wildcards like *.example.com are supported."}>
                  <Textarea value={domains} onChange={(e) => setDomains(e.target.value)} rows={3} placeholder={"example.com\nwww.example.com"} className="font-mono text-[13px]" required />
                </Field>
                {needsCf && (
                  <Field label="Cloudflare account">
                    <Select value={account} onValueChange={setAccount} options={accounts.map((a) => ({ value: a.id, label: a.name }))} />
                  </Field>
                )}
                {provider.startsWith("letsencrypt") && !hasAcme && (
                  <p className="flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
                    <AlertTriangle className="size-3.5" /> Set a Let&apos;s Encrypt email in Server settings first.
                  </p>
                )}
              </>
            ) : (
              <>
                <Field label="Name" optional>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Wildcard example.com" />
                </Field>
                <Field label="Certificate (PEM)" description="Include the full chain.">
                  <Textarea value={cert} onChange={(e) => setCert(e.target.value)} rows={5} placeholder="-----BEGIN CERTIFICATE-----" className="font-mono text-[12px]" required />
                </Field>
                <Field label="Private key (PEM)">
                  <Textarea value={key} onChange={(e) => setKey(e.target.value)} rows={5} placeholder="-----BEGIN PRIVATE KEY-----" className="font-mono text-[12px]" required />
                </Field>
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={request.pending || upload.pending}>
              {tab === "request" ? "Request certificate" : "Upload certificate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LogsDialog({ certId, onClose }: { certId: string | null; onClose: () => void }) {
  const [logs, setLogs] = React.useState<string>("");
  React.useEffect(() => {
    if (!certId) return;
    let stop = false;
    const load = async () => {
      const res = await certificateLogs(certId);
      if (res.ok && !stop) {
        setLogs(res.data.logs);
        if (["issuing", "pending"].includes(res.data.status)) setTimeout(load, 1500);
      }
    };
    void load();
    return () => {
      stop = true;
    };
  }, [certId]);
  return (
    <Dialog open={!!certId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl">
        <DialogHeader title="Certificate log" />
        <DialogBody>
          <LogViewer lines={logs.split("\n").map((text) => ({ text }))} height="420px" filename="certificate.log" />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function CertificatesView({ certificates, accounts, isAdmin, hasAcme, staging }: { certificates: Cert[]; accounts: { id: string; name: string }[]; isAdmin: boolean; hasAcme: boolean; staging: boolean }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [open, setOpen] = React.useState(false);
  const [logsFor, setLogsFor] = React.useState<string | null>(null);
  const renew = useAction(renewCertificate, { success: "Renewal started" });
  const auto = useAction((id: string, on: boolean) => setCertificateAutoRenew(id, on));
  const remove = useAction(deleteCertificate, { success: "Certificate deleted" });

  React.useEffect(() => {
    if (!certificates.some((c) => ["issuing", "pending"].includes(c.status))) return;
    const t = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(t);
  }, [certificates, router]);

  return (
    <div className="flex flex-col gap-4">
      {staging && (
        <p className="flex items-center gap-2 rounded-xl bg-warn-soft px-4 py-2.5 text-[13px] text-warn">
          <AlertTriangle className="size-4" /> Let&apos;s Encrypt staging is on. New certificates will not be trusted by browsers.
        </p>
      )}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <p className="text-[13px] text-muted">{certificates.length} certificate{certificates.length === 1 ? "" : "s"}</p>
          {isAdmin && (
            <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
              <Plus /> Add certificate
            </Button>
          )}
        </div>
        {certificates.length === 0 ? (
          <EmptyState icon={<ShieldCheck />} title="No certificates yet" description="Certificates are requested automatically when you add an HTTPS domain. You can also request wildcard or origin certificates here." />
        ) : (
          <div className="divide-y divide-line">
            {certificates.map((c) => {
              const days = daysLeft(c.expiresAt);
              return (
                <div key={c.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                  <span className="flex size-9 items-center justify-center rounded-[10px] border border-line bg-surface-2 text-fg-2">
                    {c.provider === "custom" ? <FileKey2 className="size-4" /> : c.provider.includes("cloudflare") ? <Cloud className="size-4 text-[#f38020]" /> : <ShieldCheck className="size-4 text-ok" />}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[14px] font-medium text-fg">{c.name}</span>
                      <StatusLabel status={c.status} kind="certificate" className="text-xs" />
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {c.domains.slice(0, 5).map((d) => (
                        <span key={d} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted ring-1 ring-line">{d}</span>
                      ))}
                      {c.domains.length > 5 && <span className="text-[11px] text-faint">+{c.domains.length - 5}</span>}
                    </div>
                    {c.status === "failed" && c.lastError && <p className="text-xs text-bad">{c.lastError}</p>}
                  </div>
                  <div className="flex flex-col items-end gap-1 text-right">
                    <span className="text-xs text-muted">{providerLabel[c.provider]}</span>
                    {days !== null && (
                      <Badge tone={days < 0 ? "bad" : days < 14 ? "warn" : "neutral"}>{days < 0 ? "Expired" : `${days} days left`}</Badge>
                    )}
                  </div>
                  {isAdmin && (
                    <div className="flex items-center gap-2">
                      {c.provider !== "custom" && (
                        <label className="flex items-center gap-2 text-xs text-muted" title="Renew automatically">
                          Auto
                          <Switch checked={c.autoRenew} onCheckedChange={(on) => auto.run(c.id, on)} />
                        </label>
                      )}
                      <Menu>
                        <MenuTrigger className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Certificate actions">
                          <MoreHorizontal className="size-4" />
                        </MenuTrigger>
                        <MenuContent>
                          {c.provider !== "custom" && (
                            <MenuItem onClick={() => renew.run(c.id)}>
                              <RefreshCw /> {c.status === "active" ? "Renew now" : "Retry"}
                            </MenuItem>
                          )}
                          {c.provider !== "custom" && (
                            <MenuItem onClick={() => setLogsFor(c.id)}>
                              <ScrollText /> View log
                            </MenuItem>
                          )}
                          {c.provider === "custom" && (
                            <MenuItem onClick={() => setOpen(true)}>
                              <Upload /> Upload replacement
                            </MenuItem>
                          )}
                          <MenuSeparator />
                          <MenuItem
                            danger
                            onClick={async () => {
                              if (await confirm({ title: `Delete ${c.name}?`, description: "Domains using it fall back to HTTP until another certificate covers them.", confirmLabel: "Delete certificate", danger: true }))
                                remove.run(c.id);
                            }}
                          >
                            <Trash2 /> Delete
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
      <RequestDialog open={open} onOpenChange={setOpen} accounts={accounts} hasAcme={hasAcme} />
      <LogsDialog certId={logsFor} onClose={() => setLogsFor(null)} />
    </div>
  );
}
