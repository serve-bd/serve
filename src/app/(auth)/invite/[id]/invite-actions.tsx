"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { AuthError } from "../../_components/auth-card";
import { PasswordInput } from "../../_components/password-input";
import { acceptInvite, acceptInviteWithSignup } from "@/server/actions/auth";
import { authClient } from "@/lib/auth-client";

export function InviteActions({
  invitationId,
  email,
  signedInAs,
  hasAccount,
}: {
  invitationId: string;
  email: string;
  signedInAs: string | null;
  hasAccount: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (signedInAs && signedInAs.toLowerCase() === email.toLowerCase()) {
    return (
      <div className="flex flex-col gap-4">
        <AuthError>{error}</AuthError>
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          loading={pending}
          onClick={async () => {
            setPending(true);
            setError(null);
            const res = await acceptInvite(invitationId);
            if (!res.ok) {
              setPending(false);
              return setError(res.error);
            }
            router.replace("/");
            router.refresh();
          }}
        >
          Accept and join
        </Button>
      </div>
    );
  }

  if (signedInAs) {
    return (
      <div className="flex flex-col gap-3 text-[13px] text-muted">
        <p>
          You are signed in as <span className="text-fg-2">{signedInAs}</span>. This invite is for{" "}
          <span className="text-fg-2">{email}</span>.
        </p>
        <Button
          size="lg"
          className="w-full"
          onClick={async () => {
            await authClient.signOut();
            router.refresh();
          }}
        >
          Sign out and switch account
        </Button>
      </div>
    );
  }

  if (hasAccount) {
    return (
      <div className="flex flex-col gap-3 text-[13px] text-muted">
        <p>You already have an account with this email. Sign in to accept the invite.</p>
        <Link href={`/login?next=/invite/${invitationId}`} className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}>
          Sign in to accept
        </Link>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        setPending(true);
        setError(null);
        const res = await acceptInviteWithSignup({
          invitationId,
          name: String(form.get("name")),
          password: String(form.get("password")),
        });
        if (!res.ok) {
          setPending(false);
          return setError(res.error);
        }
        router.replace("/");
        router.refresh();
      }}
    >
      <Field label="Email">
        <Input value={email} disabled readOnly className="h-10" />
      </Field>
      <Field label="Your name">
        <Input name="name" required autoFocus autoComplete="name" className="h-10" />
      </Field>
      <Field label="Choose a password" description="At least 8 characters.">
        <PasswordInput name="password" required minLength={8} autoComplete="new-password" className="h-10" />
      </Field>
      <AuthError>{error}</AuthError>
      <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1 w-full">
        Create account and join
      </Button>
    </form>
  );
}
