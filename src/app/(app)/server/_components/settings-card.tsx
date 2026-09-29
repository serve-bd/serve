"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { useAction } from "@/hooks/use-action";
import { saveServerSettings } from "@/server/actions/server";

type Values = Parameters<typeof saveServerSettings>[0];

/** A card that edits a few server settings and saves them together. */
export function SettingsCard<T extends Values>({
  title,
  description,
  initial,
  children,
  footerNote,
  actions,
  transform,
}: {
  title: string;
  description?: React.ReactNode;
  initial: T;
  children: (values: T, set: <K extends keyof T>(key: K) => (value: T[K]) => void) => React.ReactNode;
  footerNote?: React.ReactNode;
  /** Buttons in the card header. */
  actions?: React.ReactNode;
  /** Adjust values right before saving (for example split a textarea into a list). */
  transform?: (values: T) => Values;
}) {
  const [values, setValues] = React.useState<T>(initial);
  const [saved, setSaved] = React.useState(JSON.stringify(initial));
  const dirty = JSON.stringify(values) !== saved;
  const set =
    <K extends keyof T>(key: K) =>
    (value: T[K]) =>
      setValues((v) => ({ ...v, [key]: value }));
  const save = useAction(() => saveServerSettings(transform ? transform(values) : values), {
    success: "Settings saved",
    onSuccess: () => setSaved(JSON.stringify(values)),
  });
  return (
    <Card>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <CardHeader title={title} description={description} actions={actions} />
        <CardBody className="flex flex-col gap-4 py-5">{children(values, set)}</CardBody>
        <CardFooter>
          <span className="truncate text-xs text-muted">{dirty ? "Unsaved changes" : footerNote}</span>
          <div className="flex flex-none gap-2">
            {dirty && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setValues(JSON.parse(saved))}>
                Discard
              </Button>
            )}
            <Button type="submit" size="sm" variant="primary" disabled={!dirty} loading={save.pending}>
              Save
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}
