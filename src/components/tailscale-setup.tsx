"use client";

import { Copyable } from "@/components/ui/misc";

/** The policy lines that let Serve tag devices; the owner may be any admin group of the tailnet. */
export const tagOwnersSnippet = (tag: string) => `"tagOwners": {
  "${tag}": ["autogroup:admin"]
}`;

/** Only needed when the policy does not allow all traffic: servers (and the dashboard's machine) reach each other. */
export const grantsSnippet = (tag: string) => `"grants": [
  { "src": ["${tag}"], "dst": ["${tag}"], "ip": ["*"] }
]`;

function Snippet({ value }: { value: string }) {
  return (
    <Copyable value={value}>
      <pre className="overflow-x-auto rounded-lg bg-sunken py-2.5 pr-10 pl-3 font-mono text-[11.5px] leading-relaxed text-fg">{value}</pre>
    </Copyable>
  );
}

/** What to set up in the Tailscale admin console before connecting, in order. */
export function TailscaleSetupSteps({ tag = "tag:serve", authType = "oauth" }: { tag?: string; authType?: "oauth" | "apikey" }) {
  return (
    <ol className="flex flex-col gap-3 text-[13px] leading-relaxed text-fg-2">
      <li className="flex flex-col gap-1.5">
        <span>
          <span className="font-medium text-fg">1. A tag for Serve&apos;s devices.</span> In the admin console, open Access controls and add the tag&apos;s owner to the tailnet
          policy (merge it into an existing <span className="font-mono">tagOwners</span>):
        </span>
        <Snippet value={tagOwnersSnippet(tag)} />
        <span className="text-xs text-muted">
          The default policy allows all traffic. If yours does not, also let the tag reach itself (SSH, and UDP for the private network; the dashboard&apos;s machine joins with the
          same tag):
        </span>
        <Snippet value={grantsSnippet(tag)} />
      </li>
      {authType === "oauth" ? (
        <li>
          <span className="font-medium text-fg">2. An OAuth client.</span> Under Settings, Trust credentials (OAuth clients), create one with the scopes{" "}
          <span className="font-mono">auth_keys</span> (write: Serve makes a single-use key for each server) and <span className="font-mono">devices:core</span> (write: Serve finds
          the server&apos;s device, and removes it when you ask). Select the tag <span className="font-mono">{tag}</span> for both. An OAuth client does not expire.
        </li>
      ) : (
        <li>
          <span className="font-medium text-fg">2. An API access key.</span> Under Settings, Keys, generate an API access key. It works with your own permissions and expires after
          at most 90 days: Serve then shows the error here and you paste a new one. An OAuth client avoids that.
        </li>
      )}
      <li>
        <span className="font-medium text-fg">3. Paste it below</span> with the tailnet&apos;s name (Settings, General), or <span className="font-mono">-</span> for the tailnet of
        the credentials.
      </li>
    </ol>
  );
}
