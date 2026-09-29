"use client";

import { Lock } from "lucide-react";
import { CardFooter } from "@/components/ui/misc";
import { cannotMessage, type Permission } from "@/lib/permissions";

/** Footer of a settings card the member may look at but not change (instead of Save). */
export function ReadOnlyFooter({ permission, message }: { permission?: Permission; message?: string }) {
  return (
    <CardFooter>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
        <Lock className="size-3.5 flex-none" /> Read only. {message ?? (permission ? cannotMessage(permission) : "")}
      </span>
    </CardFooter>
  );
}
