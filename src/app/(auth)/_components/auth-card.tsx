import { cn } from "@/lib/utils";

/** Centered sign-in style card: title, optional subtitle, then the form. */
export function AuthCard({
  title,
  description,
  eyebrow,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "w-full rounded-2xl border border-line bg-surface px-6 py-7 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-12px_rgb(0_0_0/0.18)] sm:px-7",
        className,
      )}
    >
      <header className="mb-6 flex flex-col items-center gap-1.5 text-center">
        {eyebrow && <p className="text-[11px] font-medium tracking-[0.08em] text-faint uppercase">{eyebrow}</p>}
        <h1 className="font-display text-[22px] leading-tight font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="text-[13px] leading-relaxed text-muted">{description}</p>}
      </header>
      {children}
    </section>
  );
}

/** Inline form error shown above the submit button. */
export function AuthError({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg border border-bad/20 bg-bad-soft px-3 py-2 text-[13px] text-bad">
      {children}
    </p>
  );
}
