"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { meshChangeImpact, type MeshImpact } from "@/server/actions/mesh";

type Change = Parameters<typeof meshChangeImpact>[0];

/**
 * Confirm a private network change. Always asks; when services use each other's private names
 * across the link that goes away, lists them as a warning.
 */
export function useMeshConfirm() {
  const confirm = useConfirm();
  return React.useCallback(
    async (change: Change, text: { title: string; description: string; confirmLabel: string }) => {
      const res = await meshChangeImpact(change).catch(() => null);
      if (res && !res.ok) {
        toast.error(res.error);
        return false;
      }
      const impact = res?.data ?? null;
      return confirm({
        title: text.title,
        confirmLabel: text.confirmLabel,
        danger: true,
        description: <ImpactNote description={text.description} impact={impact} />,
      });
    },
    [confirm],
  );
}

function ImpactNote({ description, impact }: { description: string; impact: MeshImpact | null }) {
  if (!impact) return <>{description}</>;
  if (!impact.length) return <>{description} No service uses a service across this link, so nothing stops working.</>;
  return (
    <span className="flex flex-col gap-3">
      <span>{description}</span>
      <span className="flex flex-col gap-2 rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-3">
        <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
          <AlertTriangle className="size-4 flex-none text-warn" />
          {impact.length === 1 ? "1 service stops reaching" : `${impact.length} services stop reaching`} what it uses
        </span>
        <span className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
          {impact.map((i) => (
            <span key={`${i.href}|${i.provider}`} className="text-xs leading-relaxed text-fg-2">
              <Link href={i.href} className="font-medium text-fg hover:underline">
                {i.consumer}
              </Link>{" "}
              on {i.consumerServer} uses <span className="font-medium text-fg">{i.provider}</span> on {i.providerServer}
              <span className="text-muted">
                {" "}
                · {i.project} · {i.variables.join(", ")}
              </span>
            </span>
          ))}
        </span>
        <span className="text-xs text-muted">Their private names stop resolving right away. Keep a shared network, or switch those variables to a public domain or port.</span>
      </span>
    </span>
  );
}
