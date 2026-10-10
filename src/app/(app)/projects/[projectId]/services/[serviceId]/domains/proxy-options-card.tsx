"use client";

import { cn } from "@/lib/utils";
import { ReadOnlyFooter } from "@/components/read-only";
import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardHeader } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, InputGroup, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch, SwitchRow } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { updateServiceProxy } from "@/server/actions/service-proxy";
import type { ServiceProxyConfig } from "@/server/services/proxy-config";
import { type Balancing, balancingOf } from "@/lib/balancing";

type Initial = Omit<ServiceProxyConfig, "basicAuth" | "guests"> & { basicAuthUser: string | null; basicAuthHasBcrypt?: boolean; guests?: { id: string; email: string }[] };
/** password: empty keeps the saved one. */
type Guest = { id?: string; email: string; password: string /** A saved guest whose password is being changed. */; change?: boolean };

type Form = {
  maxBodySize: string;
  connectTimeout: string;
  readTimeout: string;
  websockets: boolean;
  buffering: boolean;
  balancing: Balancing;
  login: boolean;
  guests: Guest[];
  authOn: boolean;
  authUser: string;
  authPassword: string;
  allow: string;
  deny: string;
  headers: { name: string; value: string }[];
  securityHeaders: boolean;
  cors: string;
  wwwRedirect: "none" | "to-apex" | "to-www";
  gzip: boolean;
  cacheStatic: boolean;
  customDirectives: string;
  caddyDirectives: string;
  traefikMiddlewares: string;
};

function toForm(c: Initial | null): Form {
  return {
    maxBodySize: c?.maxBodySize ?? "",
    connectTimeout: c?.connectTimeout ? String(c.connectTimeout) : "",
    readTimeout: c?.readTimeout ? String(c.readTimeout) : "",
    websockets: c?.websockets ?? true,
    buffering: c?.buffering ?? true,
    balancing: balancingOf(c),
    login: c?.login ?? false,
    guests: (c?.guests ?? []).map((g) => ({ id: g.id, email: g.email, password: "" })),
    authOn: !!c?.basicAuthUser,
    authUser: c?.basicAuthUser ?? "",
    authPassword: "",
    allow: (c?.allow ?? []).join("\n"),
    deny: (c?.deny ?? []).join("\n"),
    headers: c?.headers ?? [],
    securityHeaders: c?.securityHeaders ?? false,
    cors: (c?.corsOrigins ?? []).join("\n"),
    wwwRedirect: c?.wwwRedirect ?? "none",
    gzip: c?.gzip ?? true,
    cacheStatic: c?.cacheStatic ?? false,
    customDirectives: c?.customDirectives ?? "",
    caddyDirectives: c?.caddyDirectives ?? "",
    traefikMiddlewares: c?.traefikMiddlewares ?? "",
  };
}

const lines = (v: string) =>
  v
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
const seconds = (v: string) => (v.trim() ? Number(v.replace(/\D/g, "")) || null : null);

/** What the picked strategy does, in the words of this proxy. */
function balancingHelp(b: Balancing, proxyKind: "nginx" | "caddy" | "traefik", across?: { main: string; others: number }) {
  if (b === "least-busy") return "Each visitor goes to the replica with the fewest open requests. Good when some requests are slow, like uploads, streams or AI calls.";
  if (b === "sticky")
    return `Each visitor keeps reaching the same replica, on this server or another one. Needed for Socket.IO and sessions kept in memory. ${
      proxyKind === "traefik" ? "Traefik remembers the replica in a cookie." : "Visitors are matched by their IP address."
    }`;
  if (b === "main-first")
    return across
      ? `Visitors only reach the replicas on ${across.main}. When none of them answers its health check, the other ${across.others === 1 ? "server takes" : `${across.others} servers take`} the visitors until ${across.main} is back, within about 10 seconds.`
      : "Load balancing across servers is off, so the replicas here share visitors in turn.";
  return "Each replica gets visitors in turn.";
}

const KIND_LABEL = { nginx: "nginx", caddy: "Caddy", traefik: "Traefik" } as const;

