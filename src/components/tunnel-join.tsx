"use client";

import { Terminal } from "lucide-react";
import { CopyButton } from "@/components/ui/misc";

/** The one-line join command for a server that connects out, with what it does. */
export function JoinCommand({ command, expiresAt, user, address, port }: { command: string; expiresAt: string; user: string; address: string; port: number }) {
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
        <span className="text-xs text-muted">Works once, until {new Date(expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.</span>
      </div>
      <ul className="flex flex-col gap-1 rounded-xl bg-surface-2 px-3.5 py-3 text-xs leading-relaxed text-muted">
        <li>
          • Opens an encrypted SSH tunnel <span className="font-medium text-fg-2">out</span> to <span className="font-mono text-fg-2">{`${address}:${port}`}</span>, kept up after
          reboots and network drops. Nothing needs to be opened on the server&apos;s router.
        </li>
        <li>
          • Lets this dashboard sign in as <span className="font-mono text-fg-2">{user}</span> through that tunnel (adds its key to authorized_keys). Installs the SSH server if it
          is missing.
        </li>
        <li>
          • The machine running this dashboard must accept TCP <span className="font-mono text-fg-2">{port}</span> from the internet (open it in its cloud firewall).
        </li>
      </ul>
    </div>
  );
}
