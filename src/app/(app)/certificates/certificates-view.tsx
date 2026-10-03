"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ChevronRight, Eye, FileCode2, MoreHorizontal, Plus, RefreshCw, ScrollText, ShieldCheck, Server as ServerIcon, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Copyable, CopyField, EmptyState } from "@/components/ui/misc";
import { StatusLabel } from "@/components/ui/status";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { LogViewer } from "@/components/log-viewer";
import { Tooltip } from "@/components/ui/tooltip";
import { explainCertError } from "@/lib/cert-errors";
import { useAction } from "@/hooks/use-action";
import {
  certificateFiles,
  certificateLogs,
  deleteCertificate,
  renewCertificate,
  requestCertificate,
  replaceCertificate,
  setCertificateAutoRenew,
  uploadCertificate,
} from "@/server/actions/certificates";
import { cn } from "@/lib/utils";
import { PageBody, PageHeader } from "@/components/shell/page-header";

type Cert = {
  id: string;
  /** Server name, when the instance has more than one server. */
  server: string | null;
  /** Public IP of the certificate's server, for DNS hints. */
  serverIp: string | null;
  name: string;
  domains: string[];
  provider: string;
  status: string;
  issuer: string | null;
  expiresAt: string | null;
  autoRenew: boolean;
  lastError: string | null;
  createdAt: string;
  /** Where the proxy finds the files, for custom proxy configs. */
  certPath: string | null;
  keyPath: string | null;
  /** The proxy of the certificate's server, which the config snippet is written for. */
  proxyKind: string;
};

/** How each proxy's config points at a certificate. */
function certificateSnippet(kind: string, cert: string, key: string): { label: string; text: string } | null {
  if (kind === "nginx") return { label: "For nginx", text: `ssl_certificate     ${cert};\nssl_certificate_key ${key};` };
  if (kind === "caddy") return { label: "For Caddy (in the site block)", text: `tls ${cert} ${key}` };
  if (kind === "traefik") return { label: "For Traefik", text: `tls:\n  certificates:\n    - certFile: ${cert}\n      keyFile: ${key}` };
  return null;
}

const providerLabel: Record<string, string> = {
  "letsencrypt-http": "Let's Encrypt",
  "letsencrypt-cloudflare": "Let's Encrypt via Cloudflare DNS",
  "cloudflare-origin": "Cloudflare Origin CA",
  custom: "Uploaded",
};

/** "Expires in 87 days", or in years for long-lived certificates like Cloudflare Origin ones. */
function expiresText(days: number) {
  if (days < 0) return "Expired";
  if (days >= 730) return `Expires in ${Math.floor(days / 365)} years`;
  return `Expires in ${days} day${days === 1 ? "" : "s"}`;
}

function daysLeft(iso: string | null) {
  if (!iso) return null;
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86400000);
}

function RequestDialog({
  open,
  onOpenChange,
  accounts,
  hasAcme,
  servers,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  accounts: { id: string; name: string }[];
  hasAcme: boolean;
  servers: { id: string; name: string; isLocal: boolean }[];
}) {
  const [serverId, setServerId] = React.useState(servers[0]?.id ?? "local");
  const [tab, setTab] = React.useState<"request" | "upload">("request");
  const [provider, setProvider] = React.useState<"letsencrypt-http" | "letsencrypt-cloudflare" | "cloudflare-origin">(
    accounts.length ? "letsencrypt-cloudflare" : "letsencrypt-http",
  );
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
        serverId,
      }),
    { onSuccess: close },
  );
  const upload = useAction(() => uploadCertificate({ name, certificate: cert, privateKey: key, serverId }), { onSuccess: close });
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
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn("h-8 rounded-lg text-[13px] font-medium transition-all", tab === t ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}
                >
                  {t === "request" ? "Request certificate" : "Upload certificate"}
                </button>
              ))}
            </div>
            {servers.length > 1 && (
              <Field label="Server" description="The certificate is stored and served by this server's proxy.">
                <Select value={serverId} onValueChange={setServerId} options={servers.map((s) => ({ value: s.id, label: s.isLocal ? `${s.name} (this server)` : s.name }))} />
              </Field>
            )}
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
                    <Link href="/integrations/cloudflare" className="text-accent hover:underline">
                      Connect Cloudflare
                    </Link>{" "}
                    to use DNS validation and origin certificates.
                  </p>
                )}
                <Field label="Domains" description={provider === "letsencrypt-http" ? "One per line or comma separated." : "Wildcards like *.example.com are supported."}>
                  <Textarea
                    value={domains}
                    onChange={(e) => setDomains(e.target.value)}
                    rows={3}
                    placeholder={"example.com\nwww.example.com"}
                    className="font-mono text-[13px]"
                    required
                  />
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

