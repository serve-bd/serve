"use client";

import Link from "next/link";
import { ArrowUpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCan, useCannot } from "@/components/permissions";
import { useAction } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import type { ImageCheck } from "@/server/db/schema";
import { checkImageUpdatesNow, updateServiceImages } from "@/server/actions/services";
import { cn } from "@/lib/utils";

/**
 * A strip at the top of the overview when the registry has something newer for an image the
 * service runs: a newer build of the same tag (often security fixes) is one click away; a newer
 * version is only named, since it can need changes. Nothing new: nothing shown.
 */
export function ImageUpdatesCard({
  serviceId,
  base,
  check,
  isDatabase,
  className,
}: {
  serviceId: string;
  base: string;
  check: ImageCheck | null;
  isDatabase: boolean;
  className?: string;
}) {
  const router = useRouter();
  const can = useCan();
  const cannot = useCannot();
  const update = useAction(() => updateServiceImages(serviceId), { onSuccess: (d) => router.push(`${base}/deployments/${d.deploymentId}`) });
  const recheck = useAction(() => checkImageUpdatesNow(serviceId));
  const builds = check?.images.filter((i) => i.newerBuild) ?? [];
  const versions = check?.images.filter((i) => i.newerVersion) ?? [];
  if (!builds.length && !versions.length) return null;
  const name = (i: ImageCheck["images"][number]) => (i.composeService ? `${i.composeService} (${i.ref})` : i.ref);
  const deny = cannot("services.deploy");
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3 text-[13px]", className)}>
      <ArrowUpCircle className={cn("size-4 flex-none", builds.length ? "text-warn" : "text-muted")} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {builds.length > 0 && (
          <p className="text-fg">
            Newer build of <span className="font-mono text-[12.5px]">{builds.map(name).join(", ")}</span>
            <span className="text-muted"> · same version, usually security fixes</span>
          </p>
        )}
        {versions.length > 0 && (
          <p className="text-muted">
            {versions.map((i) => (
              <span key={name(i)} className="mr-3">
                Version <span className="font-mono text-[12.5px] text-fg-2">{i.newerVersion}</span> of {name(i)} is out
              </span>
            ))}
            {isDatabase && (
              <Link href={`${base}/settings/details`} className="text-accent hover:underline">
                Change version
              </Link>
            )}
          </p>
        )}
      </div>
      <div className="flex flex-none items-center gap-2">
        <Button size="sm" variant="ghost" loading={recheck.pending} disabled={!can("services.deploy")} title={deny} onClick={() => recheck.run()}>
          Check again
        </Button>
        {builds.length > 0 && (
          <Button size="sm" variant="primary" loading={update.pending} disabled={!can("services.deploy")} title={deny} onClick={() => update.run()}>
            Update image
          </Button>
        )}
      </div>
    </div>
  );
}
