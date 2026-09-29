"use client";

import { Lock } from "lucide-react";
import { CopyField } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

/**
 * A copyable secret, or, for a role that cannot see secret values, a locked box
 * with no reveal and no copy. `shape` may show a masked form, like a URL without its password.
 */
export function SecretField({ value, hidden, shape, className }: { value: string; hidden?: boolean; shape?: string; className?: string }) {
  if (!hidden) return <CopyField value={value} secret className={className} />;
  return (
    <div
      className={cn("flex h-9 min-w-0 items-center gap-2 rounded-lg border border-line bg-sunken px-3 font-mono text-[12.5px] text-muted", className)}
      title="Your role cannot see secret values."
    >
      <Lock className="size-3.5 flex-none" />
      <span className="truncate">{shape ?? "Hidden for your role"}</span>
    </div>
  );
}
