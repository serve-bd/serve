"use client";

import * as React from "react";
import { useRouter } from "@/hooks/use-router";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader, Copyable } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, InputGroup, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { saveProxySettings } from "@/server/actions/proxy-kind";
import type { CaddySettings, NginxSettings, ProxyKind, TraefikSettings } from "@/server/proxy/config";

export type TraefikSettingsView = Omit<TraefikSettings, "dashboard"> & { dashboard: { enabled: boolean; hostname: string; username: string; hasPassword: boolean } | null };

const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(/\D/g, "")) || null);
const str = (v: number | null | undefined) => (v == null ? "" : String(v));

function useSettingsForm<T>(serverId: string, kind: ProxyKind, initial: T, toInput: (v: T) => unknown) {
  const router = useRouter();
  const [value, setValue] = React.useState<T>(initial);
  const [saved, setSaved] = React.useState(JSON.stringify(initial));
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const set = (patch: Partial<T>) => setValue((v) => ({ ...v, ...patch }));
  const submit = async () => {
    setError(null);
    setPending(true);
    const res = await saveProxySettings(serverId, kind, toInput(value));
    setPending(false);
    if (!res.ok) return setError(res.error);
    setSaved(JSON.stringify(value));
    router.refresh();
  };
  return { value, set, dirty: JSON.stringify(value) !== saved, error, pending, submit, reset: () => (setValue(JSON.parse(saved)), setError(null)) };
}

function FormCard({
  title,
  description,
  form,
  children,
}: {
  title: string;
  description: React.ReactNode;
  form: ReturnType<typeof useSettingsForm<unknown>>;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <form
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          void form.submit();
        }}
      >
        <CardHeader title={title} description={description} />
        <CardBody className="flex flex-col gap-4 py-5">
          {children}
          {form.error && (
            <Copyable value={form.error}>
              <div className="flex items-start gap-2.5 rounded-xl border border-bad/15 bg-bad-soft/60 py-3 pr-10 pl-3.5">
                <TriangleAlert className="mt-0.5 size-4 flex-none text-bad" />
                <pre className="min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-fg-2">{form.error}</pre>
              </div>
            </Copyable>
          )}
        </CardBody>
        <CardFooter>
          <span className="truncate text-xs text-muted">{form.dirty ? "Unsaved changes" : "Validated by the proxy before it applies"}</span>
          <div className="flex flex-none gap-2">
            {form.dirty && (
              <Button type="button" variant="ghost" size="sm" onClick={form.reset}>
                Discard
              </Button>
            )}
            <Button type="submit" size="sm" variant="primary" disabled={!form.dirty} loading={form.pending}>
              Test and apply
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}

const seconds = (label: string, value: string, onChange: (v: string) => void, placeholder: string, description?: string) => (
  <Field label={label} description={description}>
    <InputGroup suffix="s">
      <Input value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))} placeholder={placeholder} inputMode="numeric" />
    </InputGroup>
  </Field>
);

