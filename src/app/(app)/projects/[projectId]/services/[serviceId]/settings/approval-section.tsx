"use client";

import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { setServiceApproval } from "@/server/actions/deploy-rules";

type Mode = "project" | "always" | "never";

/** A service's own deploy approval, over the project's rule. */
export function ApprovalSection({
  serviceId,
  projectId,
  mode,
  projectWaits,
  canChange,
}: {
  serviceId: string;
  projectId: string;
  mode: "always" | "never" | null;
  /** Whether the project's rule makes this service's environment wait. */
  projectWaits: boolean;
  canChange: boolean;
}) {
  const save = useAction((next: Mode) => setServiceApproval(serviceId, next === "project" ? null : next));
  const value: Mode = mode ?? "project";
  return (
    <Card id="approval" className="scroll-mt-6">
      <CardHeader title="Approval" description="Whether deploys of this service wait until someone who can approve deploys lets them go." />
      <CardBody className="flex flex-col gap-3">
        <Field label="Deploys" description={canChange ? undefined : "Only someone who can approve deploys can change this."}>
          <Select
            value={value}
            disabled={!canChange || save.pending}
            onValueChange={(next) => void save.run(next as Mode)}
            options={[
              { value: "project", label: "Follow the project", description: projectWaits ? "The project's rule: they wait" : "The project's rule: they do not wait" },
              { value: "always", label: "Always wait for approval", description: "Even when the project's rule is off" },
              { value: "never", label: "Never wait", description: "Even when the project's rule is on" },
            ]}
          />
        </Field>
        <p className="text-xs leading-relaxed text-muted">
          Pushes, hooks, API calls and manual deploys wait. People who can approve deploys start their own right away. The project&apos;s rule is in{" "}
          <Link href={`/projects/${projectId}/settings/deploys`} className="text-accent hover:underline">
            Project settings → Deploys
          </Link>
          .
        </p>
      </CardBody>
    </Card>
  );
}
