"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { ArrowLeft, ArrowRight, Cable, Check, CheckCircle2, Download, Globe, KeyRound, Loader2, Plus, RotateCw, Server, XCircle } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { LogViewer } from "@/components/log-viewer";
import { SshPublicKey } from "@/components/ssh-public-key";
import { createPrivateKey, createServer, updateServer, validateServer } from "@/server/actions/servers";
import { createTunnelServer } from "@/server/actions/tunnel";
import { JoinCommand } from "@/components/tunnel-join";
import { getServerProgress } from "@/server/actions/servers-ui";
import type { ServerStatus } from "@/server/db/schema";
import { cn } from "@/lib/utils";
import { ProductName } from "@/components/brand";

type Key = { id: string; name: string; publicKey: string; fingerprint: string };
type Step = "connection" | "key" | "connect" | "join";

const STEPS: { id: Step; label: string }[] = [
  { id: "connection", label: "Connection" },
  { id: "key", label: "SSH key" },
  { id: "connect", label: "Connect" },
];

/** A server without a public IP: details, then it runs the join command and gets set up. */
const TUNNEL_STEPS: { id: Step; label: string }[] = [
  { id: "connection", label: "Details" },
  { id: "join", label: "Connect" },
];

function Stepper({ step, steps: STEPS }: { step: Step; steps: { id: Step; label: string }[] }) {
  const index = STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="flex items-center gap-2" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li key={s.id} className={cn("flex min-w-0 items-center gap-2", i < STEPS.length - 1 && "flex-1")}>
          <span
            className={cn(
              "flex size-6 flex-none items-center justify-center rounded-full text-[11px] font-semibold transition-colors",
              i < index ? "bg-accent text-accent-fg" : i === index ? "bg-fg text-bg" : "bg-surface-2 text-muted ring-1 ring-line",
            )}
            aria-current={i === index ? "step" : undefined}
          >
            {i < index ? <Check className="size-3.5" /> : i + 1}
          </span>
          <span className={cn("truncate text-[13px] font-medium", i === index ? "text-fg" : "hidden text-muted sm:inline")}>{s.label}</span>
          {i < STEPS.length - 1 && <span className={cn("h-px min-w-3 flex-1", i < index ? "bg-accent/60" : "bg-line")} />}
        </li>
      ))}
    </ol>
  );
}

type KeyMode = "existing" | "generate" | "import";

