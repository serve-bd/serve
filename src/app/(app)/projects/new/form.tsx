"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Card, CardBody, CardFooter } from "@/components/ui/misc";
import { ColorPicker } from "@/components/color-picker";
import { useAction } from "@/hooks/use-action";
import { createProject } from "@/server/actions/projects";

export function NewProjectForm() {
  const router = useRouter();
  const [color, setColor] = React.useState("blue");
  const { run, pending } = useAction(createProject, {
    refresh: false,
    onSuccess: (d) => router.push(`/projects/${d.id}`),
  });

  return (
    <Card>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void run({ name: String(f.get("name")), description: String(f.get("description") ?? ""), color });
        }}
      >
        <CardBody className="flex flex-col gap-5 py-5">
          <Field label="Name">
            <Input name="name" required autoFocus placeholder="Marketing site" maxLength={60} />
          </Field>
          <Field label="Description" optional>
            <Textarea name="description" rows={2} placeholder="What lives in this project?" className="min-h-16" />
          </Field>
          <Field label="Color">
            <ColorPicker value={color} onChange={setColor} />
          </Field>
        </CardBody>
        <CardFooter className="justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={pending}>
            Create project
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
