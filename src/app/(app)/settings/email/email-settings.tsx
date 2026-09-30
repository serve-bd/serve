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
import { useProductName } from "@/components/brand";

type Provider = "smtp" | "resend" | "postmark" | "mailroom";
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
  baseUrl: string;
} | null;

const providers: { value: Provider; label: string; description: string }[] = [
  { value: "smtp", label: "SMTP", description: "Any mail server: your own, Gmail, Amazon SES, Mailgun, …" },
  { value: "resend", label: "Resend", description: "API key from the Resend dashboard" },
  { value: "postmark", label: "Postmark", description: "Server API token" },
  { value: "mailroom", label: "Mailroom", description: "Your own Mailroom instance, with an API key" },
];

const ports: Record<Security, number> = { none: 25, starttls: 587, tls: 465 };

type MailroomService = { id: string; label: string; url: string | null };

export function EmailSettingsForm({ initial, mailrooms }: { initial: Initial; mailrooms: MailroomService[] }) {
  const confirm = useConfirm();
  const productName = useProductName();
  const blank = {
    provider: "smtp" as Provider,
    fromName: "",
    fromAddress: "",
    smtpHost: "",
    smtpPort: 587,
    smtpSecurity: "starttls" as Security,
    smtpUsername: "",
    baseUrl: "",
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
        baseUrl: v.baseUrl,
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
          description={<>Password resets, invitations and email notifications are sent with these settings.</>}
        />
        <CardBody className="flex flex-col gap-5 py-5">
          <Field label="Send with">
            <Select value={v.provider} onValueChange={(p) => set("provider")(p as Provider)} options={providers} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="From name" optional>
              <Input value={v.fromName} onChange={(e) => set("fromName")(e.target.value)} placeholder={productName} />
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
            <>
              {v.provider === "mailroom" && (
                <>
                  {mailrooms.length > 0 && (
                    <Field label={<>Mailroom deployed here</>} description="Fills in the address of a Mailroom you deployed here.">
                      <Select
                        value={mailrooms.find((m) => m.url === v.baseUrl)?.id ?? ""}
                        onValueChange={(id) => {
                          const m = mailrooms.find((x) => x.id === id);
                          if (m?.url) set("baseUrl")(m.url);
                        }}
                        placeholder="Choose a service"
                        options={mailrooms.map((m) => ({ value: m.id, label: m.label, description: m.url ?? "Add a domain to this service first", disabled: !m.url }))}
                      />
                    </Field>
                  )}
                  <Field label="Mailroom address" description={<>The address you open Mailroom at. Emails go through its API at /api/v1/emails.</>}>
                    <Input value={v.baseUrl} onChange={(e) => set("baseUrl")(e.target.value)} placeholder="https://mail.example.com" className="font-mono text-[13px]" required />
                  </Field>
                </>
              )}
              <Field
                label="API key"
                description={
                  v.hasApiKey && initial?.provider === v.provider
                    ? "Saved. Leave empty to keep it."
                    : v.provider === "mailroom"
                      ? "Create one in Mailroom under Settings → API keys, with the emails:send scope. The From address must be on a domain verified in Mailroom."
                      : undefined
                }
              >
                <Input
                  type="password"
                  value={v.apiKey}
                  onChange={(e) => set("apiKey")(e.target.value)}
                  autoComplete="new-password"
                  placeholder={
                    v.hasApiKey && initial?.provider === v.provider ? "••••••••" : v.provider === "resend" ? "re_…" : v.provider === "mailroom" ? "mk_live_…" : "Server API token"
                  }
                  className="font-mono text-[13px]"
                />
              </Field>
            </>
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