export function AddServer({ keys: initialKeys, tunnel }: { keys: Key[]; tunnel: { address: string; port: number } }) {
  const router = useRouter();
  const [step, setStep] = React.useState<Step>("connection");
  // Reachable over SSH, or without a public IP (it connects out through a tunnel).
  const [reach, setReach] = React.useState<"ssh" | "tunnel">("ssh");
  const [tunnelForm, setTunnelForm] = React.useState({ address: tunnel.address, sshPort: "22" });
  const [joined, setJoined] = React.useState<{ id: string; command: string; expiresAt: string } | null>(null);
  const [conn, setConn] = React.useState({ name: "", host: "", port: "22", username: "root" });
  const [keys, setKeys] = React.useState(initialKeys);
  const [keyMode, setKeyMode] = React.useState<KeyMode>(initialKeys.length ? "existing" : "generate");
  const [keyId, setKeyId] = React.useState<string | null>(initialKeys[0]?.id ?? null);
  const [pem, setPem] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [serverId, setServerId] = React.useState<string | null>(null);

  const key = keys.find((k) => k.id === keyId) ?? null;
  const port = Number(conn.port) || 22;
  const connectionValid = conn.name.trim() && conn.host.trim() && port > 0 && port < 65536 && conn.username.trim();
  const sshPort = Number(tunnelForm.sshPort) || 22;
  const tunnelValid = conn.name.trim() && conn.username.trim() && tunnelForm.address.trim() && sshPort > 0 && sshPort < 65536;

  async function createTunnel() {
    setBusy(true);
    const res = await createTunnelServer({
      name: conn.name.trim(),
      username: conn.username.trim(),
      sshPort,
      address: tunnelForm.address.trim(),
      origin: window.location.origin,
    });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    setJoined(res.data);
    setServerId(res.data.id);
    setStep("join");
    router.refresh();
  }

  async function prepareKey() {
    if (keyMode === "existing") return key;
    setBusy(true);
    const res = await createPrivateKey({ name: `${conn.name.trim() || conn.host.trim()} key`, privateKey: keyMode === "import" ? pem : undefined });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return null;
    }
    const created = { id: res.data.id, name: `${conn.name.trim() || conn.host.trim()} key`, publicKey: res.data.publicKey, fingerprint: res.data.fingerprint };
    setKeys((k) => [created, ...k]);
    setKeyId(created.id);
    setKeyMode("existing");
    return created;
  }

  async function connect() {
    if (!key) return;
    setBusy(true);
    const payload = { name: conn.name.trim(), host: conn.host.trim(), port, username: conn.username.trim(), privateKeyId: key.id };
    let id = serverId;
    if (id) {
      const res = await updateServer(id, payload);
      if (!res.ok) {
        setBusy(false);
        toast.error(res.error);
        return;
      }
    } else {
      const res = await createServer(payload);
      if (!res.ok) {
        setBusy(false);
        toast.error(res.error);
        return;
      }
      id = res.data.id;
      setServerId(id);
    }
    const v = await validateServer(id);
    setBusy(false);
    if (!v.ok) {
      toast.error(v.error);
      return;
    }
    setStep("connect");
    router.refresh();
  }

  return (
    <div className="flex animate-rise flex-col gap-5">
      <Stepper step={step} steps={reach === "tunnel" ? TUNNEL_STEPS : STEPS} />

      {step === "connection" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (reach === "tunnel") {
              if (tunnelValid) void createTunnel();
            } else if (connectionValid) setStep("key");
          }}
        >
          <Card>
            <CardHeader
              title="Where is the server?"
              description={
                <>
                  Any Linux machine with SSH. <ProductName /> connects as this user to install and run Docker.
                </>
              }
            />
            <CardBody className="flex flex-col gap-4 py-5">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="How to reach the server">
                {(
                  [
                    ["ssh", "Public IP or hostname", "A VPS or any machine reachable over SSH", Globe],
                    ["tunnel", "No public IP", "Home or office internet, shared IP, behind NAT", Cable],
                  ] as const
                ).map(([value, label, hint, Icon]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={reach === value}
                    onClick={() => setReach(value)}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow]",
                      reach === value ? "border-accent bg-accent-soft/50 ring-3 ring-[var(--ring)]/25" : "border-line bg-surface hover:bg-surface-2",
                    )}
                  >
                    <Icon className={cn("size-4 flex-none", reach === value ? "text-accent" : "text-muted")} />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-[13px] font-medium text-fg">{label}</span>
                      <span className="truncate text-[11.5px] text-muted">{hint}</span>
                    </span>
                  </button>
                ))}
              </div>
              <Field
                label="Name"
                description={
                  <>
                    Shown in <ProductName />, for example the provider and region.
                  </>
                }
              >
                <Input value={conn.name} onChange={(e) => setConn({ ...conn, name: e.target.value })} placeholder="hetzner-fsn-1" autoFocus />
              </Field>
              {reach === "ssh" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_110px]">
                  <Field label="IP address or hostname">
                    <Input
                      value={conn.host}
                      onChange={(e) => setConn({ ...conn, host: e.target.value })}
                      placeholder="203.0.113.10"
                      className="font-mono"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  <Field label="SSH port">
                    <Input
                      value={conn.port}
                      onChange={(e) => setConn({ ...conn, port: e.target.value.replace(/\D/g, "").slice(0, 5) })}
                      inputMode="numeric"
                      className="font-mono"
                    />
                  </Field>
                </div>
              )}
              <Field label="User" description="root, or a user with passwordless sudo who can run Docker.">
                <Input
                  value={conn.username}
                  onChange={(e) => setConn({ ...conn, username: e.target.value })}
                  className="font-mono sm:max-w-56"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              {reach === "tunnel" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_110px]">
                  <Field
                    label={
                      <>
                        This <ProductName /> machine&apos;s address
                      </>
                    }
                    description={`The server connects out to it on TCP ${tunnel.port}: its public IP or a host name that is not behind Cloudflare's proxy.`}
                  >
                    <Input
                      value={tunnelForm.address}
                      onChange={(e) => setTunnelForm({ ...tunnelForm, address: e.target.value.trim() })}
                      placeholder="203.0.113.10"
                      className="font-mono"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  <Field label="Its SSH port" description="On the server itself.">
                    <Input
                      value={tunnelForm.sshPort}
                      onChange={(e) => setTunnelForm({ ...tunnelForm, sshPort: e.target.value.replace(/\D/g, "").slice(0, 5) })}
                      inputMode="numeric"
                      className="font-mono"
                    />
                  </Field>
                </div>
              )}
            </CardBody>
            <CardFooter className="justify-end">
              <Button type="submit" variant="primary" disabled={reach === "tunnel" ? !tunnelValid : !connectionValid} loading={reach === "tunnel" && busy}>
                {reach === "tunnel" ? "Create join command" : "Continue"} <ArrowRight />
              </Button>
            </CardFooter>
          </Card>
        </form>
      )}

      {step === "key" && (
        <Card>
          <CardHeader
            title={
              <>
                How does <ProductName /> sign in?
              </>
            }
            description={
              <>
                <ProductName /> uses an SSH key. Authorize its public key on the server, then connect.
              </>
            }
          />
          <CardBody className="flex flex-col gap-4 py-5">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="SSH key">
              {(
                [
                  ["existing", "Saved key", `${keys.length} available`, KeyRound, keys.length === 0],
                  ["generate", "Generate new", "ed25519, recommended", Plus, false],
                  ["import", "Paste a key", "Your own private key", Download, false],
                ] as const
              ).map(([value, label, hint, Icon, disabled]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={keyMode === value}
                  disabled={disabled}
                  onClick={() => setKeyMode(value)}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] disabled:opacity-40",
                    keyMode === value ? "border-accent bg-accent-soft/50 ring-3 ring-[var(--ring)]/25" : "border-line bg-surface hover:bg-surface-2",
                  )}
                >
                  <Icon className={cn("size-4 flex-none", keyMode === value ? "text-accent" : "text-muted")} />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[13px] font-medium text-fg">{label}</span>
                    <span className="truncate text-[11.5px] text-muted">{hint}</span>
                  </span>
                </button>
              ))}
            </div>

            {keyMode === "existing" && (
              <>
                <div className="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {keys.map((k) => (
                    <label
                      key={k.id}
                      className={cn("flex cursor-pointer items-center gap-3 px-3.5 py-2.5 transition-colors", keyId === k.id ? "bg-accent-soft/40" : "hover:bg-surface-2")}
                    >
                      <input type="radio" name="key" className="accent-[var(--accent)]" checked={keyId === k.id} onChange={() => setKeyId(k.id)} />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-[13px] font-medium text-fg">{k.name}</span>
                        <span className="truncate font-mono text-[11px] text-muted">{k.fingerprint}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {key && <SshPublicKey publicKey={key.publicKey} user={conn.username} />}
              </>
            )}
            {keyMode === "generate" && (
              <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] leading-relaxed text-muted">
                <ProductName /> creates a new key pair for this server. Next, you copy its public key to the server. The private key is encrypted and never leaves <ProductName />.
              </p>
            )}
            {keyMode === "import" && (
              <Field label="Private key" description="OpenSSH or PEM format, without a passphrase.">
                <Textarea
                  value={pem}
                  onChange={(e) => setPem(e.target.value)}
                  rows={6}
                  placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----"}
                  className="font-mono text-[12px]"
                  spellCheck={false}
                />
              </Field>
            )}
          </CardBody>
          <CardFooter className="justify-between">
            <Button variant="ghost" onClick={() => setStep("connection")}>
              <ArrowLeft /> Back
            </Button>
            {keyMode === "existing" ? (
              <Button variant="primary" disabled={!key} loading={busy} onClick={() => void connect()}>
                I added the key, connect <ArrowRight />
              </Button>
            ) : (
              <Button variant="primary" loading={busy} disabled={keyMode === "import" && !pem.trim()} onClick={() => void prepareKey()}>
                {keyMode === "import" ? "Import key" : "Generate key"}
              </Button>
            )}
          </CardFooter>
        </Card>
      )}

      {step === "connect" && serverId && <ConnectStep serverId={serverId} name={conn.name} onBack={() => setStep("key")} />}
      {step === "join" && joined && (
        <JoinStep
          serverId={joined.id}
          name={conn.name}
          command={joined.command}
          expiresAt={joined.expiresAt}
          user={conn.username}
          address={tunnelForm.address}
          port={tunnel.port}
        />
      )}
    </div>
  );
}