/** Per-service HTTP options (limits, access control, headers, performance, raw directives for the server's proxy). */
export function ProxyOptionsCard({
  serviceId,
  initial,
  isAdmin,
  isInstanceAdmin,
  hasTls,
  proxyKind = "nginx",
  behindProxy = false,
  replicas = 0,
  across,
  dashboardDomain = true,
  only,
}: {
  serviceId: string;
  initial: Initial | null;
  isAdmin: boolean;
  isInstanceAdmin: boolean;
  hasTls: boolean;
  proxyKind?: "nginx" | "caddy" | "traefik";
  /** The server trusts proxies in front of it (Cloudflare, a load balancer). */
  behindProxy?: boolean;
  /** Replicas of an app on this server; 0 for other services. */
  replicas?: number;
  /** The app is load balanced over several servers: the main one and these others. */
  across?: { main: string; others: number };
  /** The dashboard has its own domain: visitors (and other servers) reach the sign-in there. */
  dashboardDomain?: boolean;
  /** Only one group of cards: a section of Domains & ports, or Settings → Access control. */
  only?: ProxySection;
}) {
  const [saved, setSaved] = React.useState<Form>(() => toForm(initial));
  const disabled = !isAdmin;
  // Each card saves only its own fields; the others go along as they were saved.
  const props = { serviceId, saved, onSaved: setSaved, disabled, proxyLabel: KIND_LABEL[proxyKind] };
  const showBalancing = replicas > 1 || !!across || balancingOf(initial) !== "round-robin";
  const access = (
    <>
      <OptionsCard
        {...props}
        title="HTTP Basic Auth"
        description="One shared user name and password. The browser asks for it in its own pop-up."
        keys={["authOn", "authUser", "authPassword"]}
        toggle="authOn"
      >
        {(form, set) => (
          <>
            {form.authOn && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="User name">
                  <Input value={form.authUser} onChange={(e) => set("authUser", e.target.value)} placeholder="admin" />
                </Field>
                <Field
                  label="Password"
                  error={
                    proxyKind === "caddy" && initial?.basicAuthUser && !initial.basicAuthHasBcrypt && !form.authPassword
                      ? "Enter the password again: Caddy needs a new hash. Until then the site answers 503."
                      : undefined
                  }
                  description={initial?.basicAuthUser ? "Leave empty to keep the current password." : undefined}
                >
                  <Input
                    type="password"
                    value={form.authPassword}
                    onChange={(e) => set("authPassword", e.target.value)}
                    placeholder={initial?.basicAuthUser ? "••••••••" : "At least 6 characters"}
                  />
                </Field>
              </div>
            )}
          </>
        )}
      </OptionsCard>
      <OptionsCard {...props} title="Login wall" description="Visitors sign in before they reach the app." keys={["login", "guests"]}>
        {(form, set) => (
          <>
            <SwitchRow
              title="Only my team"
              description="Members who can open this project sign in with their Serve account; nobody else gets in."
              checked={form.login}
              onCheckedChange={(v) => set("login", v)}
            />
            <div className="flex flex-col gap-2">
              <div>
                <p className="text-[13px] font-medium text-fg-2">Guest logins</p>
                <p className="text-xs text-muted">People without a Serve account. They sign in with the email and password you set here.</p>
              </div>
              {form.guests.map((g, i) => {
                const update = (patch: Partial<Guest>) =>
                  set(
                    "guests",
                    form.guests.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                  );
                const remove = (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      set(
                        "guests",
                        form.guests.filter((_, j) => j !== i),
                      )
                    }
                    aria-label={`Remove ${g.email || "guest"}`}
                  >
                    <Trash2 />
                  </Button>
                );
                // A saved guest: the email, and a new password only when asked for.
                if (g.id && !g.change)
                  return (
                    <div key={g.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{g.email}</span>
                      <Button size="sm" variant="ghost" onClick={() => update({ change: true })}>
                        Change password
                      </Button>
                      {remove}
                    </div>
                  );
                // A new guest (saved on Apply), or a saved one getting a new password.
                return (
                  <div key={g.id ?? `new-${i}`} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{g.email}</span>
                    {g.id ? (
                      <Input
                        type="password"
                        autoFocus
                        value={g.password}
                        onChange={(e) => update({ password: e.target.value })}
                        placeholder="New password, 8+ characters"
                        aria-label={`New password for ${g.email}`}
                        className="h-7 w-56 text-[13px]"
                      />
                    ) : (
                      <span className="text-xs text-faint">New</span>
                    )}
                    {remove}
                  </div>
                );
              })}
              <GuestAdder taken={form.guests.map((g) => g.email.trim().toLowerCase())} onAdd={(g) => set("guests", [...form.guests, g])} />
            </div>
            {(form.login || form.guests.some((g) => g.email.trim())) && !dashboardDomain && (
              <p className="text-[12.5px] text-warn">Give the dashboard its own domain in Settings first. Visitors sign in there, and other servers check sign-ins there.</p>
            )}
          </>
        )}
      </OptionsCard>
      <OptionsCard {...props} title="IP rules" description="Let in or keep out addresses and networks." keys={["allow", "deny"]}>
        {(form, set) => (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Allow only" optional description="One IP or CIDR per line. Everyone else gets 403.">
                <Textarea
                  value={form.allow}
                  onChange={(e) => set("allow", e.target.value)}
                  placeholder={"203.0.113.10\n10.0.0.0/8"}
                  rows={3}
                  className="min-h-20 font-mono text-[12.5px]"
                />
              </Field>
              <Field
                label="Block"
                optional
                description={
                  proxyKind === "traefik" && behindProxy
                    ? "One IP or CIDR per line. With Traefik behind a proxy this list does not see visitors' own addresses, so it blocks nobody. Use nginx or Caddy to block visitors."
                    : proxyKind === "traefik"
                      ? "One IP or CIDR per line. Traefik has no block list: blocked visitors get the 404 page, and visitors through a Cloudflare Tunnel cannot be blocked here."
                      : "One IP or CIDR per line."
                }
              >
                <Textarea value={form.deny} onChange={(e) => set("deny", e.target.value)} placeholder="198.51.100.0/24" rows={3} className="min-h-20 font-mono text-[12.5px]" />
              </Field>
            </div>
          </>
        )}
      </OptionsCard>
    </>
  );
  if (only === "access") return <div className="flex flex-col gap-6">{access}</div>;
  const show = (section: ProxySection) => !only || only === section;
  return (
    <>
      {show("traffic") && (
        <OptionsCard
          {...props}
          title="Limits and timeouts"
          description="Raise these for large uploads, long requests or streaming."
          keys={["maxBodySize", "connectTimeout", "readTimeout", "websockets", "buffering"]}
        >
          {(form, set) => (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field label="Max request body" optional description="Like 10m or 1g. Server default otherwise.">
                  <Input value={form.maxBodySize} onChange={(e) => set("maxBodySize", e.target.value)} placeholder="100m" className="font-mono" />
                </Field>
                <Field label="Connect timeout" optional>
                  <InputGroup suffix="s">
                    <Input value={form.connectTimeout} onChange={(e) => set("connectTimeout", e.target.value)} placeholder="10" inputMode="numeric" />
                  </InputGroup>
                </Field>
                <Field label="Read / send timeout" optional>
                  <InputGroup suffix="s">
                    <Input value={form.readTimeout} onChange={(e) => set("readTimeout", e.target.value)} placeholder="300" inputMode="numeric" />
                  </InputGroup>
                </Field>
              </div>
              <SwitchRow title="WebSockets" description="Upgrade connections for WebSocket apps." checked={form.websockets} onCheckedChange={(v) => set("websockets", v)} />
              <SwitchRow
                title="Response buffering"
                description="Turn off for server-sent events and streamed responses, so data reaches the browser at once."
                checked={form.buffering}
                onCheckedChange={(v) => set("buffering", v)}
              />
            </>
          )}
        </OptionsCard>
      )}
      {show("traffic") && showBalancing && (
        <OptionsCard {...props} title="Load balancing" description="How visitors are spread over the replicas." keys={["balancing"]}>
          {(form, set) => (
            <Field label="Strategy" description={balancingHelp(form.balancing, proxyKind, across)}>
              <Select
                value={form.balancing}
                onValueChange={(v) => set("balancing", v as Balancing)}
                options={[
                  { value: "round-robin", label: "Round robin", description: "Each replica in turn." },
                  { value: "least-busy", label: "Least busy", description: "The replica with the fewest open requests." },
                  { value: "sticky", label: "Sticky sessions", description: "Each visitor keeps the same replica." },
                  ...(across || form.balancing === "main-first"
                    ? [{ value: "main-first", label: "Main server first", description: "Other servers only take over when it fails." }]
                    : []),
                ]}
                className="sm:max-w-sm"
              />
            </Field>
          )}
        </OptionsCard>
      )}
      {show("access") && access}
      {show("headers") && (
        <OptionsCard {...props} title="Headers" description="Response headers added to every request." keys={["securityHeaders", "cors", "headers"]}>
          {(form, set) => (
            <>
              <SwitchRow
                title="Security headers"
                description={`Adds X-Content-Type-Options, Referrer-Policy and X-Frame-Options${hasTls ? ", and HSTS with subdomains" : ""}.`}
                checked={form.securityHeaders}
                onCheckedChange={(v) => set("securityHeaders", v)}
              />
              <Field label="CORS allowed origins" optional description="* or one origin per line, like https://app.example.com. Preflight requests are answered by the proxy.">
                <Textarea
                  value={form.cors}
                  onChange={(e) => set("cors", e.target.value)}
                  placeholder="https://app.example.com"
                  rows={2}
                  className="min-h-16 font-mono text-[12.5px]"
                />
              </Field>
              <div className="flex flex-col gap-2">
                <span className="text-[13px] font-medium text-fg-2">Custom headers</span>
                {form.headers.map((h, i) => (
                  <div key={i} className="grid grid-cols-[minmax(0,1fr)_32px] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_32px]">
                    <Input
                      value={h.name}
                      onChange={(e) =>
                        set(
                          "headers",
                          form.headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                        )
                      }
                      placeholder="X-Robots-Tag"
                      aria-label="Header name"
                      className="h-8 font-mono text-[12.5px]"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="sm:order-3"
                      onClick={() =>
                        set(
                          "headers",
                          form.headers.filter((_, j) => j !== i),
                        )
                      }
                      aria-label="Remove header"
                    >
                      <Trash2 />
                    </Button>
                    <Input
                      value={h.value}
                      onChange={(e) =>
                        set(
                          "headers",
                          form.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                        )
                      }
                      placeholder="noindex"
                      aria-label="Header value"
                      className="col-span-2 h-8 font-mono text-[12.5px] sm:order-2 sm:col-span-1"
                    />
                  </div>
                ))}
                <Button size="sm" variant="ghost" className="w-fit" onClick={() => set("headers", [...form.headers, { name: "", value: "" }])}>
                  <Plus /> Add header
                </Button>
              </div>
            </>
          )}
        </OptionsCard>
      )}
      {show("performance") && (
        <OptionsCard {...props} title="Performance and routing" description="Compression, browser caching and the www redirect." keys={["gzip", "cacheStatic", "wwwRedirect"]}>
          {(form, set) => (
            <>
              <SwitchRow title="Compression" description="Gzip text responses." checked={form.gzip} onCheckedChange={(v) => set("gzip", v)} />
              <SwitchRow
                title="Cache static files"
                description="Browsers keep CSS, JS, images and fonts for 7 days."
                checked={form.cacheStatic}
                onCheckedChange={(v) => set("cacheStatic", v)}
              />
              <Field label="www redirect" description="Works when both example.com and www.example.com are added as domains here.">
                <Select
                  value={form.wwwRedirect}
                  onValueChange={(v) => set("wwwRedirect", v as Form["wwwRedirect"])}
                  options={[
                    { value: "none", label: "No redirect" },
                    { value: "to-apex", label: "www.example.com → example.com" },
                    { value: "to-www", label: "example.com → www.example.com" },
                  ]}
                  className="sm:max-w-sm"
                />
              </Field>
            </>
          )}
        </OptionsCard>
      )}
      {show("proxy") && (
        <OptionsCard
          {...props}
          title="Advanced"
          description={
            proxyKind === "nginx"
              ? "Raw nginx directives inside this service's location block. Tested before they apply."
              : proxyKind === "caddy"
                ? "Raw Caddyfile directives inside this service's route, before the request reaches the app. Tested before they apply."
                : "Extra Traefik middlewares as YAML (name: definition). They run after the built-in ones. Checked against Traefik before they apply."
          }
          keys={["customDirectives", "caddyDirectives", "traefikMiddlewares"]}
        >
          {(form, set) => (
            <>
              <Textarea
                value={proxyKind === "nginx" ? form.customDirectives : proxyKind === "caddy" ? form.caddyDirectives : form.traefikMiddlewares}
                onChange={(e) => set(proxyKind === "nginx" ? "customDirectives" : proxyKind === "caddy" ? "caddyDirectives" : "traefikMiddlewares", e.target.value)}
                disabled={!isInstanceAdmin}
                placeholder={
                  !isInstanceAdmin
                    ? "Only Root organization admins can add custom directives."
                    : proxyKind === "nginx"
                      ? "# Example\nproxy_set_header X-Custom value;"
                      : proxyKind === "caddy"
                        ? "# Example\nheader_up X-Custom value"
                        : "ratelimit:\n  rateLimit:\n    average: 100\n    burst: 50"
                }
                rows={5}
                spellCheck={false}
                className="font-mono text-[12.5px]"
              />
              <p className="text-xs text-muted">Directives for the other proxies are kept and used if this server switches proxy.</p>
            </>
          )}
        </OptionsCard>
      )}
    </>
  );
}

