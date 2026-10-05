import { cn } from "@/lib/utils";

/** Sign-in form block: title, optional subtitle, then the form. No card; the page is the surface. */
export function AuthCard({
  title,
  description,
  eyebrow,
  children,
  className,
  greeting,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** A plain welcome (the sign-in page): white-labeled pages keep it for screen readers only. */
  greeting?: boolean;
}) {
  return (
    <section className={cn("w-full", className)}>
      <header data-auth-greeting={greeting || undefined} className="mb-7 flex flex-col gap-1.5">
        {eyebrow && <p className="text-[11px] font-medium tracking-[0.08em] text-faint uppercase">{eyebrow}</p>}
        <h1 className="font-display text-[26px] leading-tight font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="text-[14px] leading-relaxed text-muted">{description}</p>}
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
