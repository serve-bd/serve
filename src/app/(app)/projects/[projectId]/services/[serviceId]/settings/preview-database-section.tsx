"use client";

import { CodeEditor } from "@/components/code-editor";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { savePreviewDatabase } from "@/server/actions/environments";
import type { PreviewDatabaseConfig } from "@/server/services/types";
import { Section } from "./section";

/** Engines whose copies can run clean-up SQL. */
const SQL_ENGINES = ["postgres", "mysql", "mariadb", "clickhouse"];

/** Each pull request preview gets a fresh copy of a database, optionally with personal data replaced. */
export function PreviewDatabaseSection({
  serviceId,
  config,
  databases,
  previewsEnabled,
}: {
  serviceId: string;
  config: PreviewDatabaseConfig | null;
  databases: { id: string; name: string; engine: string; label: string }[];
  previewsEnabled: boolean;
}) {
  const save = useAction((v: Parameters<typeof savePreviewDatabase>[1]) => savePreviewDatabase(serviceId, v), { success: "Preview database saved" });
  const initial = {
    enabled: !!config,
    sourceServiceId: config?.sourceServiceId ?? databases[0]?.id ?? "",
    variable: config?.variable ?? "DATABASE_URL",
    scrub: !!config?.scrubSql,
    scrubSql: config?.scrubSql ?? "",
  };
  return (
    <Section
      id="preview-database"
      title="Preview databases"
      description="Give each pull request preview its own copy of a database, so previews never write to the real one."
      initial={initial}
      onSave={(v) =>
        save.run(
          v.enabled && v.sourceServiceId ? { sourceServiceId: v.sourceServiceId, variable: v.variable.trim() || "DATABASE_URL", scrubSql: v.scrub ? v.scrubSql : null } : null,
        )
      }
      footerNote={previewsEnabled ? "Applies to previews created from now on." : "Turn on preview deployments above for this to take effect."}
    >
      {(v, set) => {
        const engine = databases.find((d) => d.id === v.sourceServiceId)?.engine;
        const sql = !engine || SQL_ENGINES.includes(engine);
        return (
          <>
            <SwitchRow
              title="Copy a database for each preview"
              description={
                <>
                  When a pull request opens, a temporary database is created, a fresh dump is restored into it and the preview is deployed against it. It is removed with the
                  preview.
                </>
              }
              checked={v.enabled}
              disabled={!databases.length}
              onCheckedChange={(c) => set({ enabled: c })}
            />
            {!databases.length && <p className="text-[13px] text-muted">Add a database to this environment first.</p>}
            {v.enabled && databases.length > 0 && (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Database to copy">
                    <Select
                      value={v.sourceServiceId}
                      onValueChange={(id) => set({ sourceServiceId: id ?? "" })}
                      options={databases.map((d) => ({ value: d.id, label: `${d.name} · ${d.label}` }))}
                    />
                  </Field>
                  <Field label="Variable" description="The preview gets the copy's connection URL in this variable.">
                    <Input value={v.variable} onChange={(e) => set({ variable: e.target.value })} className="font-mono text-[13px]" />
                  </Field>
                </div>
                {sql ? (
                  <>
                    <SwitchRow
                      title="Hide personal data"
                      description="Run your SQL on the copy right after the restore, before the preview starts. If it fails, the copy is removed and the preview is not deployed."
                      checked={v.scrub}
                      onCheckedChange={(c) => set({ scrub: c })}
                    />
                    {v.scrub && (
                      <Field label="Clean-up SQL">
                        <CodeEditor
                          language="text"
                          value={v.scrubSql}
                          onChange={(scrubSql) => set({ scrubSql })}
                          minRows={6}
                          placeholder={"UPDATE users SET email = 'user' || id || '@example.com', name = 'User ' || id;\nDELETE FROM sessions;"}
                          aria-label="Clean-up SQL"
                        />
                      </Field>
                    )}
                  </>
                ) : (
                  <p className="text-[13px] text-muted">Clean-up SQL is available for PostgreSQL, MySQL, MariaDB and ClickHouse.</p>
                )}
              </>
            )}
          </>
        );
      }}
    </Section>
  );
}
