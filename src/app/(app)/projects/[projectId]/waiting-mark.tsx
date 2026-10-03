import { Hourglass } from "lucide-react";
import { cn } from "@/lib/utils";

/** A deploy of the service waits for someone to approve it. */
export function WaitingMark({ short = false, className }: { short?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 text-xs font-medium text-warn", className)} title="A deployment waits for approval">
      <Hourglass className="size-3 flex-none" />
      <span className="truncate">{short ? "Approval" : "Waiting for approval"}</span>
    </span>
  );
}
