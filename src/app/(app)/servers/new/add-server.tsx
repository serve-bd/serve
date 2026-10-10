"use client";

import { showError } from "@/hooks/use-action";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { ArrowLeft, ArrowRight, Cable, Check, CheckCircle2, Download, Globe, KeyRound, Loader2, Network, Plus, RotateCw, Server, TriangleAlert, XCircle } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { MaskedInput } from "@/components/ui/masked-input";
import { LogViewer } from "@/components/log-viewer";
import { SshPublicKey } from "@/components/ssh-public-key";
import { createPrivateKey, createServer, updateServer, validateServer } from "@/server/actions/servers";
import { createTunnelServer, newJoinCommand } from "@/server/actions/tunnel";
import { useNow } from "@/hooks/use-client";
import { JoinCommand } from "@/components/tunnel-join";
import { TailscaleJoinCommand } from "@/components/tailscale-join";
import { Select } from "@/components/ui/select";
import { createTailscaleServer, tailscaleJoinCommand } from "@/server/actions/tailscale";
import { getServerProgress } from "@/server/actions/servers-ui";
import type { ServerStatus } from "@/server/db/schema";
import { cn } from "@/lib/utils";

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

type Tailnet = { id: string; name: string };

/**
 * `onFinished`: shown as a Continue button once the server exists, in place of the link to its page (onboarding).
 * `tailnets`: connected tailnets, for Root admins (null: the option is not offered).
 */
export function AddServer({
  keys: initialKeys,
  tunnel,
  tailnets,
  onFinished,
}: {
  keys: Key[];
  tunnel: { address: string; port: number };
  tailnets?: Tailnet[] | null;
  onFinished?: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = React.useState<Step>("connection");
  // Reachable over SSH, without a public IP (it connects out through a tunnel), or through a tailnet.
  const [reach, setReach] = React.useState<"ssh" | "tunnel" | "tailscale">("ssh");
  const [tailnetId, setTailnetId] = React.useState<string | null>(tailnets?.[0]?.id ?? null);
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
  const tailscaleValid = !!(conn.name.trim() && conn.username.trim() && tailnetId && sshPort > 0 && sshPort < 65536);
  const tailnet = tailnets?.find((t) => t.id === tailnetId) ?? null;

  async function createTailscale() {
    if (!tailnetId) return;
    setBusy(true);
    const res = await createTailscaleServer({ name: conn.name.trim(), username: conn.username.trim(), sshPort, tailnetId, origin: window.location.origin });
    setBusy(false);
    if (!res.ok) return showError(res.error);
    setJoined(res.data);
    setServerId(res.data.id);
    setStep("join");
    router.refresh();
  }

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
    if (!res.ok) return showError(res.error);
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
      showError(res.error);
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
        showError(res.error);
        return;
      }
    } else {
      const res = await createServer(payload);
      if (!res.ok) {
        setBusy(false);
        showError(res.error);
        return;
      }
      id = res.data.id;
      setServerId(id);
    }
    const v = await validateServer(id);
    setBusy(false);
    if (!v.ok) {
      showError(v.error);
      return;
    }
    setStep("connect");
    router.refresh();
  }

  return (
    <div className="flex animate-rise flex-col gap-5">
      <Stepper step={step} steps={reach === "ssh" ? STEPS : TUNNEL_STEPS} />

      {step === "connection" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (reach === "tunnel") {
              if (tunnelValid) void createTunnel();
            } else if (reach === "tailscale") {
              if (tailscaleValid) void createTailscale();
            } else if (connectionValid) setStep("key");
          }}
        >
          <Card>
            <CardHeader title="Where is the server?" description={<>Any Linux machine with SSH. The connection uses this user to install and run Docker.</>} />
            <CardBody className="flex flex-col gap-4 py-5">
              <div className={cn("grid grid-cols-1 gap-2", tailnets ? "sm:grid-cols-3" : "sm:grid-cols-2")} role="radiogroup" aria-label="How to reach the server">
                {(
                  [
                    ["ssh", "Public IP or hostname", "A VPS or any machine reachable over SSH", Globe],
                    ["tunnel", "No public IP", "Home or office internet, shared IP, behind NAT", Cable],
                    ...(tailnets ? ([["tailscale", "Through Tailscale", "Any machine, joined to your tailnet", Network]] as const) : []),
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
              <Field label="Name" description={<>Shown in the dashboard, for example the provider and region.</>}>
                <Input value={conn.name} onChange={(e) => setConn({ ...conn, name: e.target.value })} placeholder="hetzner-fsn-1" autoFocus />
              </Field>
              {reach === "ssh" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_110px]">
                  <Field label="IP address or hostname">
                    <MaskedInput
                      label="IP address"
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
              {reach === "tailscale" &&
                (tailnets?.length ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_110px]">
                    <Field label="Tailnet" description="The server joins it with a single-use key; Serve then connects to its Tailscale address.">
                      <Select value={tailnetId} onValueChange={setTailnetId} options={tailnets.map((t) => ({ value: t.id, label: t.name }))} />
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
                ) : (
                  <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] leading-relaxed text-muted">
                    Connect a tailnet first in{" "}
                    <Link href="/integrations/tailscale" className="text-accent hover:underline">
                      Integrations, Tailscale
                    </Link>
                    . It takes an OAuth client and a tag for Serve&apos;s devices.
                  </p>
                ))}
              {reach === "tunnel" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_110px]">
                  <Field
                    label={<>This machine&apos;s address</>}
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
              <Button
                type="submit"
                variant="primary"
                disabled={reach === "tunnel" ? !tunnelValid : reach === "tailscale" ? !tailscaleValid : !connectionValid}
                loading={reach !== "ssh" && busy}
              >
                {reach === "ssh" ? "Continue" : "Create join command"} <ArrowRight />
              </Button>
            </CardFooter>
          </Card>
        </form>
      )}

      {step === "key" && (
        <Card>
          <CardHeader title={<>How does it sign in?</>} description={<>It signs in with an SSH key. Authorize its public key on the server, then connect.</>} />
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
                A new key pair is created for this server. Next, you copy its public key to the server. The private key is encrypted and never leaves the dashboard.
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

      {step === "connect" && serverId && <ConnectStep serverId={serverId} name={conn.name} onBack={() => setStep("key")} onFinished={onFinished} />}
      {step === "join" && joined && reach === "tailscale" && (
        <TailscaleJoinStep
          serverId={joined.id}
          name={conn.name}
          command={joined.command}
          expiresAt={joined.expiresAt}
          user={conn.username}
          tailnet={tailnet ?? { id: tailnetId ?? "", name: "the tailnet" }}
          onFinished={onFinished}
        />
      )}
      {step === "join" && joined && reach !== "tailscale" && (
        <JoinStep
          serverId={joined.id}
          name={conn.name}
          command={joined.command}
          expiresAt={joined.expiresAt}
          user={conn.username}
          address={tunnelForm.address}
          port={tunnel.port}
          onFinished={onFinished}
        />
      )}
    </div>
  );
}

