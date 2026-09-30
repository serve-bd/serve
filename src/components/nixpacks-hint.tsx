import { CopyButton } from "@/components/ui/misc";

const INSTALL = "curl -sSL https://nixpacks.com/install.sh | bash";

/** Nixpacks runs where the worker runs; the Serve image ships it, other installs add it by hand. */
export function NixpacksHint() {
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
      <span>Nixpacks is not installed where Serve runs. Run</span>
      <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-sunken px-1.5 py-0.5">
        <code className="font-mono text-[11.5px] break-all text-fg-2">{INSTALL}</code>
        <CopyButton value={INSTALL} />
      </span>
      <span>there and restart the worker to use it.</span>
    </span>
  );
}
