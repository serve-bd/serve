"use client";

import { Terminal } from "lucide-react";
import { CopyButton } from "@/components/ui/misc";

/** The one-line join command for a server that connects through Tailscale, with what it does. */
export function TailscaleJoinCommand({ command, expiresAt, user, tailnet }: { command: string; expiresAt: string; user: string; tailnet: string }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg-2">
          <Terminal className="size-3.5 text-muted" /> Run this on the server, as a user with sudo
        </span>
        <div className="flex items-start gap-2 rounded-xl border border-line bg-sunken px-3.5 py-3">
          <code className="min-w-0 flex-1 font-mono text-[12.5px] leading-relaxed break-all text-fg select-all">{command}</code>
          <CopyButton value={command} />
        </div>
        <span className="text-xs text-muted">
          Works until the server joined, at most until {new Date(expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}. Running it twice is safe.
        </span>
      </div>
      <ul className="flex flex-col gap-1 rounded-xl bg-surface-2 px-3.5 py-3 text-xs leading-relaxed text-muted">
        <li>
          • Installs Tailscale with its official script when it is missing, and joins <span className="font-medium text-fg-2">{tailnet}</span> with a single-use key Serve makes at
          that moment. Nothing needs to be opened on the server&apos;s router.
        </li>
        <li>
          • Lets this dashboard sign in as <span className="font-mono text-fg-2">{user}</span> (adds its key to authorized_keys), and installs the SSH server if it is missing.
          Serve then connects to its Tailscale address.
        </li>
        <li>
          • A machine in another tailnet is not moved: the command stops and says how to move it (
          <span className="font-mono text-fg-2">curl … | sudo SERVE_TAILSCALE_FORCE=1 bash</span>).
        </li>
      </ul>
    </div>
  );
}