type Progress = { status: ServerStatus; statusMessage: string | null; setupLog: string };

/** Live log of the setup job, with the next action for every outcome. */
export function ServerSetupProgress({
  serverId,
  onReady,
  compact,
  rejoin,
}: {
  serverId: string;
  onReady?: () => void;
  compact?: boolean;
  /** Its device left the tailnet: the error offers the join command instead of a retry that cannot work. */
  rejoin?: { tailnetId: string; tailnetName: string; user: string };
}) {
  const [joinCommand, setJoinCommand] = React.useState<{ command: string; expiresAt: string } | null>(null);
  const [joining, setJoining] = React.useState(false);
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
        // "pending": not set up yet (a server that connects out may still be on its way): keep watching.
        if (res.data.status !== "validating" && res.data.status !== "pending") {
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
    if (!res.ok) return showError(res.error);
    setProgress((p) => (p ? { ...p, status: "validating", statusMessage: "Queued", setupLog: "" } : p));
    setTick((t) => t + 1);
  };

  // Waiting to be set up counts as in progress, not as a failure.
  const waiting = progress?.status === "pending";
  const status = waiting ? "validating" : (progress?.status ?? "validating");
  const noDocker = /docker is not installed/i.test(progress?.statusMessage ?? "");
  // Ready with a note: the server works, but its proxy could not start.
  const warning = status === "ready" && progress?.statusMessage ? progress.statusMessage : null;
  const lines = (progress?.setupLog ?? "")
    .split("\n")
    .filter((l, i, all) => l || i < all.length - 1)
    .map((text) => ({ text }));

  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          "flex flex-col gap-3 rounded-xl px-3.5 py-3 sm:flex-row sm:items-start",
          warning ? "bg-warn-soft" : status === "ready" ? "bg-ok-soft" : status === "validating" ? "bg-info-soft" : "bg-bad-soft",
        )}
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {warning ? (
            <TriangleAlert className="mt-0.5 size-4 flex-none text-warn" />
          ) : status === "ready" ? (
            <CheckCircle2 className="mt-0.5 size-4 flex-none text-ok" />
          ) : status === "validating" ? (
            <RotateCw className="mt-0.5 size-4 flex-none animate-spin text-info" />
          ) : (
            <XCircle className="mt-0.5 size-4 flex-none text-bad" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-[13px] font-medium text-fg">
              {warning
                ? "Connected. The server is ready, but its proxy is not running."
                : status === "ready"
                  ? "Connected. The server is ready."
                  : status === "validating"
                    ? waiting
                      ? (progress?.statusMessage ?? "Waiting for the server to connect…")
                      : progress?.statusMessage === "Queued"
                        ? "Waiting for the worker…"
                        : "Connecting and preparing the server…"
                    : noDocker
                      ? "Docker is not installed"
                      : "Could not finish the setup"}
            </p>
            {warning && (
              <p className="text-[12.5px] leading-relaxed break-words text-fg-2">
                {warning}{" "}
                <Link href={`/servers/${serverId}/proxy`} className="font-medium text-fg underline underline-offset-2">
                  Change the proxy ports
                </Link>
              </p>
            )}
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
            ) : rejoin ? (
              <Button
                size="xs"
                variant="primary"
                loading={joining}
                onClick={async () => {
                  setJoining(true);
                  const res = await tailscaleJoinCommand(serverId, rejoin.tailnetId, window.location.origin);
                  setJoining(false);
                  if (res.ok) setJoinCommand(res.data);
                  else showError(res.error);
                }}
              >
                <Network /> {joinCommand ? "New join command" : "Join again"}
              </Button>
            ) : (
              <Button size="xs" loading={pending === "retry"} onClick={() => void rerun(false)}>
                <RotateCw /> Try again
              </Button>
            )}
          </div>
        )}
      </div>
      {rejoin && joinCommand && status !== "validating" && status !== "ready" && (
        <div className="rounded-xl border border-line p-4">
          <p className="mb-3 text-[13px] leading-relaxed text-fg-2">
            Run this on the server. Log in to it another way first, like SSH at its public address or your provider&apos;s console. It joins the tailnet again and Serve reconnects
            by itself.
          </p>
          <TailscaleJoinCommand command={joinCommand.command} expiresAt={joinCommand.expiresAt} user={rejoin.user} tailnet={rejoin.tailnetName} />
        </div>
      )}
      <LogViewer lines={lines} height={compact ? "min(40vh, 320px)" : "min(46vh, 380px)"} emptyText="Waiting for the setup to start…" filename="server-setup.log" />
    </div>
  );
}

