"use client";

import * as React from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button } from "./button";
import { Input } from "./input";

type ConfirmOptions = {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** Require typing this text to enable the confirm button. */
  typeToConfirm?: string;
  children?: React.ReactNode;
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

const ConfirmContext = React.createContext<(opts: ConfirmOptions) => Promise<boolean>>(async () => false);

export function useConfirm() {
  return React.useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState("");

  const confirm = React.useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setTyped("");
        setPending({ ...opts, resolve });
        setOpen(true);
      }),
    [],
  );

  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setOpen(false);
  };

  const blocked = !!pending?.typeToConfirm && typed !== pending.typeToConfirm;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog.Root open={open} onOpenChange={(o) => !o && close(false)} onOpenChangeComplete={(o) => !o && setPending(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-[var(--backdrop)] backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <AlertDialog.Viewport className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[18vh]">
            <AlertDialog.Popup className="w-full max-w-md rounded-2xl border border-line bg-surface shadow-lg outline-none transition-[transform,opacity] duration-200 ease-[var(--ease-out-quint)] data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!blocked) close(true);
                }}
              >
                <div className="flex flex-col gap-2 px-5 pt-5 pb-4">
                  <AlertDialog.Title className="font-display text-[17px] font-semibold">{pending?.title}</AlertDialog.Title>
                  {pending?.description && (
                    <AlertDialog.Description className="text-[13px] leading-relaxed text-muted">{pending.description}</AlertDialog.Description>
                  )}
                  {pending?.children}
                  {pending?.typeToConfirm && (
                    <label className="mt-2 flex flex-col gap-1.5 text-[13px] text-fg-2">
                      <span>
                        Type <code className="rounded bg-sunken px-1 py-0.5 text-fg">{pending.typeToConfirm}</code> to confirm
                      </span>
                      <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
                    </label>
                  )}
                </div>
                <div className="flex justify-end gap-2 rounded-b-2xl border-t border-line bg-surface-2 px-5 py-3">
                  <AlertDialog.Close render={<Button variant="ghost" size="sm" />}>Cancel</AlertDialog.Close>
                  <Button type="submit" size="sm" variant={pending?.danger ? "danger" : "primary"} disabled={blocked} autoFocus={!pending?.typeToConfirm}>
                    {pending?.confirmLabel ?? "Confirm"}
                  </Button>
                </div>
              </form>
            </AlertDialog.Popup>
          </AlertDialog.Viewport>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </ConfirmContext.Provider>
  );
}
