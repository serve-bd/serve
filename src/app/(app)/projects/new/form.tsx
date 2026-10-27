"use client";

import * as React from "react";
import { useRouter } from "@/hooks/use-router";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Card, CardBody, CardFooter } from "@/components/ui/misc";
import { ColorPicker } from "@/components/color-picker";
import { useAction } from "@/hooks/use-action";
import { createProject } from "@/server/actions/projects";

/**
 * The new project form: in the dialog every New project button opens, or on the /projects/new
 * page that old links and dashboard shortcuts still reach. `onCancel`: the dialog closes itself.
 */
export function NewProjectForm({ inDialog, onCancel }: { inDialog?: boolean; onCancel?: () => void }) {
  const router = useRouter();
  const [color, setColor] = React.useState("blue");
  const { run, pending } = useAction(createProject, {
    refresh: false,
    onSuccess: (d) => {
      onCancel?.();
      router.push(`/projects/${d.id}`);
    },
  });
  const Body = inDialog ? DialogBody : CardBody;
  const Footer = inDialog ? DialogFooter : CardFooter;

  const form = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void run({ name: String(f.get("name")), description: String(f.get("description") ?? ""), color });
      }}
    >
      {inDialog && <DialogHeader title="New project" description="Apps, databases and services that belong together, with separate environments." />}
      <Body className="flex flex-col gap-5 py-5">
        <Field label="Name">
          <Input name="name" required autoFocus placeholder="Marketing site" maxLength={60} />
        </Field>
        <Field label="Description" optional>
          <Textarea name="description" rows={2} placeholder="What lives in this project?" className="min-h-16" />
        </Field>
        <Field label="Color">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
      </Body>
      <Footer className="justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={() => (onCancel ? onCancel() : router.back())}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={pending}>
          Create project
        </Button>
      </Footer>
    </form>
  );
  return inDialog ? form : <Card>{form}</Card>;
}
