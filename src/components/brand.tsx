import { cn } from "@/lib/utils";

/** Serve mark: a rack unit with a lit status lamp. */
export function Logo({ className, withText = true }: { className?: string; withText?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <svg viewBox="0 0 28 28" className="size-7" aria-hidden>
        <rect x="1" y="1" width="26" height="26" rx="7" className="fill-fg" />
        <rect x="6" y="8" width="16" height="4" rx="1.5" className="fill-bg" opacity="0.9" />
        <rect x="6" y="16" width="16" height="4" rx="1.5" className="fill-bg" opacity="0.55" />
        <circle cx="19" cy="10" r="1.4" fill="var(--accent)" />
      </svg>
      {withText && <span className="font-display text-[17px] font-semibold tracking-tight text-fg">Serve</span>}
    </span>
  );
}
