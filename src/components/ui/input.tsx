"use client";

import * as React from "react";
import { Input as BaseInput } from "@base-ui/react/input";
import { cn } from "@/lib/utils";

export const inputClass =
  "h-9 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg shadow-sm outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-accent focus:ring-3 focus:ring-[var(--ring)]/40 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-bad data-[invalid]:border-bad";

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<typeof BaseInput>>(function Input(
  { className, ...props },
  ref,
) {
  return <BaseInput ref={ref} className={cn(inputClass, className as string)} {...props} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(inputClass, "h-auto min-h-24 py-2 leading-relaxed", className)}
        {...props}
      />
    );
  },
);

/** Input with a fixed prefix/suffix, e.g. https:// or .example.com */
export function InputGroup({
  prefix,
  suffix,
  className,
  children,
}: {
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-9 items-stretch overflow-hidden rounded-lg border border-line-strong bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-3 focus-within:ring-[var(--ring)]/40 [&_input]:h-full [&_input]:rounded-none [&_input]:border-0 [&_input]:shadow-none [&_input]:ring-0 [&_input]:focus:ring-0",
        className,
      )}
    >
      {prefix && (
        <span className="flex items-center border-r border-line bg-surface-2 px-2.5 text-[13px] text-muted">{prefix}</span>
      )}
      {children}
      {suffix && (
        <span className="flex items-center border-l border-line bg-surface-2 px-2.5 text-[13px] text-muted">{suffix}</span>
      )}
    </div>
  );
}
