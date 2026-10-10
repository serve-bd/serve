"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogError, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** Asks for one file or folder name (new folder, rename). Errors stay in the dialog. */
export function NameDialog({
  open,
  onOpenChange,
  title,
  label,
  initial,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  initial: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setName(initial);
      setError(null);
    }
  }, [open, initial]);
  const problem = !name.trim() ? "" : name.includes("/") ? "A name cannot hold a slash." : name === "." || name === ".." ? "Choose another name." : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (problem !== null || name === initial) return;
            setBusy(true);
            setError(null);
            try {
              await onSubmit(name);
              onOpenChange(false);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader title={title} />
          <DialogBody>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium text-fg">
              {label}
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                spellCheck={false}
                className="font-mono"
                onFocus={(e) => {
                  // Select the name without its extension, like a file manager.
                  const dot = e.target.value.lastIndexOf(".");
                  e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
                }}
              />
            </label>
            {problem && <p className="text-xs text-bad">{problem}</p>}
            <DialogError message={error} />
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={busy} disabled={problem !== null || name === initial}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
