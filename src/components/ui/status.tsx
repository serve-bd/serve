import { cn } from "@/lib/utils";

type Tone = { led: string; label: string; pulse?: boolean; off?: boolean };

const serviceTones: Record<string, Tone> = {
  running: { led: "var(--ok)", label: "Running" },
  building: { led: "var(--info)", label: "Building", pulse: true },
  deploying: { led: "var(--info)", label: "Deploying", pulse: true },
  restarting: { led: "var(--warn)", label: "Restarting", pulse: true },
  stopped: { led: "var(--idle)", label: "Stopped", off: true },
  idle: { led: "var(--idle)", label: "Not deployed", off: true },
  failed: { led: "var(--bad)", label: "Failed" },
  crashed: { led: "var(--bad)", label: "Crashed", pulse: true },
};

const deploymentTones: Record<string, Tone> = {
  queued: { led: "var(--idle)", label: "Queued", pulse: true },
  building: { led: "var(--info)", label: "Building", pulse: true },
  deploying: { led: "var(--info)", label: "Deploying", pulse: true },
  success: { led: "var(--ok)", label: "Ready" },
  failed: { led: "var(--bad)", label: "Failed" },
  cancelled: { led: "var(--idle)", label: "Cancelled", off: true },
  superseded: { led: "var(--idle)", label: "Skipped", off: true },
};

const certTones: Record<string, Tone> = {
  pending: { led: "var(--idle)", label: "Pending", pulse: true },
  issuing: { led: "var(--info)", label: "Issuing", pulse: true },
  active: { led: "var(--ok)", label: "Active" },
  failed: { led: "var(--bad)", label: "Failed" },
  expired: { led: "var(--bad)", label: "Expired" },
};

const serverTones: Record<string, Tone> = {
  pending: { led: "var(--idle)", label: "Not validated", off: true },
  validating: { led: "var(--info)", label: "Validating", pulse: true },
  ready: { led: "var(--ok)", label: "Ready" },
  unreachable: { led: "var(--bad)", label: "Unreachable", pulse: true },
  error: { led: "var(--bad)", label: "Error" },
};

const maps = { service: serviceTones, deployment: deploymentTones, certificate: certTones, server: serverTones };

export function Led({ color, pulse, off, className }: { color: string; pulse?: boolean; off?: boolean; className?: string }) {
  return (
    <span
      className={cn("led", className)}
      style={{ ["--led" as string]: color }}
      data-pulse={pulse ? "" : undefined}
      data-state={off ? "off" : "on"}
      aria-hidden
    />
  );
}

export function StatusDot({ status, kind = "service", className }: { status: string; kind?: keyof typeof maps; className?: string }) {
  const tone = maps[kind][status] ?? { led: "var(--idle)", label: status };
  return <Led color={tone.led} pulse={tone.pulse} off={tone.off} className={className} />;
}

export function StatusLabel({
  status,
  kind = "service",
  className,
}: {
  status: string;
  kind?: keyof typeof maps;
  className?: string;
}) {
  const tone = maps[kind][status] ?? { led: "var(--idle)", label: status };
  return (
    <span className={cn("inline-flex items-center gap-2 text-[13px] font-medium text-fg-2", className)}>
      <Led color={tone.led} pulse={tone.pulse} off={tone.off} />
      {tone.label}
    </span>
  );
}

export function statusText(status: string, kind: keyof typeof maps = "service") {
  return maps[kind][status]?.label ?? status;
}
