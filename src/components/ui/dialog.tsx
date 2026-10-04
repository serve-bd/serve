"use client";

import * as React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { CircleAlert, X } from "lucide-react";
import { addErrorSink } from "@/hooks/use-action";
import { cn } from "@/lib/utils";

/** The error of the last action run from this dialog, shown in its footer (or at its bottom without one). */
const DialogErrorContext = React.createContext<{ error: string | null; setHasFooter: (has: boolean) => void } | null>(null);

export function DialogError({ message, className }: { message: string | null; className?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className={cn("flex min-w-0 items-start gap-1.5 text-[13px] leading-snug text-bad", className)}>
      <CircleAlert className="mt-px size-3.5 flex-none" />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
}

/** Mounted with the popup: while the dialog is open, actions report their errors here. */
function useDialogErrors() {
  const [error, setError] = React.useState<string | null>(null);
  const [hasFooter, setHasFooter] = React.useState(false);
  React.useEffect(() => addErrorSink({ show: setError, clear: () => setError(null) }), []);
  return { error, hasFooter, value: React.useMemo(() => ({ error, setHasFooter }), [error]) };
}

function PopupContents({ children }: { children: React.ReactNode }) {
  const { error, hasFooter, value } = useDialogErrors();
  return (
    <DialogErrorContext.Provider value={value}>
      {children}
      {!hasFooter && <DialogError message={error} className="px-5 pb-4" />}
    </DialogErrorContext.Provider>
  );
}

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
      <BaseDialog.Viewport className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 py-6 sm:py-10">
        <BaseDialog.Popup
          className={cn(
            // At most the screen's height: the body scrolls inside, the title and the buttons stay in view.
            // A <form> around the parts gets the same column layout. Dialogs without a DialogBody scroll whole.
            "relative my-auto flex max-h-[calc(100dvh-3rem)] w-full flex-col overflow-y-auto rounded-2xl border border-line bg-surface shadow-lg outline-none sm:max-h-[calc(100dvh-5rem)] [&>form]:flex [&>form]:min-h-0 [&>form]:flex-col transition-[transform,opacity] duration-200 ease-[var(--ease-out-quint)] data-[ending-style]:translate-y-2 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0",
            width,
            className,
          )}
        >
          <PopupContents>{children}</PopupContents>
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
    <div className={cn("flex flex-none flex-col gap-1 px-5 pt-5 pr-12", className)}>
      <BaseDialog.Title className="font-display text-[17px] font-semibold text-fg">{title}</BaseDialog.Title>
      {description && <BaseDialog.Description className="text-[13px] leading-relaxed text-muted">{description}</BaseDialog.Description>}
    </div>
  );
}

export function DialogBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-5", className)}>{children}</div>;
}

export function DialogFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  const ctx = React.useContext(DialogErrorContext);
  const setHasFooter = ctx?.setHasFooter;
  React.useEffect(() => {
    if (!setHasFooter) return;
    setHasFooter(true);
    return () => setHasFooter(false);
  }, [setHasFooter]);
  return (
    <div
      className={cn(
        "flex flex-none flex-col-reverse gap-2 rounded-b-2xl border-t border-line bg-surface-2 px-5 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end",
        className,
      )}
    >
      {children}
      {/* Its own row above the buttons. */}
      <DialogError message={ctx?.error ?? null} className="sm:order-first sm:w-full" />
    </div>
  );
}