export function NginxSettingsCard({ serverId, initial, defaultBodySize }: { serverId: string; initial: NginxSettings; defaultBodySize: string }) {
  const start = {
    workerConnections: str(initial.workerConnections),
    maxBodySize: initial.maxBodySize ?? "",
    keepaliveTimeout: str(initial.keepaliveTimeout),
    proxyConnectTimeout: str(initial.proxyConnectTimeout),
    proxyReadTimeout: str(initial.proxyReadTimeout),
    gzipLevel: str(initial.gzipLevel),
    serverTokens: !!initial.serverTokens,
  };
  const form = useSettingsForm(serverId, "nginx", start, (v) => ({
    workerConnections: num(v.workerConnections),
    maxBodySize: v.maxBodySize.trim() || null,
    keepaliveTimeout: num(v.keepaliveTimeout),
    proxyConnectTimeout: num(v.proxyConnectTimeout),
    proxyReadTimeout: num(v.proxyReadTimeout),
    gzipLevel: num(v.gzipLevel),
    serverTokens: v.serverTokens,
  }));
  const v = form.value;
  return (
    <FormCard title="nginx settings" description="Global settings for nginx on this server. Empty fields keep nginx's defaults." form={form as never}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Max upload size" description={`Largest request body this server's proxy accepts, like 100m or 1g. Default ${defaultBodySize}.`}>
          <Input value={v.maxBodySize} onChange={(e) => form.set({ maxBodySize: e.target.value })} placeholder={defaultBodySize} className="font-mono" />
        </Field>
        <Field label="Worker connections">
          <Input value={v.workerConnections} onChange={(e) => form.set({ workerConnections: e.target.value.replace(/\D/g, "") })} placeholder="8192" inputMode="numeric" />
        </Field>
        {seconds("Connect timeout", v.proxyConnectTimeout, (x) => form.set({ proxyConnectTimeout: x }), "10")}
        {seconds("Read / send timeout", v.proxyReadTimeout, (x) => form.set({ proxyReadTimeout: x }), "300")}
        {seconds("Keep-alive timeout", v.keepaliveTimeout, (x) => form.set({ keepaliveTimeout: x }), "65")}
        <Field label="Gzip level" description="1 is fastest, 9 compresses most.">
          <Select
            value={v.gzipLevel || "5"}
            onValueChange={(x) => form.set({ gzipLevel: x })}
            options={["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((x) => ({ value: x, label: x }))}
          />
        </Field>
      </div>
      <SwitchRow
        title="Show the nginx version"
        description="Adds the version to error pages and the Server header."
        checked={v.serverTokens}
        onCheckedChange={(x) => form.set({ serverTokens: x })}
      />
    </FormCard>
  );
}

export function CaddySettingsCard({ serverId, initial, acmeEmail }: { serverId: string; initial: CaddySettings; acmeEmail: string | null }) {
  const start = {
    email: initial.email ?? "",
    logLevel: initial.logLevel ?? "INFO",
    http3: !!initial.http3,
    readTimeout: str(initial.readTimeout),
    writeTimeout: str(initial.writeTimeout),
    idleTimeout: str(initial.idleTimeout),
    rawGlobal: initial.rawGlobal ?? "",
  };
  const form = useSettingsForm(serverId, "caddy", start, (v) => ({
    email: v.email.trim() || null,
    logLevel: v.logLevel,
    http3: v.http3,
    readTimeout: num(v.readTimeout),
    writeTimeout: num(v.writeTimeout),
    idleTimeout: num(v.idleTimeout),
    rawGlobal: v.rawGlobal,
  }));
  const v = form.value;
  return (
    <FormCard title="Caddy settings" description="Caddy obtains and renews HTTPS certificates for every domain by itself." form={form as never}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="ACME email" optional description={acmeEmail ? `Default ${acmeEmail} from Settings.` : "Used for certificate expiry notices."}>
          <Input type="email" value={v.email} onChange={(e) => form.set({ email: e.target.value })} placeholder={acmeEmail ?? "ops@example.com"} />
        </Field>
        <Field label="Log level">
          <Select
            value={v.logLevel}
            onValueChange={(x) => form.set({ logLevel: x as typeof v.logLevel })}
            options={["DEBUG", "INFO", "WARN", "ERROR"].map((x) => ({ value: x, label: x }))}
          />
        </Field>
        {seconds("Read body timeout", v.readTimeout, (x) => form.set({ readTimeout: x }), "none")}
        {seconds("Write timeout", v.writeTimeout, (x) => form.set({ writeTimeout: x }), "none")}
        {seconds("Idle timeout", v.idleTimeout, (x) => form.set({ idleTimeout: x }), "300")}
      </div>
      <SwitchRow
        title="HTTP/3"
        description="Also listen on UDP 443 for HTTP/3 (QUIC). Open UDP 443 in the firewall."
        checked={v.http3}
        onCheckedChange={(x) => form.set({ http3: x })}
      />
      <Field label="Extra global options" description="Lines inside Caddy's global options block.">
        <Textarea
          value={v.rawGlobal}
          onChange={(e) => form.set({ rawGlobal: e.target.value })}
          rows={4}
          spellCheck={false}
          placeholder={"# Example\nocsp_stapling off"}
          className="font-mono text-[12.5px]"
        />
      </Field>
    </FormCard>
  );
}

export function TraefikSettingsCard({
  serverId,
  initial,
  cloudflareAccounts,
}: {
  serverId: string;
  initial: TraefikSettingsView;
  cloudflareAccounts: { id: string; name: string }[];
}) {
  const start = {
    logLevel: initial.logLevel ?? "INFO",
    accessLog: initial.accessLog !== false,
    metrics: !!initial.metrics,
    acmeChallenge: initial.acmeChallenge ?? "http",
    cloudflareAccountId: initial.cloudflareAccountId ?? "",
    dashboardEnabled: !!initial.dashboard?.enabled,
    dashboardHost: initial.dashboard?.hostname ?? "",
    dashboardUser: initial.dashboard?.username ?? "admin",
    dashboardPassword: "",
  };
  const form = useSettingsForm(serverId, "traefik", start, (v) => ({
    logLevel: v.logLevel,
    accessLog: v.accessLog,
    metrics: v.metrics,
    acmeChallenge: v.acmeChallenge,
    cloudflareAccountId: v.acmeChallenge === "dns-cloudflare" ? v.cloudflareAccountId || null : null,
    dashboard: { enabled: v.dashboardEnabled, hostname: v.dashboardHost || undefined, username: v.dashboardUser || undefined, password: v.dashboardPassword || undefined },
  }));
  const v = form.value;
  return (
    <FormCard title="Traefik settings" description="Changes to static options restart Traefik for a moment; dynamic ones apply live." form={form as never}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Certificate challenge" description="How Let's Encrypt checks domain ownership (needs an email in Settings).">
          <Select
            value={v.acmeChallenge}
            onValueChange={(x) => form.set({ acmeChallenge: x as typeof v.acmeChallenge })}
            options={[
              { value: "http", label: "HTTP (port 80)" },
              { value: "tls", label: "TLS-ALPN (port 443)" },
              { value: "dns-cloudflare", label: "Cloudflare DNS", disabled: cloudflareAccounts.length === 0 },
            ]}
          />
        </Field>
        {v.acmeChallenge === "dns-cloudflare" && (
          <Field label="Cloudflare account">
            <Select
              value={v.cloudflareAccountId || null}
              onValueChange={(x) => form.set({ cloudflareAccountId: x })}
              options={cloudflareAccounts.map((a) => ({ value: a.id, label: a.name }))}
              placeholder="Choose an account"
            />
          </Field>
        )}
        <Field label="Log level">
          <Select
            value={v.logLevel}
            onValueChange={(x) => form.set({ logLevel: x as typeof v.logLevel })}
            options={["DEBUG", "INFO", "WARN", "ERROR"].map((x) => ({ value: x, label: x }))}
          />
        </Field>
      </div>
      <SwitchRow
        title="Access log"
        description="Feeds request analytics. Turning it off stops traffic charts for this server."
        checked={v.accessLog}
        onCheckedChange={(x) => form.set({ accessLog: x })}
      />
      <SwitchRow
        title="Prometheus metrics"
        description="Exposes /metrics inside the container (loopback only)."
        checked={v.metrics}
        onCheckedChange={(x) => form.set({ metrics: x })}
      />
      <SwitchRow
        title="Traefik dashboard"
        description="Served on its own hostname with a password."
        checked={v.dashboardEnabled}
        onCheckedChange={(x) => form.set({ dashboardEnabled: x })}
      />
      {v.dashboardEnabled && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Hostname">
            <Input value={v.dashboardHost} onChange={(e) => form.set({ dashboardHost: e.target.value.trim().toLowerCase() })} placeholder="traefik.example.com" />
          </Field>
          <Field label="User">
            <Input value={v.dashboardUser} onChange={(e) => form.set({ dashboardUser: e.target.value })} />
          </Field>
          <Field label="Password" description={initial.dashboard?.hasPassword ? "Leave empty to keep it." : undefined}>
            <Input type="password" value={v.dashboardPassword} onChange={(e) => form.set({ dashboardPassword: e.target.value })} />
          </Field>
        </div>
      )}
    </FormCard>
  );
}
