"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { NewProjectForm } from "@/app/(app)/projects/new/form";

const OPEN_EVENT = "serve:new-project";

/** Opens the New project dialog from anywhere in the app (buttons, the command palette). */
export function openNewProject() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Mounted once in the app shell, for members who may create projects. */
export function NewProjectDialog() {
  const [open, setOpen] = React.useState(false);
  // A fresh, empty form each time it opens (the closing one keeps its content while it fades).
  const [key, setKey] = React.useState(0);
  React.useEffect(() => {
    const show = () => {
      setKey((k) => k + 1);
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <NewProjectForm key={key} inDialog onCancel={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** The New project button: opens the dialog. */
export function NewProjectButton({ hidden }: { hidden?: boolean }) {
  if (hidden) return null;
  return (
    <Button variant="primary" size="sm" onClick={openNewProject}>
      <Plus /> New project
    </Button>
  );
}
