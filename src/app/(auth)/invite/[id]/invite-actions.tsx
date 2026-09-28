"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
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

  if (signedInAs && signedInAs.toLowerCase() === email.toLowerCase()) {
    return (
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        loading={pending}
        onClick={async () => {
          setPending(true);
          const res = await acceptInvite(invitationId);
          if (!res.ok) {
            setPending(false);
            return toast.error(res.error);
          }
          router.replace("/");
          router.refresh();
        }}
      >
        Accept and join
      </Button>
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
        <Link href={`/login?next=/invite/${invitationId}`} className={buttonVariants({ variant: "primary", size: "lg" })}>
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
        const res = await acceptInviteWithSignup({
          invitationId,
          name: String(form.get("name")),
          password: String(form.get("password")),
        });
        if (!res.ok) {
          setPending(false);
          return toast.error(res.error);
        }
        router.replace("/");
        router.refresh();
      }}
    >
      <Field label="Email">
        <Input value={email} disabled readOnly />
      </Field>
      <Field label="Your name">
        <Input name="name" required autoFocus autoComplete="name" />
      </Field>
      <Field label="Choose a password" description="At least 8 characters.">
        <Input name="password" type="password" required minLength={8} autoComplete="new-password" />
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={pending}>
        Create account and join
      </Button>
    </form>
  );
}
