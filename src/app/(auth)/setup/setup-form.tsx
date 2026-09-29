"use client";

import * as React from "react";
import { useRouter } from "@/hooks/use-router";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { AuthCard, AuthError } from "../_components/auth-card";
import { PasswordInput } from "../_components/password-input";
import { setupInstance } from "@/server/actions/auth";

export function SetupForm() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const res = await setupInstance({
      name: String(form.get("name")),
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    if (!res.ok) {
      setPending(false);
      setError(res.error);
      return;
    }
    router.replace("/onboarding");
  }

  return (
    <AuthCard
      title="Create the owner account"
      description={
        <>
          You will own the <span className="font-medium text-fg-2">Root</span> organization, which manages this server.
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Name">
          <Input name="name" required autoFocus autoComplete="name" placeholder="Ada Lovelace" className="h-10" />
        </Field>
        <Field label="Email">
          <Input name="email" type="email" required autoComplete="email" placeholder="you@company.com" className="h-10" />
        </Field>
        <Field label="Password" description="At least 8 characters.">
          <PasswordInput name="password" required minLength={8} autoComplete="new-password" className="h-10" />
        </Field>
        <AuthError>{error}</AuthError>
        <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1 w-full">
          Create account
        </Button>
      </form>
    </AuthCard>
  );
}
