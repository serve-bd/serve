"use client";

import type * as React from "react";
import { Toast } from "@base-ui/react/toast";
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export const toastManager = Toast.createToastManager();

type Kind = "success" | "error" | "info" | "warning" | "loading";

function add(kind: Kind, title: string, description?: string, timeout?: number) {
  return toastManager.add({ title, description, type: kind, timeout: timeout ?? (kind === "error" ? 8000 : 4000) });
}

/** Imperative toast helper usable anywhere in client code. */
export const toast = {
  success: (title: string, description?: string) => add("success", title, description),
  error: (title: string, description?: string) => add("error", title, description),
  info: (title: string, description?: string) => add("info", title, description),
  warning: (title: string, description?: string, timeout?: number) => add("warning", title, description, timeout),
  promise: <T,>(promise: Promise<T>, msgs: { loading: string; success: string | ((v: T) => string); error: string | ((e: unknown) => string) }) =>
    toastManager.promise(promise, {
      loading: { title: msgs.loading, type: "loading" },
      success: (v: T) => ({ title: typeof msgs.success === "function" ? msgs.success(v) : msgs.success, type: "success" }),
      error: (e: unknown) => ({ title: typeof msgs.error === "function" ? msgs.error(e) : msgs.error, type: "error" }),
    }),
  dismiss: (id: string) => toastManager.close(id),
};

const icons: Record<Kind, React.ReactNode> = {
  success: <CheckCircle2 className="size-4 text-ok" />,
  error: <XCircle className="size-4 text-bad" />,
  info: <Info className="size-4 text-info" />,
  warning: <AlertTriangle className="size-4 text-warn" />,
  loading: <Loader2 className="size-4 animate-spin text-muted" />,
};

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((t) => (
    <Toast.Root key={t.id} toast={t} className="toast rounded-lg border border-line bg-surface shadow-lg">
      <Toast.Content className="toast-content flex items-start gap-3 overflow-hidden px-3.5 py-3">
        <span className="mt-0.5">{icons[(t.type as Kind) ?? "info"] ?? icons.info}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Toast.Title className="text-[13px] font-medium text-fg" />
          <Toast.Description className="text-xs leading-relaxed break-words text-muted" />
        </div>
        <Toast.Close className="-mr-1 rounded p-0.5 text-faint hover:bg-hover hover:text-fg" aria-label="Dismiss">
          <X className="size-3.5" />
        </Toast.Close>
      </Toast.Content>
    </Toast.Root>
  ));
}

export function Toaster({ children }: { children: React.ReactNode }) {
  return (
    <Toast.Provider toastManager={toastManager} limit={4}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className={cn("toast-viewport")}>
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
