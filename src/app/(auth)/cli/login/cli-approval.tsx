"use client";

import * as React from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useRouter } from "@/hooks/use-router";
import { AuthError } from "../../_components/auth-card";
import { approveCliSignIn, denyCliSignIn } from "@/server/actions/cli-login";

export function CliApproval({
  code,
  client,
  organizations,
  defaultOrganization,
  apiEnabled,
}: {
  code: string;
  client: string;
  organizations: { id: string; name: string; canDeploy: boolean }[];
  defaultOrganization: string | null;
  apiEnabled: boolean;
}) {
  const [organizationId, setOrganizationId] = React.useState(defaultOrganization);
  const [pending, setPending] = React.useState<"approve" | "deny" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [answer, setAnswer] = React.useState<"approved" | "denied" | null>(null);
  const selected = organizations.find((o) => o.id === organizationId) ?? null;

  if (answer) {
    const approved = answer === "approved";
    return (
      <div className="flex items-start gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3.5">
        {approved ? <CheckCircle2 className="mt-0.5 size-5 flex-none text-ok" /> : <XCircle className="mt-0.5 size-5 flex-none text-bad" />}
        <div className="flex flex-col gap-0.5">
          <p className="text-[14px] font-medium text-fg">{approved ? "The CLI is signed in" : "Sign-in denied"}</p>
          <p className="text-[13px] leading-relaxed text-muted">
            {approved
              ? `Go back to your terminal. The token "CLI on ${client}" is listed in Keys & tokens, where you can revoke it.`
              : "The CLI was not signed in. You can close this tab."}
          </p>
        </div>
      </div>
    );
  }

  const run = async (kind: "approve" | "deny") => {
    setPending(kind);
    setError(null);
    const res = kind === "approve" ? await approveCliSignIn({ code, organizationId: organizationId ?? "" }) : await denyCliSignIn(code);
    setPending(null);
    if (!res.ok) return setError(res.error);
    setAnswer(kind === "approve" ? "approved" : "denied");
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-1 rounded-xl border border-line bg-surface-2 px-4 py-4">
        <span className="text-[11px] font-medium tracking-[0.08em] text-faint uppercase">Code</span>
        <span className="font-mono text-[26px] font-semibold tracking-[0.12em] text-fg">{code}</span>
      </div>
      {organizations.length > 1 && (
        <Field label="Organization" description="The CLI works in this organization, with what your role there allows.">
          <Select value={organizationId} onValueChange={setOrganizationId} options={organizations.map((o) => ({ value: o.id, label: o.name }))} />
        </Field>
      )}
      {!organizations.length && <AuthError>You are not a member of any organization, so the CLI would have nothing to work on.</AuthError>}
      {selected && !selected.canDeploy && (
        <p className="rounded-lg border border-warn/20 bg-warn-soft px-3 py-2 text-[13px] text-warn">
          Your role in {selected.name} cannot deploy. The CLI can look around there, but serve deploy will be refused. Ask an admin for a role that can deploy.
        </p>
      )}
      {!apiEnabled && <AuthError>The API is turned off, so the CLI cannot do anything yet. An admin of this Serve instance can turn it on in Settings → Security.</AuthError>}
      <AuthError>{error}</AuthError>
      <div className="flex flex-col gap-2">
        <Button variant="primary" size="lg" className="w-full" loading={pending === "approve"} disabled={!!pending || !organizationId} onClick={() => run("approve")}>
          Approve
        </Button>
        <Button size="lg" className="w-full" loading={pending === "deny"} disabled={!!pending} onClick={() => run("deny")}>
          Deny
        </Button>
      </div>
    </div>
  );
}

/** For a page opened without a usable code: type the one the terminal shows. */
export function CodeForm() {
  const router = useRouter();
  const [code, setCode] = React.useState("");
  const valid = /^[A-Za-z]{4}-?[0-9]{4}$/.test(code.trim());
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) router.push(`/cli/login?code=${encodeURIComponent(code.trim().toUpperCase())}`);
      }}
    >
      <Field label="Code">
        <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="BCDF-2345" autoFocus autoComplete="off" spellCheck={false} className="font-mono uppercase" />
      </Field>
      <Button type="submit" variant="primary" size="lg" className="w-full" disabled={!valid}>
        Continue
      </Button>
    </form>
  );
}
