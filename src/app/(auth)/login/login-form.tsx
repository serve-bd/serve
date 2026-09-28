"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/misc";
import { authClient } from "@/lib/auth-client";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [needsCode, setNeedsCode] = React.useState(false);
  const [useBackup, setUseBackup] = React.useState(false);

  async function verify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code")).trim();
    setPending(true);
    setError(null);
    const { error } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice: true })
      : await authClient.twoFactor.verifyTotp({ code, trustDevice: true });
    if (error) {
      setPending(false);
      setError(error.message ?? "That code is not valid.");
      return;
    }
    router.replace(next);
    router.refresh();
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const { data, error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
      rememberMe: true,
    });
    if (!error && data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
      setPending(false);
      setNeedsCode(true);
      return;
    }
    if (error) {
      setPending(false);
      setError(error.status === 401 || error.code === "INVALID_EMAIL_OR_PASSWORD" ? "Wrong email or password." : error.message ?? "Could not sign in.");
      return;
    }
    router.replace(next);
    router.refresh();
  }

  if (needsCode) {
    return (
      <Card className="p-5">
        <form onSubmit={verify} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-[15px] font-semibold text-fg">Two-factor authentication</p>
            <p className="text-[13px] text-muted">{useBackup ? "Enter one of your backup codes." : "Enter the 6-digit code from your authenticator app."}</p>
          </div>
          <Field label={useBackup ? "Backup code" : "Code"}>
            <Input
              key={useBackup ? "backup" : "totp"}
              name="code"
              required
              autoFocus
              autoComplete="one-time-code"
              inputMode={useBackup ? "text" : "numeric"}
              maxLength={useBackup ? 32 : 6}
              className="text-center font-mono text-lg tracking-[0.4em]"
            />
          </Field>
          {error && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}
          <Button type="submit" variant="primary" size="lg" loading={pending}>
            Verify
          </Button>
          <button type="button" onClick={() => { setUseBackup((b) => !b); setError(null); }} className="text-[13px] text-accent hover:underline">
            {useBackup ? "Use authenticator app" : "Use a backup code"}
          </button>
        </form>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Email">
          <Input name="email" type="email" required autoFocus autoComplete="email" placeholder="you@company.com" />
        </Field>
        <Field label="Password">
          <Input name="password" type="password" required autoComplete="current-password" />
        </Field>
        {error && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}
        <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1">
          Sign in
        </Button>
      </form>
    </Card>
  );
}
