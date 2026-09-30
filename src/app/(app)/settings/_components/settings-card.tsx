"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { useAction } from "@/hooks/use-action";
import { saveServerSettings } from "@/server/actions/server";

type Values = Parameters<typeof saveServerSettings>[0];

type Saved = { ok: true; data: unknown } | { ok: false; error: string };

/** A card that edits a few settings and saves them together. */
export function SettingsCard<T extends Record<string, unknown>>({
  title,
  description,
  initial,
  children,
  footerNote,
  actions,
  transform,
  onSave,
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
  /** Save somewhere other than the instance settings (for example a server row). */
  onSave?: (values: T) => Promise<Saved>;
}) {
  const [values, setValues] = React.useState<T>(initial);
  const [saved, setSaved] = React.useState(JSON.stringify(initial));
  const dirty = JSON.stringify(values) !== saved;
  const set =
    <K extends keyof T>(key: K) =>
    (value: T[K]) =>
      setValues((v) => ({ ...v, [key]: value }));
  // Set by a successful save: once its refresh has landed, show what was stored (the server may
  // clamp or default what was typed, like 0 builds or an empty port).
  const adopt = React.useRef(false);
  const save = useAction(() => (onSave ? onSave(values) : saveServerSettings(transform ? transform(values) : (values as Values))), {
    success: "Settings saved",
    onSuccess: () => {
      adopt.current = true;
      setSaved(JSON.stringify(values));
    },
  });
  React.useEffect(() => {
    if (save.pending || !adopt.current) return;
    adopt.current = false;
    setValues(initial);
    setSaved(JSON.stringify(initial));
  }, [save.pending, initial]);
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
