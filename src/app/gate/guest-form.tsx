"use client";

import * as React from "react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { AuthError } from "../(auth)/_components/auth-card";
import { PasswordInput } from "../(auth)/_components/password-input";
import { guestSignIn } from "./actions";

export function GuestForm({ s, h, p, teamHref }: { s: string; h: string; p: string /** The team gets in too: sign in with Serve instead. */; teamHref: string | null }) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <form
      method="post"
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setPending(true);
        setError(null);
        const res = await guestSignIn({ s, h, p, email: String(f.get("email")), password: String(f.get("password")) });
        if ("url" in res) return window.location.assign(res.url);
        setPending(false);
        setError(res.error);
      }}
    >
      <Field label="Email">
        <Input name="email" type="email" required autoFocus autoComplete="email" placeholder="you@company.com" className="h-10" />
      </Field>
      <Field label="Password">
        <PasswordInput name="password" required autoComplete="current-password" className="h-10" />
      </Field>
      <AuthError>{error}</AuthError>
      <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1 w-full">
        Sign in
      </Button>
      {teamHref && (
        <Link href={teamHref} className={buttonVariants({ size: "lg", className: "w-full" })}>
          Team member? Sign in with your account
        </Link>
      )}
    </form>
  );
}