/** The way out of a finished step: Continue when a caller goes on (onboarding), else the server's page. */
function FinishAction({ serverId, ready, onFinished }: { serverId: string; ready: boolean; onFinished?: () => void }) {
  if (onFinished)
    return (
      <Button variant={ready ? "primary" : "secondary"} onClick={onFinished}>
        {ready ? "Continue" : "Continue while it sets up"} <ArrowRight />
      </Button>
    );
  return (
    <Link href={`/servers/${serverId}`} className={buttonVariants({ variant: ready ? "primary" : "secondary" })}>
      <Server /> {ready ? "Open server" : "Open server page"}
    </Link>
  );
}

function ConnectStep({ serverId, name, onBack, onFinished }: { serverId: string; name: string; onBack: () => void; onFinished?: () => void }) {
  const [ready, setReady] = React.useState(false);
  return (
    <Card>
      <CardHeader title={`Connecting to ${name || "the server"}`} description={<>SSH access and Docker are checked, its data directory is prepared and the proxy is started.</>} />
      <CardBody className="py-5">
        <ServerSetupProgress serverId={serverId} onReady={() => setReady(true)} />
      </CardBody>
      <CardFooter className="justify-between">
        <Button variant="ghost" onClick={onBack} disabled={ready}>
          <ArrowLeft /> Change key or connection
        </Button>
        <FinishAction serverId={serverId} ready={ready} onFinished={onFinished} />
      </CardFooter>
    </Card>
  );
}

