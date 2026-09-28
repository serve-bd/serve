import { Skeleton } from "@/components/ui/misc";

export default function Loading() {
  return (
    <div className="mx-auto grid w-full max-w-[1200px] animate-fade-in items-start gap-6 px-4 py-6 sm:px-8 lg:grid-cols-[1fr_300px]">
      <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-72 max-w-full" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 pt-2">
            <Skeleton className="size-2 rounded-full" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}
