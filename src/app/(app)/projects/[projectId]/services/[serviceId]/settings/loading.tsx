import { Skeleton } from "@/components/ui/misc";

/** A section loading inside the settings layout: the section list stays, one card fills the rest. */
export default function Loading() {
  return (
    <div className="flex animate-fade-in flex-col rounded-2xl border border-line bg-surface">
      <div className="border-b border-line p-5">
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="flex flex-col gap-5 p-5">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}
