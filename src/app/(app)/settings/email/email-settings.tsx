"use client";

import * as React from "react";
import { Mail, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge, Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { removeEmailSettings, saveEmailSettings, sendTestEmail } from "@/server/actions/email";

type Provider = "smtp" | "resend" | "postmark";
type Security = "none" | "starttls" | "tls";

type Initial = {
  provider: Provider;
  fromName: string;
  fromAddress: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: Security;
  smtpUsername: string;
  hasPassword: boolean;
  hasApiKey: boolean;
} | null;

const providers: { value: Provider; label: string; description: string }[] = [
  { value: "smtp", label: "SMTP", description: "Any mail server: your own, Gmail, Amazon SES, Mailgun, …" },
  { value: "resend", label: "Resend", description: "API key from the Resend dashboard" },
  { value: "postmark", label: "Postmark", description: "Server API token" },
];

const ports: Record<Security, number> = { none: 25, starttls: 587, tls: 465 };

export function EmailSettingsForm({ initial }: { initial: Initial }) {
  const confirm = useConfirm();
  const blank = {
    provider: "smtp" as Provider,
    fromName: "",
    fromAddress: "",
    smtpHost: "",
    smtpPort: 587,
    smtpSecurity: "starttls" as Security,
    smtpUsername: "",
  };
  const start = initial ?? { ...blank, hasPassword: false, hasApiKey: false };
  const [v, setV] = React.useState({ ...start, smtpPassword: "", apiKey: "" });
  const [saved, setSaved] = React.useState(JSON.stringify({ ...start, smtpPassword: "", apiKey: "" }));
  const set =
    <K extends keyof typeof v>(k: K) =>
    (value: (typeof v)[K]) =>
      setV((s) => ({ ...s, [k]: value }));
  const dirty = JSON.stringify(v) !== saved;
  const configured = !!initial;

  const save = useAction(
    () =>
      saveEmailSettings({
        provider: v.provider,
        fromName: v.fromName,
        fromAddress: v.fromAddress,
        smtpHost: v.smtpHost,
        smtpPort: v.smtpPort,
        smtpSecurity: v.smtpSecurity,
        smtpUsername: v.smtpUsername,
        smtpPassword: v.smtpPassword || undefined,
        apiKey: v.apiKey || undefined,
      }),
    {
      success: "Email settings saved",
      onSuccess: () => {
        const next = { ...v, smtpPassword: "", apiKey: "", hasPassword: v.hasPassword || !!v.smtpPassword, hasApiKey: v.hasApiKey || !!v.apiKey };
        setV(next);
        setSaved(JSON.stringify(next));
      },
    },
  );
  const test = useAction(sendTestEmail, { success: (d) => `Test email sent to ${d.to}`, refresh: false });
  const remove = useAction(removeEmailSettings, { success: "Email turned off" });

  return (
    <Card>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <CardHeader
          title={<span className="flex items-center gap-2">Email {configured ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}</span>}
          description="Serve sends password resets, invitations and email notifications with these settings."
        />
        <CardBody className="flex flex-col gap-5 py-5">
          <Field label="Send with">
            <Select value={v.provider} onValueChange={(p) => set("provider")(p as Provider)} options={providers} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="From name" optional>
              <Input value={v.fromName} onChange={(e) => set("fromName")(e.target.value)} placeholder="Serve" />
            </Field>
            <Field label="From address">
              <Input type="email" value={v.fromAddress} onChange={(e) => set("fromAddress")(e.target.value)} placeholder="serve@example.com" required />
            </Field>
          </div>

          {v.provider === "smtp" ? (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_8rem_10rem]">
                <Field label="SMTP host">
                  <Input value={v.smtpHost} onChange={(e) => set("smtpHost")(e.target.value.trim())} placeholder="smtp.example.com" className="font-mono text-[13px]" required />
                </Field>
                <Field label="Port">
                  <Input value={String(v.smtpPort)} onChange={(e) => set("smtpPort")(Number(e.target.value.replace(/\D/g, "")) || 0)} inputMode="numeric" />
                </Field>
                <Field label="Security">
                  <Select
                    value={v.smtpSecurity}
                    onValueChange={(s) => setV((x) => ({ ...x, smtpSecurity: s as Security, smtpPort: x.smtpPort === ports[x.smtpSecurity] ? ports[s as Security] : x.smtpPort }))}
                    options={[
                      { value: "starttls", label: "STARTTLS" },
                      { value: "tls", label: "TLS" },
                      { value: "none", label: "None" },
                    ]}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Username" optional>
                  <Input value={v.smtpUsername} onChange={(e) => set("smtpUsername")(e.target.value)} autoComplete="off" />
                </Field>
                <Field label="Password" optional={!v.smtpUsername} description={v.hasPassword ? "Saved. Leave empty to keep it." : undefined}>
                  <Input
                    type="password"
                    value={v.smtpPassword}
                    onChange={(e) => set("smtpPassword")(e.target.value)}
                    autoComplete="new-password"
                    placeholder={v.hasPassword ? "••••••••" : ""}
                  />
                </Field>
              </div>
            </>
          ) : (
            <Field label="API key" description={v.hasApiKey && initial?.provider === v.provider ? "Saved. Leave empty to keep it." : undefined}>
              <Input
                type="password"
                value={v.apiKey}
                onChange={(e) => set("apiKey")(e.target.value)}
                autoComplete="new-password"
                placeholder={v.hasApiKey && initial?.provider === v.provider ? "••••••••" : v.provider === "resend" ? "re_…" : "Server API token"}
                className="font-mono text-[13px]"
              />
            </Field>
          )}
        </CardBody>
        <CardFooter className="justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={() => test.run()} loading={test.pending} disabled={!configured || dirty} title={dirty ? "Save first" : undefined}>
              <Send /> Send test email
            </Button>
            {configured && (
              <Button
                type="button"
                size="sm"
                variant="danger-ghost"
                onClick={async () => {
                  if (
                    await confirm({
                      title: "Turn off email?",
                      description: "Password reset by email and email notifications stop working.",
                      confirmLabel: "Turn off",
                      danger: true,
                    })
                  )
                    remove.run();
                }}
              >
                <Trash2 /> Turn off
              </Button>
            )}
          </div>
          <Button type="submit" variant="primary" size="sm" loading={save.pending} disabled={!dirty}>
            <Mail /> Save
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
