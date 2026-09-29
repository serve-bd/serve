"use client";

import * as React from "react";
import Link from "next/link";
import { MailCheck } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { AuthCard, AuthError } from "../_components/auth-card";

export function ForgotPasswordForm({ emailEnabled }: { emailEnabled: boolean }) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sentTo, setSentTo] = React.useState<string | null>(null);

  if (!emailEnabled) {
    return (
      <AuthCard title="Reset your password" description="This instance cannot send email yet.">
        <div className="flex flex-col gap-4">
          <p className="text-[14px] leading-relaxed text-muted">Ask an admin of the Root organization for a reset link. They can create one on the Members page.</p>
          <Link href="/login" className={buttonVariants({ size: "lg", className: "w-full" })}>
            Back to sign in
          </Link>
        </div>
      </AuthCard>
    );
  }

  if (sentTo) {
    return (
      <AuthCard title="Check your email" description={`If ${sentTo} has an account, a reset link is on its way. It expires in 1 hour.`}>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] text-muted">
            <MailCheck className="size-4 flex-none text-ok" />
            Nothing arrived? Check your spam folder, or try again in a few minutes.
          </div>
          <Link href="/login" className={buttonVariants({ size: "lg", className: "w-full" })}>
            Back to sign in
          </Link>
        </div>
      </AuthCard>
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email")).trim();
    setPending(true);
    setError(null);
    const { error } = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setPending(false);
    // The answer is the same whether or not the account exists; only transport or rate limits fail.
    if (error) setError(error.status === 429 ? "Too many requests. Try again in a few minutes." : (error.message ?? "Could not send the email."));
    else setSentTo(email);
  }

  return (
    <AuthCard title="Reset your password" description="Enter your email and we'll send you a link to choose a new password.">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Email">
          <Input name="email" type="email" required autoFocus autoComplete="email" placeholder="you@company.com" className="h-10" />
        </Field>
        <AuthError>{error}</AuthError>
        <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1 w-full">
          Send reset link
        </Button>
        <Link href="/login" className="self-center text-[13px] text-muted transition-colors hover:text-fg">
          Back to sign in
        </Link>
      </form>
    </AuthCard>
  );
}
