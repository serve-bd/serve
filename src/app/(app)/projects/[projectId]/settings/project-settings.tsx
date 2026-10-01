"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { ColorPicker } from "@/components/color-picker";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { deleteEnvironment, deleteProject, redeployEnvironment, saveSharedVars, updateProject } from "@/server/actions/projects";
import { parseEnv } from "@/lib/env";

export type ProjectSettingsSection = "general" | "variables" | "environments";

export function ProjectSettings({
  section,
  project,
  environments,
  environment,
  shared,
  canEditShared,
  canManage,
  canDeploy,
}: {
  section: ProjectSettingsSection;
  project: { id: string; name: string; description: string; color: string; groupServices: boolean };
  environments: { id: string; name: string; services: number }[];
  environment: { id: string; name: string };
  shared: { key: string; value: string }[];
  /** Values are only sent to roles that may see and edit them. */
  canEditShared: boolean;
  canManage: boolean;
  canDeploy: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [name, setName] = React.useState(project.name);
  const [description, setDescription] = React.useState(project.description);
  const [color, setColor] = React.useState(project.color);
  const [groupServices, setGroupServices] = React.useState(project.groupServices);
  const initialRaw = shared.map((s) => `${s.key}=${/[\s#"'$]/.test(s.value) ? JSON.stringify(s.value) : s.value}`).join("\n");
  const [raw, setRaw] = React.useState(initialRaw);

  const save = useAction(() => updateProject(project.id, { name, description, color, groupServices }), { success: "Project updated" });
  const saveVars = useAction(() => saveSharedVars(environment.id, parseEnv(raw)), { success: "Shared variables saved" });
  const redeploy = useAction(() => redeployEnvironment(environment.id), { success: (d) => `Redeploying ${d.count} services` });
  const removeEnv = useAction(deleteEnvironment, { success: "Environment deleted", onSuccess: () => router.replace(`/projects/${project.id}/settings/environments`) });
  const remove = useAction(() => deleteProject(project.id), { refresh: false, success: "Project deleted", onSuccess: () => router.replace("/projects") });

  return (
    <div className="flex flex-col gap-6">
      {section === "general" && (
        <Card>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save.run();
            }}
          >
            <CardHeader title="General" />
            <CardBody className="flex flex-col gap-4 py-5">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <Field label="Description" optional>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="min-h-16" />
              </Field>
              <Field label="Color">
                <ColorPicker value={color} onChange={setColor} />
              </Field>
              <SwitchRow
                title="Group services"
                description="Show applications, databases and stacks in their own sections on the project page."
                checked={groupServices}
                onCheckedChange={setGroupServices}
                disabled={!canManage}
              />
            </CardBody>
            <CardFooter className="justify-end">
              <Button
                type="submit"
                size="sm"
                variant="primary"
                loading={save.pending}
                disabled={!canManage || (name === project.name && description === project.description && color === project.color && groupServices === project.groupServices)}
              >
                Save
              </Button>
            </CardFooter>
          </form>
        </Card>
      )}

      {section === "variables" && (
        <Card>
          <CardHeader
            title="Shared variables"
            description={
              <>
                Services of the selected environment use them by reference, like <code className="font-mono">{"KEY=${{environment.KEY}}"}</code>, added on a service&apos;s
                Variables page. Project and organization variables live in{" "}
                <Link href={`/shared-variables?scope=project&project=${project.id}`} className="text-accent hover:underline">
                  Shared variables
                </Link>
                .
              </>
            }
            actions={
              <Select
                size="sm"
                value={environment.name}
                onValueChange={(v) => router.push(`/projects/${project.id}/settings/variables?env=${v}`)}
                options={environments.map((e) => ({ value: e.name, label: e.name }))}
                className="w-40"
              />
            }
          />
          <CardBody className="py-4">
            {!canEditShared ? (
              <p className="text-[13px] text-muted">
                {shared.length ? `${shared.length} variable${shared.length === 1 ? "" : "s"}: ${shared.map((s) => s.key).join(", ")}. ` : "No shared variables. "}
                Your role cannot see or edit their values.
              </p>
            ) : (
              <Textarea
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                rows={Math.max(6, raw.split("\n").length + 1)}
                placeholder={"APP_ENV=production\nSENTRY_DSN=https://…"}
                className="font-mono text-[12.5px] leading-relaxed"
                spellCheck={false}
              />
            )}
          </CardBody>
          <CardFooter>
            <Button size="sm" variant="ghost" onClick={() => redeploy.run()} loading={redeploy.pending} disabled={!canDeploy}>
              Redeploy services
            </Button>
            <Button size="sm" variant="primary" onClick={() => saveVars.run()} loading={saveVars.pending} disabled={raw === initialRaw || !canEditShared}>
              Save variables
            </Button>
          </CardFooter>
        </Card>
      )}

      {section === "environments" && (
        <Card className="overflow-hidden">
          <CardHeader title="Environments" description="Create environments from the switcher on the project page." />
          <div className="divide-y divide-line">
            {environments.map((e) => (
              <div key={e.id} className="flex items-center gap-3 px-5 py-3">
                <span className="flex-1 font-mono text-[13px] text-fg">{e.name}</span>
                <span className="text-xs text-muted">
                  {e.services} service{e.services === 1 ? "" : "s"}
                </span>
                {canManage && environments.length > 1 && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${e.name}`}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Delete the ${e.name} environment?`,
                          description: "All its services, volumes and domains are deleted.",
                          confirmLabel: "Delete environment",
                          danger: true,
                          typeToConfirm: e.name,
                        })
                      )
                        removeEnv.run(e.id);
                    }}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {section === "general" && canManage && (
        <Card className="border-bad/30">
          <CardHeader title="Delete project" description="Deletes every service, database, volume and domain in all environments." />
          <CardFooter className="justify-end">
            <Button
              size="sm"
              variant="danger"
              loading={remove.pending}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Delete ${project.name}?`,
                    description: "This permanently deletes all data in this project.",
                    confirmLabel: "Delete project",
                    danger: true,
                    typeToConfirm: project.name,
                  })
                )
                  remove.run();
              }}
            >
              <Trash2 /> Delete project
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
