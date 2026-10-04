"use client";

import * as React from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useAction } from "@/hooks/use-action";
import { saveServiceTags } from "@/server/actions/tags";
import { TAG_NAME_RE, tagColorClass } from "@/lib/tags";
import { cn } from "@/lib/utils";
import { Section } from "./section";

/** The service's tags: pick existing ones or type new ones. */
export function TagsSection({ serviceId, tags, all, canEdit }: { serviceId: string; tags: string[]; all: { name: string; color: string }[]; canEdit: boolean }) {
  const save = useAction((names: string[]) => saveServiceTags(serviceId, names));
  const [draft, setDraft] = React.useState("");
  const colorOf = (name: string) => all.find((t) => t.name.toLowerCase() === name.toLowerCase())?.color ?? "gray";

  return (
    <Section
      id="tags"
      title="Tags"
      description={
        <>
          Labels to find services across projects, and to deploy all with one tag at once on the{" "}
          <Link href="/tags" className="text-accent hover:underline">
            Tags
          </Link>{" "}
          page.
        </>
      }
      initial={{ tags }}
      onSave={(v) => save.run(v.tags)}
    >
      {(v, set) => {
        const add = (raw: string) => {
          const name = raw.trim().replace(/\s+/g, "-");
          if (!name || !TAG_NAME_RE.test(name) || v.tags.some((t) => t.toLowerCase() === name.toLowerCase())) return;
          // An existing tag keeps its own spelling.
          set({ tags: [...v.tags, all.find((t) => t.name.toLowerCase() === name.toLowerCase())?.name ?? name] });
          setDraft("");
        };
        const suggestions = all.filter((t) => !v.tags.some((x) => x.toLowerCase() === t.name.toLowerCase()));
        const invalid = !!draft.trim() && !TAG_NAME_RE.test(draft.trim().replace(/\s+/g, "-"));
        return (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5">
              {v.tags.length === 0 && <span className="text-[13px] text-muted">No tags.</span>}
              {v.tags.map((t) => (
                <span key={t} className={cn("inline-flex h-6 items-center gap-1 rounded-full pr-1 pl-2.5 text-xs font-medium ring-1", tagColorClass(colorOf(t)))}>
                  {t}
                  {canEdit && (
                    <button type="button" onClick={() => set({ tags: v.tags.filter((x) => x !== t) })} className="rounded-full p-0.5 hover:bg-black/10" aria-label={`Remove ${t}`}>
                      <X className="size-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {canEdit && (
              <>
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter adds the tag instead of submitting the form.
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      add(draft);
                    }
                  }}
                  onBlur={() => add(draft)}
                  placeholder="Type a tag and press Enter"
                  list={`tags-${serviceId}`}
                  aria-invalid={invalid || undefined}
                  className="max-w-sm"
                />
                <datalist id={`tags-${serviceId}`}>
                  {suggestions.map((t) => (
                    <option key={t.name} value={t.name} />
                  ))}
                </datalist>
                {invalid && <p className="text-xs text-bad">Use letters, numbers, dots, dashes and underscores, up to 40.</p>}
                {suggestions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted">Add:</span>
                    {suggestions.slice(0, 12).map((t) => (
                      <button
                        key={t.name}
                        type="button"
                        onClick={() => add(t.name)}
                        className={cn("inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium opacity-70 ring-1 hover:opacity-100", tagColorClass(t.color))}
                      >
                        + {t.name}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      }}
    </Section>
  );
}
