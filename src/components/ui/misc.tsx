"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { useNow } from "@/hooks/use-client";
import { Tooltip } from "./tooltip";
import { copyText } from "./clipboard";
import { toast } from "./toast";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("overflow-hidden rounded-2xl border border-line bg-surface shadow-sm", className)} {...props} />;
}

export function CardHeader({ title, description, actions, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    // The text takes the free space, so actions stay top right beside a long description; they
    // wrap under it only when less than 16rem would be left for the text (phones).
    <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4", className)}>
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <h3 className="font-display text-[15px] font-semibold text-fg">{title}</h3>
        {description && <p className="text-[13px] leading-relaxed text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-4", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-between gap-3 rounded-b-2xl border-t border-line bg-surface-2 px-5 py-3", className)} {...props} />;
}

const badgeTones = {
  neutral: "border-line bg-surface-2 text-fg-2",
  accent: "border-transparent bg-accent-soft text-accent-strong",
  ok: "border-transparent bg-ok-soft text-ok",
  info: "border-transparent bg-info-soft text-info",
  warn: "border-transparent bg-warn-soft text-warn",
  bad: "border-transparent bg-bad-soft text-bad",
};

export function Badge({ tone = "neutral", className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof badgeTones }) {
  return (
    <span
      className={cn("inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[11px] font-medium whitespace-nowrap [&_svg]:size-3", badgeTones[tone], className)}
      {...props}
    />
  );
}

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-surface-2 px-1 font-mono text-[10px] text-muted", className)}
      {...props}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-4", className)} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-14 text-center", className)}>
      {icon && <div className="flex size-11 items-center justify-center rounded-xl border border-line bg-surface-2 text-muted [&_svg]:size-5">{icon}</div>}
      <div className="flex max-w-sm flex-col gap-1">
        <p className="font-display text-[15px] font-semibold text-fg">{title}</p>
        {description && <p className="text-[13px] leading-relaxed text-muted">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function CopyButton({ value, className, label = "Copy" }: { value: string; className?: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Tooltip content={copied ? "Copied" : label}>
      <button
        type="button"
        onClick={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!(await copyText(value))) {
            toast.error("Could not copy. Select the text and copy it by hand.");
            return;
          }
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className={cn("inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg", className)}
        aria-label={label}
      >
        {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      </button>
    </Tooltip>
  );
}

/**
 * A block of output (a log, an error, a snippet) with a copy button in its top right corner. The
 * wrapper takes the block's outer spacing; `dark` for blocks on the log background.
 */
export function Copyable({ value, children, className, dark }: { value: string; children: React.ReactNode; className?: string; dark?: boolean }) {
  return (
    <div className={cn("group/copy relative min-w-0", className)}>
      {children}
      {value.trim() && (
        <CopyButton
          value={value}
          className={cn(
            "absolute top-1.5 right-1.5 size-6 bg-surface/90 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/copy:opacity-100 sm:focus-visible:opacity-100",
            dark && "bg-log-bg/90 text-white/50 hover:bg-white/10 hover:text-white",
          )}
        />
      )}
    </div>
  );
}

/** Read-only value with a copy button (connection strings, URLs, keys). */
export function CopyField({ value, secret, className }: { value: string; secret?: boolean; className?: string }) {
  const [shown, setShown] = React.useState(!secret);
  return (
    <div className={cn("flex h-9 min-w-0 items-center gap-1 rounded-md border border-line bg-surface-2 pr-1 pl-3", className)}>
      <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg-2">{shown ? value : "•".repeat(Math.min(32, value.length))}</code>
      {secret && (
        <button type="button" onClick={() => setShown((s) => !s)} className="rounded px-1.5 py-0.5 text-[11px] font-medium text-muted hover:bg-hover hover:text-fg">
          {shown ? "Hide" : "Show"}
        </button>
      )}
      <CopyButton value={value} />
    </div>
  );
}

/** Relative time that renders on the client to avoid timezone mismatches. */
export function TimeAgo({ date, className }: { date: Date | string | number | null | undefined; className?: string }) {
  const now = useNow();
  const mounted = now !== null;
  const d = date ? new Date(date) : null;
  // An unreadable date shows as unknown instead of throwing in toISOString.
  if (!d || Number.isNaN(d.getTime())) return <span className={className}>—</span>;
  return (
    <time dateTime={d.toISOString()} title={mounted ? d.toLocaleString() : undefined} className={className} suppressHydrationWarning>
      {mounted ? timeAgo(d) : ""}
    </time>
  );
}

export function Separator({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-line", className)} />;
}

export function Avatar({ name, src, className }: { name: string; src?: string | null; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  return (
    <span
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-surface-2 text-[11px] font-semibold text-fg-2",
        className,
      )}
    >
      {src ? <img src={src} alt="" className="size-full object-cover" /> : initials || "?"}
    </span>
  );
}