function ReplaceDialog({ cert: c, open, onClose }: { cert: Cert | null; open: boolean; onClose: () => void }) {
  const [cert, setCert] = React.useState("");
  const [key, setKey] = React.useState("");
  const replace = useAction(() => replaceCertificate(c!.id, { certificate: cert, privateKey: key }), { onSuccess: onClose });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void replace.run();
          }}
        >
          <DialogHeader title={`Replace ${c?.name ?? "certificate"}`} description="The new files go to the same paths. Sites and custom configs pick them up." />
          <DialogBody>
            <Field label="Certificate (PEM)" description="Include the full chain.">
              <Textarea value={cert} onChange={(e) => setCert(e.target.value)} rows={5} placeholder="-----BEGIN CERTIFICATE-----" className="font-mono text-[12px]" required />
            </Field>
            <Field label="Private key (PEM)">
              <Textarea value={key} onChange={(e) => setKey(e.target.value)} rows={5} placeholder="-----BEGIN PRIVATE KEY-----" className="font-mono text-[12px]" required />
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" size="sm" variant="primary" loading={replace.pending}>
              Replace certificate
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

/** The certificate's file paths inside the proxy, to use it in a custom proxy config. */
function PathsDialog({ cert, open, onClose }: { cert: Cert; open: boolean; onClose: () => void }) {
  const snippet = certificateSnippet(cert.proxyKind, cert.certPath ?? "", cert.keyPath ?? "");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title="Use in a custom config" description={`The proxy of this certificate's server reads ${cert.name} at these paths.`} />
        <DialogBody className="flex flex-col gap-4">
          <Field label="Certificate">
            <CopyField value={cert.certPath ?? ""} />
          </Field>
          <Field label="Private key">
            <CopyField value={cert.keyPath ?? ""} />
          </Field>
          {snippet && (
            <Field label={snippet.label}>
              <Copyable value={snippet.text}>
                <pre className="rounded-md border border-line bg-surface-2 py-2.5 pr-9 pl-3 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap text-fg-2">
                  {snippet.text}
                </pre>
              </Copyable>
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The PEM files themselves, to copy into another server or tool. Read when opened; the key stays hidden until asked for. */
function FilesDialog({ cert, open, onClose }: { cert: Cert; open: boolean; onClose: () => void }) {
  const [files, setFiles] = React.useState<{ certificate: string; privateKey: string } | null>(null);
  const [showKey, setShowKey] = React.useState(false);
  const load = useAction(() => certificateFiles(cert.id), { onSuccess: (f) => setFiles(f) });
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once each time the dialog opens.
  React.useEffect(() => {
    if (!open) {
      setFiles(null);
      setShowKey(false);
      return;
    }
    load.run();
  }, [open, cert.id]);
  const block = (value: string) => (
    <Copyable value={value}>
      <pre className="scrollbar-thin max-h-56 overflow-auto rounded-md border border-line bg-surface-2 py-2.5 pr-9 pl-3 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-fg-2">
        {value}
      </pre>
    </Copyable>
  );
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader title={cert.name} description="The files the proxy serves, in PEM format." />
        <DialogBody className="flex flex-col gap-4">
          {!files ? (
            <div className="h-40 animate-pulse rounded-md bg-sunken" />
          ) : (
            <>
              <Field label="Certificate" description="With its chain (fullchain.pem).">
                {block(files.certificate)}
              </Field>
              <Field label="Private key" description="Keep it secret: anyone with it can pose as these domains.">
                {showKey ? (
                  block(files.privateKey)
                ) : (
                  <Button size="sm" className="w-fit" onClick={() => setShowKey(true)}>
                    <Eye /> Show private key
                  </Button>
                )}
              </Field>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CertificateRow({
  cert: c,
  isAdmin,
  serverIp,
  onRenew,
  onLogs,
  onUpload,
  onAutoRenew,
  onDelete,
}: {
  cert: Cert;
  isAdmin: boolean;
  serverIp: string | null;
  onRenew: () => void;
  onLogs: () => void;
  onUpload: () => void;
  onAutoRenew: (on: boolean) => void;
  onDelete: () => void;
}) {
  const [details, setDetails] = React.useState(false);
  const [paths, setPaths] = React.useState(false);
  const [viewing, setViewing] = React.useState(false);
  const days = daysLeft(c.expiresAt);
  const failed = c.status === "failed";
  const managed = c.provider !== "custom";
  const problem = failed && c.lastError ? explainCertError(c.lastError, { serverIp: c.serverIp ?? serverIp, provider: c.provider }) : null;

  return (
    <div className="flex flex-col gap-3 px-4 py-3.5 sm:px-5">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="truncate text-[14px] font-medium text-fg">{c.name}</span>
            {/* Active is the normal state; only other states get a label. */}
            {c.status !== "active" && <StatusLabel status={c.status} kind="certificate" className="text-xs" />}
          </div>
          {/* A certificate named after its only domain would show it twice. */}
          {!(c.domains.length === 1 && c.domains[0] === c.name) && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              {c.domains.slice(0, 4).map((d) => (
                <span key={d} className="max-w-full truncate font-mono text-[11.5px] text-fg-2">
                  {d}
                </span>
              ))}
              {c.domains.length > 4 && <span className="text-xs text-faint">+{c.domains.length - 4} more</span>}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
            <span>{providerLabel[c.provider]}</span>
            {c.server && (
              <>
                <span className="text-faint">·</span>
                <span className="inline-flex items-center gap-1">
                  <ServerIcon className="size-3" />
                  {c.server}
                </span>
              </>
            )}
            {days !== null && !failed && (
              <>
                <span className="text-faint">·</span>
                <span className={cn(days < 0 ? "text-bad" : days < 14 ? "text-warn" : undefined)}>{expiresText(days)}</span>
              </>
            )}
          </div>
        </div>
        {isAdmin && (
          <div className="flex flex-none items-center gap-3">
            {managed && (
              <Tooltip content={c.autoRenew ? "Renews automatically" : "Automatic renewal is off"}>
                <label className="hidden items-center gap-2 text-xs text-muted sm:flex">
                  Auto-renew
                  <Switch checked={c.autoRenew} onCheckedChange={onAutoRenew} />
                </label>
              </Tooltip>
            )}
            <Menu>
              <MenuTrigger className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Certificate actions">
                <MoreHorizontal className="size-4" />
              </MenuTrigger>
              <MenuContent>
                {managed && (
                  <MenuItem onClick={onRenew}>
                    <RefreshCw /> {c.status === "active" ? "Renew now" : "Retry"}
                  </MenuItem>
                )}
                {managed && (
                  <MenuItem onClick={onLogs}>
                    <ScrollText /> View log
                  </MenuItem>
                )}
                {managed && (
                  <MenuItem className="sm:hidden" onClick={() => onAutoRenew(!c.autoRenew)}>
                    <RefreshCw /> {c.autoRenew ? "Turn off auto-renew" : "Turn on auto-renew"}
                  </MenuItem>
                )}
                {c.certPath && c.keyPath && (c.status === "active" || c.status === "expired") && (
                  <MenuItem onClick={() => setViewing(true)}>
                    <Eye /> View certificate
                  </MenuItem>
                )}
                {c.certPath && c.keyPath && c.status === "active" && (
                  <MenuItem onClick={() => setPaths(true)}>
                    <FileCode2 /> Use in a custom config
                  </MenuItem>
                )}
                {!managed && (
                  <MenuItem onClick={onUpload}>
                    <Upload /> Upload replacement
                  </MenuItem>
                )}
                <MenuSeparator />
                <MenuItem danger onClick={onDelete}>
                  <Trash2 /> Delete
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        )}
      </div>

      {problem && (
        <div className="rounded-xl border border-bad/15 bg-bad-soft/60 px-3.5 py-3 sm:ml-[50px]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="text-[13px] font-medium text-fg">{problem.title}</p>
              <p className="text-[12.5px] leading-relaxed text-fg-2">{problem.hint}</p>
            </div>
            {isAdmin && managed && (
              <div className="flex flex-none gap-2">
                <Button size="xs" onClick={onLogs}>
                  <ScrollText /> Log
                </Button>
                <Button size="xs" variant="primary" onClick={onRenew}>
                  <RefreshCw /> Retry
                </Button>
              </div>
            )}
          </div>
          <button type="button" onClick={() => setDetails((d) => !d)} className="mt-2 flex items-center gap-1 text-[11.5px] font-medium text-muted hover:text-fg">
            <ChevronRight className={cn("size-3 transition-transform", details && "rotate-90")} />
            {details ? "Hide details" : "Show details"}
          </button>
          {details && (
            <Copyable value={c.lastError ?? ""} className="mt-2">
              <pre className="max-h-40 overflow-auto rounded-lg bg-sunken py-2.5 pr-9 pl-2.5 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-muted">
                {c.lastError}
              </pre>
            </Copyable>
          )}
        </div>
      )}
      {c.certPath && c.keyPath && <PathsDialog cert={c} open={paths} onClose={() => setPaths(false)} />}
      {c.certPath && c.keyPath && <FilesDialog cert={c} open={viewing} onClose={() => setViewing(false)} />}
    </div>
  );
}

export function CertificatesView({
  certificates,
  accounts,
  isAdmin,
  hasAcme,
  staging,
  proxyManaged = [],
  serverIp,
  servers,
}: {
  servers: { id: string; name: string; isLocal: boolean }[];
  certificates: Cert[];
  accounts: { id: string; name: string }[];
  isAdmin: boolean;
  hasAcme: boolean;
  staging: boolean;
  /** Servers whose proxy (Caddy or Traefik) manages certificates itself. */
  proxyManaged?: { name: string; proxy: string }[];
  serverIp: string | null;
}) {
  const confirm = useConfirm();
  const [open, setOpen] = React.useState(false);
  // A new key on each open: the dialog starts empty, not with the last values.
  const [opened, setOpened] = React.useState(0);
  const [replacing, setReplacing] = React.useState<Cert | null>(null);
  const [replaceOpen, setReplaceOpen] = React.useState(false);
  const [logsFor, setLogsFor] = React.useState<string | null>(null);
  const renew = useAction(renewCertificate);
  const auto = useAction((id: string, on: boolean) => setCertificateAutoRenew(id, on));
  const remove = useAction(deleteCertificate);

  return (
    <>
      <PageHeader
        title="Certificates"
        description="TLS certificates for your domains. Let's Encrypt certificates renew automatically 30 days before they expire."
        actions={
          isAdmin && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setOpened((n) => n + 1);
                setOpen(true);
              }}
            >
              <Plus /> Add certificate
            </Button>
          )
        }
      />
      <PageBody className="flex flex-col gap-4">
        {proxyManaged.length > 0 && (
          <p className="flex items-start gap-2 rounded-xl bg-info-soft px-4 py-2.5 text-[13px] text-fg-2">
            <ShieldCheck className="mt-0.5 size-4 flex-none text-info" />
            <span>
              {proxyManaged.map((s) => `${s.name} (${s.proxy})`).join(", ")} {proxyManaged.length === 1 ? "gets" : "get"} HTTPS certificates from the proxy itself. They are managed
              by the proxy, renew automatically and are not listed here.
            </span>
          </p>
        )}
        {staging && (
          <p className="flex items-center gap-2 rounded-xl bg-warn-soft px-4 py-2.5 text-[13px] text-warn">
            <AlertTriangle className="size-4" /> Let&apos;s Encrypt staging is on. New certificates will not be trusted by browsers.
          </p>
        )}
        <Card className="overflow-hidden">
          {certificates.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck />}
              title="No certificates yet"
              description="Certificates are requested automatically when you add an HTTPS domain. You can also request wildcard or origin certificates here."
            />
          ) : (
            <div className="divide-y divide-line">
              {certificates.map((c) => (
                <CertificateRow
                  key={c.id}
                  cert={c}
                  isAdmin={isAdmin}
                  serverIp={serverIp}
                  onRenew={() => renew.run(c.id)}
                  onLogs={() => setLogsFor(c.id)}
                  onUpload={() => {
                    setOpened((n) => n + 1);
                    setReplacing(c);
                    setReplaceOpen(true);
                  }}
                  onAutoRenew={(on) => auto.run(c.id, on)}
                  onDelete={async () => {
                    if (
                      await confirm({
                        title: `Delete ${c.name}?`,
                        description: "Domains using it fall back to HTTP until another certificate covers them.",
                        confirmLabel: "Delete certificate",
                        danger: true,
                      })
                    )
                      remove.run(c.id);
                  }}
                />
              ))}
            </div>
          )}
        </Card>
        <RequestDialog key={opened} open={open} onOpenChange={setOpen} accounts={accounts} hasAcme={hasAcme} servers={servers} />
        <ReplaceDialog key={`r${opened}`} cert={replacing} open={replaceOpen} onClose={() => setReplaceOpen(false)} />
        <LogsDialog certId={logsFor} onClose={() => setLogsFor(null)} />
      </PageBody>
    </>
  );
}
