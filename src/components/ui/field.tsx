"use client";

import type * as React from "react";
import { Field as BaseField } from "@base-ui/react/field";
import { cn } from "@/lib/utils";

export function Field({
  label,
  description,
  error,
  className,
  children,
  htmlFor,
  optional,
}: {
  label?: React.ReactNode;
  description?: React.ReactNode;
  error?: string | null;
  className?: string;
  children: React.ReactNode;
  htmlFor?: string;
  optional?: boolean;
}) {
  return (
    <BaseField.Root className={cn("flex flex-col gap-1.5", className)} invalid={!!error}>
      {label && (
        <BaseField.Label htmlFor={htmlFor} className="text-[13px] font-medium text-fg-2">
          {label}
          {optional && <span className="ml-1.5 font-normal text-faint">Optional</span>}
        </BaseField.Label>
      )}
      {children}
      {description && !error && <BaseField.Description className="text-xs leading-relaxed text-muted">{description}</BaseField.Description>}
      {error && <p className="text-xs text-bad">{error}</p>}
    </BaseField.Root>
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-[13px] font-medium text-fg-2", className)} {...props} />;
}
