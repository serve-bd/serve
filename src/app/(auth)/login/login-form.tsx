"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { AuthCard, AuthError } from "../_components/auth-card";
import { PasswordInput } from "../_components/password-input";
import { authClient } from "@/lib/auth-client";

export function LoginForm({ next, canReset = false }: { next: string; canReset?: boolean }) {
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
    const { error } = useBackup ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice: true }) : await authClient.twoFactor.verifyTotp({ code, trustDevice: true });
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
      setError(error.status === 401 || error.code === "INVALID_EMAIL_OR_PASSWORD" ? "Wrong email or password." : (error.message ?? "Could not sign in."));
      return;
    }
    router.replace(next);
    router.refresh();
  }

  if (needsCode) {
    return (
      <AuthCard title="Two-factor authentication" description={useBackup ? "Enter one of your backup codes." : "Enter the 6-digit code from your authenticator app."}>
        <form onSubmit={verify} className="flex flex-col gap-4">
          <Field label={useBackup ? "Backup code" : "Code"}>
            <Input
              key={useBackup ? "backup" : "totp"}
              name="code"
              required
              autoFocus
              autoComplete="one-time-code"
              inputMode={useBackup ? "text" : "numeric"}
              maxLength={useBackup ? 32 : 6}
              className="h-11 text-center font-mono text-lg tracking-[0.4em]"
            />
          </Field>
          <AuthError>{error}</AuthError>
          <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
            Verify
          </Button>
          <button
            type="button"
            onClick={() => {
              setUseBackup((b) => !b);
              setError(null);
            }}
            className="text-[13px] text-muted transition-colors hover:text-fg"
          >
            {useBackup ? "Use authenticator app" : "Use a backup code"}
          </button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Welcome back" description="Sign in to manage your deployments.">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Email">
          <Input name="email" type="email" required autoFocus autoComplete="email" placeholder="you@company.com" className="h-10" />
        </Field>
        <Field label="Password">
          <PasswordInput name="password" required autoComplete="current-password" className="h-10" />
        </Field>
        {canReset && (
          <Link href="/forgot-password" className="-mt-1 self-end text-[13px] text-muted transition-colors hover:text-accent">
            Forgot password?
          </Link>
        )}
        <AuthError>{error}</AuthError>
        <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1 w-full">
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}
