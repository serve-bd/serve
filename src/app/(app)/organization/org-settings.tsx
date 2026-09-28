"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LogOut, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader, CopyField } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { deleteOrg, updateOrg } from "@/server/actions/org";

export function OrgSettings({ org, role, isRoot }: { org: { id: string; name: string; slug: string }; role: string; isRoot: boolean }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [name, setName] = React.useState(org.name);
  const isAdmin = role === "owner" || role === "admin";
  const save = useAction(() => updateOrg({ name }), { success: "Organization updated" });
  const remove = useAction(deleteOrg, { refresh: false, success: "Organization deleted", onSuccess: () => { router.replace("/"); router.refresh(); } });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <CardHeader title="General" />
          <CardBody className="flex flex-col gap-4 py-5">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} required />
            </Field>
            <Field label="Organization ID">
              <CopyField value={org.id} />
            </Field>
            {isRoot && (
              <p className="rounded-xl bg-accent-soft px-3.5 py-2.5 text-[13px] text-fg-2">
                This is the Root organization. Its owners and admins manage server-wide settings.
              </p>
            )}
          </CardBody>
          {isAdmin && (
            <CardFooter className="justify-end">
              <Button type="submit" size="sm" variant="primary" disabled={name === org.name} loading={save.pending}>Save</Button>
            </CardFooter>
          )}
        </form>
      </Card>

      {role === "owner" && !isRoot && (
        <Card className="border-bad/30">
          <CardHeader title="Delete organization" description="Permanently delete this organization, its integrations and members. Delete its projects first." />
          <CardFooter className="justify-end">
            <Button
              size="sm"
              variant="danger"
              loading={remove.pending}
              onClick={async () => {
                if (await confirm({ title: `Delete ${org.name}?`, description: "This cannot be undone.", confirmLabel: "Delete organization", danger: true, typeToConfirm: org.name })) remove.run();
              }}
            >
              <Trash2 /> Delete organization
            </Button>
          </CardFooter>
        </Card>
      )}
      {!isAdmin && (
        <Card>
          <CardHeader title="Leave organization" description="Leave from the Members page." />
          <CardFooter className="justify-end">
            <Button size="sm" onClick={() => router.push("/organization/members")}><LogOut /> Go to members</Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
