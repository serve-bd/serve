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
import { ssoErrorMessage } from "@/lib/sso-errors";
import { SsoMark } from "@/components/sso-mark";
import { Fingerprint } from "lucide-react";

type Provider = { id: string; label: string };

export function LoginForm({
  next,
  canReset = false,
  password = true,
  providers = [],
  ssoError = null,
}: {
  next: string;
  canReset?: boolean;
  password?: boolean;
  providers?: Provider[];
  ssoError?: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  // A provider sign-in of a user with two-factor authentication comes back here for the code.
  const codeAfterSso = ssoError === "two_factor_required";
  const [error, setError] = React.useState<string | null>(ssoError && !codeAfterSso ? ssoErrorMessage(ssoError) : null);
  const [redirecting, setRedirecting] = React.useState<string | null>(null);
  const loginUrl = next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;

  async function withProvider(id: string) {
    setRedirecting(id);
    setError(null);
    const opts = { callbackURL: next, errorCallbackURL: loginUrl, newUserCallbackURL: next };
    // The company login (OpenID Connect) is registered as provider "oidc" next to GitHub and Google.
    const { error } = await authClient.signIn.social({ provider: id as "github", ...opts });
    if (error) {
      setRedirecting(null);
      setError(error.message ?? "Could not start the sign-in.");
    }
  }
  const [needsCode, setNeedsCode] = React.useState(codeAfterSso);
  const [passkeyPending, setPasskeyPending] = React.useState(false);
  const [passkeys, setPasskeys] = React.useState(false);

  // Passkeys need a secure page in a browser that has them. Where the browser offers saved passkeys
  // in the email field's suggestions, picking one there signs in right away.
  React.useEffect(() => {
    if (!password || !window.isSecureContext || typeof window.PublicKeyCredential === "undefined") return;
    setPasskeys(true);
    let gone = false;
    void PublicKeyCredential.isConditionalMediationAvailable?.().then(async (ok) => {
      if (!ok || gone) return;
      const { data, error } = await authClient.signIn.passkey({ autoFill: true });
      if (!gone && !error && data) {
        router.replace(next);
        router.refresh();
      }
    });
    return () => {
      gone = true;
    };
  }, [password, next, router]);

  async function withPasskey() {
    setPasskeyPending(true);
    setError(null);
    const { data, error } = await authClient.signIn.passkey();
    if (error || !data) {
      setPasskeyPending(false);
      // Closing the browser's prompt is not an error worth showing.
      if (error && !/cancel|abort|not allowed/i.test(error.message ?? "")) setError(error.message ?? "Could not sign in with a passkey.");
      return;
    }
    router.replace(next);
    router.refresh();
  }
  const [useBackup, setUseBackup] = React.useState(false);

  /** Leaves the code step for the sign-in choices (and drops `?error=` from the address). */
  function backToStart(message: string | null = null) {
    setNeedsCode(false);
    setUseBackup(false);
    setPending(false);
    setError(message);
    if (codeAfterSso) router.replace(loginUrl);
  }

  async function verify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code")).trim();
    setPending(true);
    setError(null);
    const { error } = useBackup ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice: true }) : await authClient.twoFactor.verifyTotp({ code, trustDevice: true });
    // The pending sign-in is gone (it lasts 10 minutes, or too many codes were tried): start over.
    if (error?.code === "INVALID_TWO_FACTOR_COOKIE" || error?.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE") {
      backToStart("Your sign-in expired. Sign in again.");
      return;
    }
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
        <form method="post" onSubmit={verify} className="flex flex-col gap-4">
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
          <button type="button" onClick={() => backToStart()} className="text-[13px] text-muted transition-colors hover:text-fg">
            Back to sign in
          </button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard greeting title="Welcome back" description="Sign in to manage your deployments.">
      {!password && providers.length === 0 && (
        <p className="text-[13px] leading-relaxed text-muted">No sign-in method is available. An admin can allow password sign-in again with SERVE_ALLOW_PASSWORD_LOGIN=1.</p>
      )}
      {password && (
        <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="Email">
            <Input name="email" type="email" required autoFocus autoComplete="email webauthn" placeholder="you@company.com" className="h-10" />
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
          {passkeys && (
            <Button type="button" size="lg" className="w-full" loading={passkeyPending} disabled={pending} onClick={() => void withPasskey()}>
              <Fingerprint /> Sign in with a passkey
            </Button>
          )}
        </form>
      )}
      {providers.length > 0 && password && (
        <div className="my-5 flex items-center gap-3 text-xs text-faint">
          <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
        </div>
      )}
      {providers.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {providers.map((p) => (
            <Button
              key={p.id}
              type="button"
              size="lg"
              className="w-full"
              loading={redirecting === p.id}
              disabled={!!redirecting && redirecting !== p.id}
              onClick={() => void withProvider(p.id)}
            >
              <SsoMark provider={p.id} /> {p.label}
            </Button>
          ))}
          {!password && <AuthError>{error}</AuthError>}
        </div>
      )}
    </AuthCard>
  );
}
