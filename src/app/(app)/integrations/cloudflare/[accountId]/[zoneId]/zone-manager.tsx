"use client";

import * as React from "react";
import { Cloud, CloudOff, Pencil, Plus, Search, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, EmptyState } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch, SwitchRow } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { deleteDnsRecord, purgeZoneCache, setZoneAlwaysHttps, setZoneSsl, upsertDnsRecord } from "@/server/actions/integrations";
import { cn } from "@/lib/utils";

type Rec = { id: string; type: string; name: string; content: string; proxied: boolean; proxiable: boolean; ttl: number; comment: string | null; priority: number | null };

const types = ["A", "AAAA", "CNAME", "TXT", "MX", "CAA", "NS", "SRV"] as const;
const sslModes = [
  { value: "off", label: "Off", body: "No HTTPS between visitors and Cloudflare." },
  { value: "flexible", label: "Flexible", body: "HTTPS to Cloudflare, HTTP to your server." },
  { value: "full", label: "Full", body: "HTTPS end to end, any certificate." },
  { value: "strict", label: "Full (strict)", body: "HTTPS end to end with a valid certificate. Recommended." },
];

function RecordDialog({
  zoneName,
  record,
  serverIp,
  open,
  onOpenChange,
  onSave,
  pending,
}: {
  zoneName: string;
  record: Rec | null;
  serverIp: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSave: (r: { type: string; name: string; content: string; proxied: boolean; ttl: number; priority?: number; comment?: string }) => void;
  pending: boolean;
}) {
  const [type, setType] = React.useState(record?.type ?? "A");
  const [name, setName] = React.useState(record ? (record.name === zoneName ? "@" : record.name.replace(`.${zoneName}`, "")) : "");
  const [content, setContent] = React.useState(record?.content ?? (serverIp ?? ""));
  const [proxied, setProxied] = React.useState(record?.proxied ?? false);
  const [ttl, setTtl] = React.useState(String(record?.ttl ?? 1));
  const [priority, setPriority] = React.useState(String(record?.priority ?? 10));
  const full = name === "@" || !name ? zoneName : `${name}.${zoneName}`;
  const proxiable = ["A", "AAAA", "CNAME"].includes(type);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave({ type, name: full, content, proxied: proxiable && proxied, ttl: Number(ttl) || 1, priority: type === "MX" ? Number(priority) : undefined });
          }}
        >
          <DialogHeader title={record ? "Edit DNS record" : "Add DNS record"} description={full} />
          <DialogBody>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[120px_1fr]">
              <Field label="Type">
                <Select value={type} onValueChange={setType} options={types.map((t) => ({ value: t, label: t }))} disabled={!!record} />
              </Field>
              <Field label="Name" description="Use @ for the root domain.">
                <div className="flex items-center gap-2">
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="app" className="font-mono text-[13px]" />
                  <span className="shrink-0 text-[13px] text-muted">.{zoneName}</span>
                </div>
              </Field>
            </div>
            <Field label={type === "A" || type === "AAAA" ? "IP address" : type === "CNAME" ? "Target" : "Content"}>
              <div className="flex gap-2">
                <Input value={content} onChange={(e) => setContent(e.target.value)} required className="font-mono text-[13px]" />
                {type === "A" && serverIp && content !== serverIp && (
                  <Button size="sm" onClick={() => setContent(serverIp)} className="h-9">
                    This server
                  </Button>
                )}
              </div>
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="TTL">
                <Select value={ttl} onValueChange={setTtl} options={[{ value: "1", label: "Auto" }, { value: "60", label: "1 minute" }, { value: "300", label: "5 minutes" }, { value: "3600", label: "1 hour" }, { value: "86400", label: "1 day" }]} />
              </Field>
              {type === "MX" && (
                <Field label="Priority">
                  <Input value={priority} onChange={(e) => setPriority(e.target.value.replace(/\D/g, ""))} />
                </Field>
              )}
            </div>
            {proxiable && <SwitchRow title="Proxied" description="Route traffic through Cloudflare (orange cloud)." checked={proxied} onCheckedChange={setProxied} />}
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={pending}>
              {record ? "Save record" : "Add record"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ZoneManager({
  accountId,
  zone,
  records,
  sslMode,
  alwaysHttps,
  serverIp,
  isAdmin,
}: {
  accountId: string;
  zone: { id: string; name: string; nameServers: string[] };
  records: Rec[];
  sslMode: string | null;
  alwaysHttps: boolean | null;
  serverIp: string | null;
  isAdmin: boolean;
}) {
  const confirm = useConfirm();
  const [query, setQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState("all");
  const [editing, setEditing] = React.useState<Rec | null>(null);
  const [open, setOpen] = React.useState(false);
  const [dialogKey, setDialogKey] = React.useState(0);
  const openDialog = (r: Rec | null) => {
    setEditing(r);
    setDialogKey((k) => k + 1);
    setOpen(true);
  };
  const save = useAction(
    (r: { type: string; name: string; content: string; proxied: boolean; ttl: number; priority?: number }) =>
      upsertDnsRecord(accountId, zone.id, editing?.id ?? null, r as Parameters<typeof upsertDnsRecord>[3]),
    { success: editing ? "Record updated" : "Record added", onSuccess: () => setOpen(false) },
  );
  const remove = useAction((id: string) => deleteDnsRecord(accountId, zone.id, id), { success: "Record deleted" });
  const toggleProxy = useAction((r: Rec) => upsertDnsRecord(accountId, zone.id, r.id, { type: r.type as "A", name: r.name, content: r.content, proxied: !r.proxied, ttl: r.ttl }), { success: "Proxy updated" });
  const ssl = useAction((m: string) => setZoneSsl(accountId, zone.id, m as "full"), { success: "SSL mode updated" });
  const https = useAction((on: boolean) => setZoneAlwaysHttps(accountId, zone.id, on), { success: "Setting updated" });
  const purge = useAction(() => purgeZoneCache(accountId, zone.id), { success: "Cache purged", refresh: false });

  const filtered = records.filter((r) => (typeFilter === "all" || r.type === typeFilter) && `${r.name} ${r.content}`.toLowerCase().includes(query.toLowerCase()));
  const short = (n: string) => (n === zone.name ? "@" : n.replace(`.${zone.name}`, ""));

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search records" className="h-8 w-56 pl-8 text-[13px]" />
          </div>
          <Select size="sm" value={typeFilter} onValueChange={setTypeFilter} options={[{ value: "all", label: "All types" }, ...types.map((t) => ({ value: t, label: t }))]} className="w-32" />
          <div className="flex-1" />
          {isAdmin && (
            <Button size="sm" variant="primary" onClick={() => openDialog(null)}>
              <Plus /> Add record
            </Button>
          )}
        </div>
        {filtered.length === 0 ? (
          <EmptyState title="No records" description={records.length ? "No records match your search." : "This zone has no DNS records yet."} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line bg-surface-2 text-[11px] text-faint">
                <tr>
                  <th className="w-16 px-5 py-2 font-semibold">Type</th>
                  <th className="px-3 py-2 font-semibold">Name</th>
                  <th className="px-3 py-2 font-semibold">Content</th>
                  <th className="w-20 px-3 py-2 font-semibold">Proxy</th>
                  <th className="w-20 px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((r) => (
                  <tr key={r.id} className="group transition-colors hover:bg-hover/40">
                    <td className="px-5 py-2.5">
                      <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-fg-2 ring-1 ring-line">{r.type}</span>
                    </td>
                    <td className="max-w-48 truncate px-3 py-2.5 font-mono text-[12.5px] text-fg">{short(r.name)}</td>
                    <td className="max-w-72 truncate px-3 py-2.5 font-mono text-[12.5px] text-muted" title={r.content}>
                      {r.priority !== null && r.type === "MX" && <span className="mr-1 text-faint">{r.priority}</span>}
                      {r.content}
                      {serverIp && r.content === serverIp && <span className="ml-2 rounded bg-accent-soft px-1.5 py-px font-sans text-[10px] font-semibold text-accent">THIS SERVER</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      {r.proxiable ? (
                        <Tooltip content={r.proxied ? "Proxied through Cloudflare" : "DNS only"}>
                          <button type="button" disabled={!isAdmin} onClick={() => toggleProxy.run(r)} className={cn("inline-flex rounded-md p-1 transition-colors", r.proxied ? "text-[#f38020] hover:bg-[#f38020]/10" : "text-faint hover:bg-hover")}>
                            {r.proxied ? <Cloud className="size-4 fill-current" /> : <CloudOff className="size-4" />}
                          </button>
                        </Tooltip>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {isAdmin && (
                        <div className="flex justify-end gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                          <Button variant="ghost" size="icon-sm" onClick={() => openDialog(r)} aria-label="Edit record">
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Delete record"
                            onClick={async () => {
                              if (await confirm({ title: `Delete ${r.type} record for ${short(r.name)}?`, description: "This takes effect in Cloudflare immediately.", confirmLabel: "Delete record", danger: true })) remove.run(r.id);
                            }}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="SSL/TLS mode" description="How Cloudflare connects to this server." />
          <CardBody className="flex flex-col gap-1.5">
            {sslModes.map((m) => (
              <button
                key={m.value}
                type="button"
                disabled={!isAdmin || ssl.pending}
                onClick={() => ssl.run(m.value)}
                className={cn("flex flex-col rounded-xl border px-3 py-2 text-left transition-all", sslMode === m.value ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong")}
              >
                <span className="text-[13px] font-medium text-fg">{m.label}</span>
                <span className="text-xs text-muted">{m.body}</span>
              </button>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardBody className="flex flex-col gap-4 py-4">
            {alwaysHttps !== null && (
              <label className="flex items-center justify-between gap-4">
                <span className="flex flex-col">
                  <span className="text-[13px] font-medium text-fg">Always use HTTPS</span>
                  <span className="text-xs text-muted">Redirect HTTP requests at the edge.</span>
                </span>
                <Switch checked={alwaysHttps} disabled={!isAdmin} onCheckedChange={(on) => https.run(on)} />
              </label>
            )}
            <div className="flex items-center justify-between gap-4">
              <span className="flex flex-col">
                <span className="text-[13px] font-medium text-fg">Purge cache</span>
                <span className="text-xs text-muted">Clear everything cached at Cloudflare.</span>
              </span>
              <Button size="sm" disabled={!isAdmin} loading={purge.pending} onClick={async () => { if (await confirm({ title: "Purge all cached files?", confirmLabel: "Purge cache" })) purge.run(); }}>
                <Zap /> Purge
              </Button>
            </div>
          </CardBody>
        </Card>
        <Card className="p-5">
          <p className="text-[13px] font-medium text-fg">Name servers</p>
          <div className="mt-2 flex flex-col gap-1">
            {zone.nameServers.map((n) => (
              <code key={n} className="font-mono text-xs text-muted">{n}</code>
            ))}
          </div>
        </Card>
      </div>

      <RecordDialog key={dialogKey} zoneName={zone.name} record={editing} serverIp={serverIp} open={open} onOpenChange={setOpen} onSave={(r) => save.run(r)} pending={save.pending} />
    </div>
  );
}
