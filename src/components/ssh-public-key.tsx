"use client";

import { CopyButton } from "@/components/ui/misc";

/** A public key plus the one-line command that authorizes it on a server. */
export function SshPublicKey({ publicKey, user = "root" }: { publicKey: string; user?: string }) {
  const command = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${publicKey}' >> ~/.ssh/authorized_keys`;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-fg-2">Public key</span>
        <div className="flex items-start gap-2 rounded-xl border border-line bg-surface-2 py-2 pr-1.5 pl-3">
          <code className="min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed break-all text-fg-2">{publicKey}</code>
          <CopyButton value={publicKey} label="Copy public key" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-fg-2">
          Run this on the server as <code className="font-mono">{user}</code>
        </span>
        <div className="flex items-start gap-2 rounded-xl bg-log-bg py-2.5 pr-1.5 pl-3">
          <code className="min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed break-all text-log-fg">
            <span className="text-[#0a84ff] select-none">$ </span>
            {command}
          </code>
          <CopyButton value={command} label="Copy command" className="text-white/60 hover:bg-white/10 hover:text-white" />
        </div>
      </div>
    </div>
  );
}
