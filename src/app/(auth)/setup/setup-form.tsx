"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/misc";
import { toast } from "@/components/ui/toast";
import { setupInstance } from "@/server/actions/auth";

export function SetupForm() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    const res = await setupInstance({
      name: String(form.get("name")),
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    if (!res.ok) {
      setPending(false);
      toast.error(res.error);
      return;
    }
    router.replace("/onboarding");
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Your name">
          <Input name="name" required autoFocus autoComplete="name" placeholder="Ada Lovelace" />
        </Field>
        <Field label="Email">
          <Input name="email" type="email" required autoComplete="email" placeholder="you@company.com" />
        </Field>
        <Field label="Password" description="At least 8 characters.">
          <Input name="password" type="password" required minLength={8} autoComplete="new-password" />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1">
          Create owner account
        </Button>
      </form>
    </Card>
  );
}