/** The request the server action takes, from the whole form. */
function toInput(form: Form) {
  return {
    maxBodySize: form.maxBodySize.trim() || null,
    connectTimeout: seconds(form.connectTimeout),
    readTimeout: seconds(form.readTimeout),
    websockets: form.websockets,
    buffering: form.buffering,
    balancing: form.balancing,
    login: form.login,
    guests: form.guests.filter((g) => g.email.trim()).map((g) => ({ id: g.id, email: g.email.trim(), password: g.password || undefined })),
    basicAuth: { enabled: form.authOn, username: form.authUser.trim() || undefined, password: form.authPassword || undefined },
    allow: lines(form.allow),
    deny: lines(form.deny),
    headers: form.headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), value: h.value })),
    securityHeaders: form.securityHeaders,
    corsOrigins: lines(form.cors),
    wwwRedirect: form.wwwRedirect,
    gzip: form.gzip,
    cacheStatic: form.cacheStatic,
    customDirectives: form.customDirectives.trim() || null,
    caddyDirectives: form.caddyDirectives.trim() || null,
    traefikMiddlewares: form.traefikMiddlewares.trim() || null,
  };
}

type Set = <K extends keyof Form>(key: K, value: Form[K]) => void;

/** The groups of HTTP options, each a section of Domains & ports. */
export type ProxySection = "traffic" | "access" | "headers" | "performance" | "proxy";