type Progress = { status: ServerStatus; statusMessage: string | null; setupLog: string };

/** Live log of the setup job, with the next action for every outcome. */
export function ServerSetupProgress({ serverId, onReady, compact }: { serverId: string; onReady?: () => void; compact?: boolean }) {
  const router = useRouter();
  const [progress, setProgress] = React.useState<Progress | null>(null);
  const [tick, setTick] = React.useState(0);
  const [pending, setPending] = React.useState<"retry" | "install" | null>(null);
  const readyRef = React.useRef(onReady);
  React.useLayoutEffect(() => {
    readyRef.current = onReady;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` restarts polling after a retry.
  React.useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const res = await getServerProgress(serverId);
      if (stop) return;
      if (res.ok) {
        setProgress(res.data);
        if (res.data.status === "ready") {
          readyRef.current?.();
          router.refresh();
          return;
        }
        if (res.data.status !== "validating") {
          router.refresh();
          return;
        }
      }
      timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [serverId, tick, router]);

  const rerun = async (installDocker: boolean) => {
    setPending(installDocker ? "install" : "retry");
    const res = await validateServer(serverId, { installDocker });
    setPending(null);
    if (!res.ok) return toast.error(res.error);
    setProgress((p) => (p ? { ...p, status: "validating", statusMessage: "Queued", setupLog: "" } : p));
    setTick((t) => t + 1);
  };

  const status = progress?.status ?? "validating";
  const noDocker = /docker is not installed/i.test(progress?.statusMessage ?? "");
  const lines = (progress?.setupLog ?? "")
    .split("\n")
    .filter((l, i, all) => l || i < all.length - 1)
    .map((text) => ({ text }));

  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          "flex flex-col gap-3 rounded-xl px-3.5 py-3 sm:flex-row sm:items-start",
          status === "ready" ? "bg-ok-soft" : status === "validating" ? "bg-info-soft" : "bg-bad-soft",
        )}
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {status === "ready" ? (
            <CheckCircle2 className="mt-0.5 size-4 flex-none text-ok" />
          ) : status === "validating" ? (
            <RotateCw className="mt-0.5 size-4 flex-none animate-spin text-info" />
          ) : (
            <XCircle className="mt-0.5 size-4 flex-none text-bad" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-[13px] font-medium text-fg">
              {status === "ready"
                ? "Connected. The server is ready."
                : status === "validating"
                  ? progress?.statusMessage === "Queued"
                    ? "Waiting for the worker…"
                    : "Connecting and preparing the server…"
                  : noDocker
                    ? "Docker is not installed"
                    : "Could not finish the setup"}
            </p>
            {status !== "validating" && status !== "ready" && progress?.statusMessage && (
              <p className="text-[12.5px] leading-relaxed break-words text-fg-2">
                {noDocker ? "Docker can be installed with the official script from get.docker.com. It takes a few minutes." : progress.statusMessage}
              </p>
            )}
          </div>
        </div>
        {status !== "validating" && status !== "ready" && (
          <div className="flex flex-none gap-2 pl-7 sm:pl-0">
            {noDocker ? (
              <Button size="xs" variant="primary" loading={pending === "install"} onClick={() => void rerun(true)}>
                <Download /> Install Docker
              </Button>
            ) : (
              <Button size="xs" loading={pending === "retry"} onClick={() => void rerun(false)}>
                <RotateCw /> Try again
              </Button>
            )}
          </div>
        )}
      </div>
      <LogViewer lines={lines} height={compact ? "min(40vh, 320px)" : "min(46vh, 380px)"} emptyText="Waiting for the setup to start…" filename="server-setup.log" />
    </div>
  );
}

function ConnectStep({ serverId, name, onBack }: { serverId: string; name: string; onBack: () => void }) {
  const [ready, setReady] = React.useState(false);
  return (
    <Card>
      <CardHeader
        title={`Connecting to ${name || "the server"}`}
        description={
          <>
            <ProductName /> checks SSH access and Docker, prepares its data directory and starts the proxy.
          </>
        }
      />
      <CardBody className="py-5">
        <ServerSetupProgress serverId={serverId} onReady={() => setReady(true)} />
      </CardBody>
      <CardFooter className="justify-between">
        <Button variant="ghost" onClick={onBack} disabled={ready}>
          <ArrowLeft /> Change key or connection
        </Button>
        <Link href={`/servers/${serverId}`} className={buttonVariants({ variant: ready ? "primary" : "secondary" })}>
          <Server /> {ready ? "Open server" : "Open server page"}
        </Link>
      </CardFooter>
    </Card>
  );
}

/** Waits for a server that connects out to run its join command, then follows its setup. */
function JoinStep(props: { serverId: string; name: string; command: string; expiresAt: string; user: string; address: string; port: number }) {
  const router = useRouter();
  const [connected, setConnected] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    if (connected) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const res = await getServerProgress(props.serverId);
      if (stop) return;
      // Connected (or already past waiting): the setup log takes over.
      if (res.ok && (res.data.tunnel?.connectedAt || res.data.status !== "pending")) {
        setConnected(true);
        router.refresh();
        return;
      }
      timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [connected, props.serverId, router]);
  return (
    <Card>
      <CardHeader
        title={connected ? `Setting up ${props.name}` : `Connect ${props.name}`}
        description={
          connected ? (
            <>
              Connected through the tunnel. <ProductName /> checks Docker, prepares its data directory and starts the proxy.
            </>
          ) : (
            "Run the command on the server. This page moves on by itself when it connects."
          )
        }
      />
      <CardBody className="flex flex-col gap-4 py-5">
        {connected ? (
          <ServerSetupProgress serverId={props.serverId} onReady={() => setReady(true)} />
        ) : (
          <>
            <JoinCommand command={props.command} expiresAt={props.expiresAt} user={props.user} address={props.address} port={props.port} />
            <p className="flex items-center gap-2 text-[13px] text-muted">
              <Loader2 className="size-4 animate-spin text-info" /> Waiting for {props.name} to connect…
            </p>
          </>
        )}
      </CardBody>
      <CardFooter className="justify-end">
        <Link href={`/servers/${props.serverId}`} className={buttonVariants({ variant: ready ? "primary" : "secondary" })}>
          <Server /> {ready ? "Open server" : "Open server page"}
        </Link>
      </CardFooter>
    </Card>
  );
}
