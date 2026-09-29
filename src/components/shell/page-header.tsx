import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type Crumb = { label: React.ReactNode; href?: string };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="flex min-w-0 items-center gap-1 text-[13px] text-muted">
      {items.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-faint" />}
          {c.href ? (
            <Link href={c.href} className="truncate transition-colors hover:text-fg">
              {c.label}
            </Link>
          ) : (
            <span className="truncate text-fg-2">{c.label}</span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}

/**
 * The header bar holds only the breadcrumbs. The title, description and actions
 * are part of the page content, aligned with PageBody.
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  crumb,
  className,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumbs?: Crumb[];
  /** Breadcrumb label for top-level pages without `breadcrumbs` (defaults to the title). */
  crumb?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      {/* Every page keeps the thin breadcrumb bar; top-level pages show just their own name. */}
      <header className={cn("border-b border-line bg-bg", className)}>
        <div className="mx-auto w-full max-w-[1200px] px-4 py-3 sm:px-8">
          <Breadcrumbs items={breadcrumbs ?? [{ label: crumb ?? title }]} />
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-end justify-between gap-x-4 gap-y-3 px-4 pt-7 pb-2 sm:px-8">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="truncate text-[22px] leading-tight font-semibold text-fg">{title}</h1>
          {description && <p className="max-w-2xl text-[13px] leading-relaxed text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        {children}
      </div>
    </>
  );
}

/** Page content aligned with the header. `className` styles the inner column (e.g. max-w-3xl). */
export function PageBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-16 sm:px-8">
      <div className={className}>{children}</div>
    </div>
  );
}
