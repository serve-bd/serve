"use client";

import type * as React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;

export function DialogContent({
  className,
  children,
  size = "md",
  hideClose,
}: {
  className?: string;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  hideClose?: boolean;
}) {
  const width = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size];
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-[var(--backdrop)] backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
      <BaseDialog.Viewport className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 py-[8vh] sm:py-[12vh]">
        <BaseDialog.Popup
          className={cn(
            "relative w-full rounded-2xl border border-line bg-surface shadow-lg outline-none transition-[transform,opacity] duration-200 ease-[var(--ease-out-quint)] data-[ending-style]:translate-y-2 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0",
            width,
            className,
          )}
        >
          {children}
          {!hideClose && (
            <BaseDialog.Close className="absolute top-3.5 right-3.5 rounded-md p-1 text-muted transition-colors hover:bg-hover hover:text-fg">
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </BaseDialog.Close>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  );
}

export function DialogHeader({ title, description, className }: { title: React.ReactNode; description?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1 px-5 pt-5 pr-12", className)}>
      <BaseDialog.Title className="font-display text-[17px] font-semibold text-fg">{title}</BaseDialog.Title>
      {description && <BaseDialog.Description className="text-[13px] leading-relaxed text-muted">{description}</BaseDialog.Description>}
    </div>
  );
}

export function DialogBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("flex flex-col gap-4 px-5 py-5", className)}>{children}</div>;
}

export function DialogFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("flex flex-col-reverse gap-2 rounded-b-2xl border-t border-line bg-surface-2 px-5 py-3 sm:flex-row sm:justify-end", className)}>{children}</div>;
}
