import { Skeleton } from "@/components/ui/misc";

export default function Loading() {
  return (
    <div className="animate-fade-in">
      <div className="border-b border-line">
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-3 px-4 pt-7 pb-6 sm:px-8">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-3 w-96 max-w-full" />
        </div>
      </div>
      <div className="mx-auto grid w-full max-w-[1200px] gap-4 px-4 py-6 sm:grid-cols-2 sm:px-8 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 rounded-[10px]" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ))}
      </div>
    </div>
  );
}
