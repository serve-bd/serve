"use client";

import * as React from "react";
import { useRouter } from "@/hooks/use-router";
import { Laptop, LogOut, ShieldCheck } from "lucide-react";
import QRCode from "qrcode";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader, TimeAgo, Badge } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import useSWR from "swr";
import { authClient } from "@/lib/auth-client";
import { useProductName } from "@/components/brand";

type SessionRow = { id: string; token: string; userAgent?: string | null; ipAddress?: string | null; createdAt: Date; updatedAt: Date };

function device(ua?: string | null) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return `${browser}${os ? ` on ${os}` : ""}`;
}

export function AccountView({ user }: { user: { name: string; email: string; twoFactorEnabled: boolean } }) {
  const router = useRouter();
  const [name, setName] = React.useState(user.name);
  const [saving, setSaving] = React.useState(false);
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [changing, setChanging] = React.useState(false);
  const { data, mutate } = useSWR("account-sessions", async () => {
    const [list, me] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
    return { sessions: (list.data ?? []) as SessionRow[], currentToken: me.data?.session.token ?? null };
  });
  const sessions = data?.sessions ?? [];
  const currentToken = data?.currentToken ?? null;
  const load = () => void mutate();

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            const { error } = await authClient.updateUser({ name });
            setSaving(false);
            if (error) return toast.error(error.message ?? "Could not save");
            toast.success("Profile updated");
            router.refresh();
          }}
        >
          <CardHeader title="Profile" />
          <CardBody className="flex flex-col gap-4 py-5">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label="Email">
              <Input value={user.email} disabled />
            </Field>
          </CardBody>
          <CardFooter className="justify-end">
            <Button type="submit" size="sm" variant="primary" disabled={name === user.name} loading={saving}>
              Save
            </Button>
          </CardFooter>
        </form>
      </Card>

      <Card>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setChanging(true);
            const { error } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
            setChanging(false);
            if (error) return toast.error(error.message ?? "Could not change password");
            toast.success("Password changed. Other devices were signed out.");
            setCurrent("");
            setNext("");
            void load();
          }}
        >
          <CardHeader title="Password" />
          <CardBody className="grid grid-cols-1 gap-4 py-5 sm:grid-cols-2">
            <Field label="Current password">
              <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
            </Field>
            <Field label="New password" description="At least 8 characters.">
              <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} autoComplete="new-password" />
            </Field>
          </CardBody>
          <CardFooter className="justify-end">
            <Button type="submit" size="sm" variant="primary" loading={changing} disabled={!current || next.length < 8}>
              Change password
            </Button>
          </CardFooter>
        </form>
      </Card>

      <TwoFactorCard enabled={user.twoFactorEnabled} />

      <Card className="overflow-hidden">
        <CardHeader
          title="Sessions"
          description="Devices signed in to your account."
          actions={
            sessions.length > 1 && (
              <Button
                size="sm"
                onClick={async () => {
                  await authClient.revokeOtherSessions();
                  toast.success("Signed out other devices");
                  void load();
                }}
              >
                Sign out others
              </Button>
            )
          }
        />
        <div className="divide-y divide-line">
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-5 py-3">
              <Laptop className="size-4 text-muted" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
                  {device(s.userAgent)} {s.token === currentToken && <Badge tone="ok">This device</Badge>}
                </span>
                <span className="text-xs text-muted">
                  {s.ipAddress ?? "Unknown IP"} · active <TimeAgo date={s.updatedAt} />
                </span>
              </div>
              {s.token !== currentToken && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Sign out"
                  onClick={async () => {
                    await authClient.revokeSession({ token: s.token });
                    void load();
                  }}
                >
                  <LogOut />
                </Button>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function TwoFactorCard({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const productName = useProductName();
  const [step, setStep] = React.useState<"password" | "scan">("password");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [qr, setQr] = React.useState<string | null>(null);
  const [backupCodes, setBackupCodes] = React.useState<string[]>([]);
  const [pending, setPending] = React.useState(false);

  const reset = () => {
    setStep("password");
    setPassword("");
    setCode("");
    setQr(null);
    setBackupCodes([]);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      if (enabled) {
        const { error } = await authClient.twoFactor.disable({ password });
        if (error) return toast.error(error.message ?? "Could not disable two-factor authentication");
        toast.success("Two-factor authentication disabled");
        setOpen(false);
        router.refresh();
      } else if (step === "password") {
        // The authenticator app lists the account under the white-label name.
        const { data, error } = await authClient.twoFactor.enable({ password, issuer: productName });
        if (error || !data || !("totpURI" in data)) return toast.error(error?.message ?? "Wrong password");
        setQr(await QRCode.toDataURL(data.totpURI, { margin: 1, width: 200 }));
        setBackupCodes(data.backupCodes);
        setStep("scan");
      } else {
        const { error } = await authClient.twoFactor.verifyTotp({ code });
        if (error) return toast.error(error.message ?? "That code is not valid");
        toast.success("Two-factor authentication enabled");
        setOpen(false);
        router.refresh();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Two-factor authentication"
        description="Require a code from an authenticator app when signing in."
        actions={
          <Button
            size="sm"
            variant={enabled ? "secondary" : "primary"}
            onClick={() => {
              reset();
              setOpen(true);
            }}
          >
            <ShieldCheck /> {enabled ? "Disable" : "Enable"}
          </Button>
        }
      />
      <CardBody>
        <p className="flex items-center gap-2 text-[13px] text-fg-2">
          <span className={`size-2 rounded-full ${enabled ? "bg-ok" : "bg-idle"}`} />
          {enabled ? "Enabled" : "Not enabled"}
        </p>
      </CardBody>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <form onSubmit={submit}>
            <DialogHeader
              title={enabled ? "Disable two-factor authentication" : step === "password" ? "Enable two-factor authentication" : "Scan the QR code"}
              description={step === "scan" ? "Scan with 1Password, Google Authenticator or any TOTP app, then enter the code." : "Confirm your password to continue."}
            />
            <DialogBody>
              {step === "password" ? (
                <Field label="Password">
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus autoComplete="current-password" />
                </Field>
              ) : (
                <>
                  {qr && <img src={qr} alt="Authenticator QR code" className="mx-auto size-[200px] rounded-xl border border-line bg-white p-2" />}
                  <Field label="6-digit code">
                    <Input
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                      required
                      autoFocus
                      inputMode="numeric"
                      maxLength={6}
                      className="text-center font-mono text-lg tracking-[0.4em]"
                    />
                  </Field>
                  <div className="rounded-xl border border-line bg-surface-2 p-3">
                    <p className="mb-2 text-xs font-medium text-fg-2">Backup codes — store them somewhere safe</p>
                    <div className="grid grid-cols-2 gap-1 font-mono text-xs text-muted">
                      {backupCodes.map((c) => (
                        <span key={c}>{c}</span>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
              <Button type="submit" size="sm" variant={enabled ? "danger" : "primary"} loading={pending}>
                {enabled ? "Disable" : step === "password" ? "Continue" : "Verify and enable"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
