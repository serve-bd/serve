"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { authClient } from "@/lib/auth-client";
import { AuthCard, AuthError } from "../_components/auth-card";
import { PasswordInput } from "../_components/password-input";

export function ResetPasswordForm({ token, invalid }: { token: string | null; invalid: boolean }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  if (!token || invalid) {
    return (
      <AuthCard title="This link does not work" description="Reset links work once and expire after 1 hour.">
        <Link href="/forgot-password" className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}>
          Get a new link
        </Link>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard title="Password changed" description="You were signed out on every device. Sign in with your new password.">
        <Button variant="primary" size="lg" className="w-full" onClick={() => router.replace("/login")}>
          Sign in
        </Button>
      </AuthCard>
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password"));
    if (password !== String(form.get("confirm"))) return setError("The passwords do not match.");
    if (password.length < 8) return setError("Use at least 8 characters.");
    setPending(true);
    setError(null);
    const { error } = await authClient.resetPassword({ newPassword: password, token: token ?? "" });
    setPending(false);
    if (error) setError(/token/i.test(error.message ?? "") ? "This link expired or was already used. Ask for a new one." : (error.message ?? "Could not change the password."));
    else setDone(true);
  }

  return (
    <AuthCard title="Choose a new password" description="Use at least 8 characters.">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="New password">
          <PasswordInput name="password" required autoFocus autoComplete="new-password" minLength={8} className="h-10" />
        </Field>
        <Field label="Repeat the password">
          <PasswordInput name="confirm" required autoComplete="new-password" minLength={8} className="h-10" />
        </Field>
        <AuthError>{error}</AuthError>
        <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1 w-full">
          Change password
        </Button>
      </form>
    </AuthCard>
  );
}