/** One card of HTTP options with its own Apply: it changes only `keys`, the rest stays as saved. */
function OptionsCard({
  serviceId,
  saved,
  onSaved,
  disabled,
  proxyLabel,
  title,
  description,
  keys,
  toggle,
  children,
}: {
  serviceId: string;
  saved: Form;
  onSaved: (form: Form) => void;
  disabled: boolean;
  proxyLabel: string;
  title: string;
  description: React.ReactNode;
  keys: (keyof Form)[];
  /** An on/off option shown as a switch in the header; the body only shows while it is on. */
  toggle?: "authOn";
  children: (form: Form, set: Set) => React.ReactNode;
}) {
  const [draft, setDraft] = React.useState<Partial<Form>>({});
  const [error, setError] = React.useState<string | null>(null);
  const form = { ...saved, ...draft };
  const dirty = keys.some((k) => JSON.stringify(form[k]) !== JSON.stringify(saved[k]));
  const set: Set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const save = useAction(
    async () => {
      setError(null);
      const res = await updateServiceProxy(serviceId, toInput(form));
      if (!res.ok) setError(res.error);
      return res;
    },
    {
      onSuccess: () => {
        onSaved({ ...form, authPassword: "", guests: form.guests.filter((g) => g.email.trim()).map((g) => ({ ...g, password: "", change: false })) });
        setDraft({});
      },
    },
  );
  return (
    <Card>
      <form
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <CardHeader
          title={title}
          description={description}
          actions={toggle && <Switch aria-label={`Turn on ${title}`} checked={form[toggle]} disabled={disabled} onCheckedChange={(v) => set(toggle, v)} />}
        />
        {(!toggle || form[toggle]) && (
          <fieldset disabled={disabled} className={cn("flex min-w-0 flex-col gap-4 px-5 py-5", disabled && "opacity-70")}>
            {children(form, set)}
          </fieldset>
        )}
        {error && <p className="border-t border-line bg-bad-soft/50 px-5 py-3 font-mono text-[12px] leading-relaxed break-words text-bad">{error}</p>}
        {disabled ? (
          <ReadOnlyFooter message="Only organization admins can change HTTP options." />
        ) : (
          <CardFooter>
            <span className="truncate text-xs text-muted">{dirty ? "Unsaved changes" : `${proxyLabel} checks the configuration before applying it`}</span>
            <div className="flex flex-none gap-2">
              {dirty && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setDraft({})}>
                  Discard
                </Button>
              )}
              <Button type="submit" size="sm" variant="primary" disabled={!dirty} loading={save.pending}>
                Apply
              </Button>
            </div>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}

/** Email and password first, then Add guest: the guest joins the list and is saved on Apply. */
function GuestAdder({ taken, onAdd }: { taken: string[]; onAdd: (g: { email: string; password: string }) => void }) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const clean = email.trim().toLowerCase();
  const problem = !clean ? null : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? "Enter a valid email address." : taken.includes(clean) ? "This guest is already on the list." : null;
  const ready = !!clean && !problem && password.length >= 8;
  const add = () => {
    if (!ready) return;
    onAdd({ email: clean, password });
    setEmail("");
    setPassword("");
  };
  // Enter adds the guest instead of applying the whole card.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    add();
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="name@company.com"
          aria-label="Guest email"
          className="h-8 text-[13px]"
        />
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Password, 8+ characters"
          aria-label="Guest password"
          className="h-8 text-[13px]"
        />
        <Button size="sm" variant="secondary" disabled={!ready} onClick={add}>
          <Plus /> Add guest
        </Button>
      </div>
      {problem && <p className="text-xs text-bad">{problem}</p>}
    </div>
  );
}