/** Waits for a server that connects out to run its join command, then follows its setup. */
function JoinStep(props: { serverId: string; name: string; command: string; expiresAt: string; user: string; address: string; port: number; onFinished?: () => void }) {
  const router = useRouter();
  // A command works for 24 hours: after that the page offers a new one instead of waiting forever.
  const [join, setJoin] = React.useState({ command: props.command, expiresAt: props.expiresAt });
  const [renewing, setRenewing] = React.useState(false);
  const now = useNow();
  const expired = now !== null && now > new Date(join.expiresAt).getTime();
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
            <>Connected through the tunnel. Docker is checked, its data directory is prepared and the proxy is started.</>
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
            <JoinCommand command={join.command} expiresAt={join.expiresAt} user={props.user} address={props.address} port={props.port} />
            {expired ? (
              <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted">
                This command expired.
                <Button
                  size="sm"
                  loading={renewing}
                  onClick={async () => {
                    setRenewing(true);
                    const res = await newJoinCommand(props.serverId, window.location.origin);
                    setRenewing(false);
                    if (!res.ok) return showError(res.error);
                    setJoin(res.data);
                  }}
                >
                  <RotateCw /> New command
                </Button>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-[13px] text-muted">
                <Loader2 className="size-4 animate-spin text-info" /> Waiting for {props.name} to connect…
              </p>
            )}
          </>
        )}
      </CardBody>
      <CardFooter className="justify-end">
        <FinishAction serverId={props.serverId} ready={ready} onFinished={props.onFinished} />
      </CardFooter>
    </Card>
  );
}

/** Waits for a server to run its Tailscale join command, then follows its setup. */
function TailscaleJoinStep(props: {
  serverId: string;
  name: string;
  command: string;
  expiresAt: string;
  user: string;
  tailnet: { id: string; name: string };
  onFinished?: () => void;
}) {
  const router = useRouter();
  const [join, setJoin] = React.useState({ command: props.command, expiresAt: props.expiresAt });
  const [renewing, setRenewing] = React.useState(false);
  const now = useNow();
  const expired = now !== null && now > new Date(join.expiresAt).getTime();
  const [joined, setJoined] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    if (joined) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const res = await getServerProgress(props.serverId);
      if (stop) return;
      if (res.ok && (res.data.tailscale?.joined || res.data.status !== "pending")) {
        setJoined(true);
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
  }, [joined, props.serverId, router]);
  return (
    <Card>
      <CardHeader
        title={joined ? `Setting up ${props.name}` : `Connect ${props.name}`}
        description={
          joined ? (
            <>In the tailnet. Docker is checked over its Tailscale address, its data directory is prepared and the proxy is started.</>
          ) : (
            "Run the command on the server. This page moves on by itself when it joined the tailnet."
          )
        }
      />
      <CardBody className="flex flex-col gap-4 py-5">
        {joined ? (
          <ServerSetupProgress serverId={props.serverId} onReady={() => setReady(true)} />
        ) : (
          <>
            <TailscaleJoinCommand command={join.command} expiresAt={join.expiresAt} user={props.user} tailnet={props.tailnet.name} />
            {expired ? (
              <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted">
                This command expired.
                <Button
                  size="sm"
                  loading={renewing}
                  onClick={async () => {
                    setRenewing(true);
                    const res = await tailscaleJoinCommand(props.serverId, props.tailnet.id, window.location.origin);
                    setRenewing(false);
                    if (!res.ok) return showError(res.error);
                    setJoin(res.data);
                  }}
                >
                  <RotateCw /> New command
                </Button>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-[13px] text-muted">
                <Loader2 className="size-4 animate-spin text-info" /> Waiting for {props.name} to join the tailnet…
              </p>
            )}
          </>
        )}
      </CardBody>
      <CardFooter className="justify-end">
        <FinishAction serverId={props.serverId} ready={ready} onFinished={props.onFinished} />
      </CardFooter>
    </Card>
  );
}
