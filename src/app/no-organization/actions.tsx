"use client";

import * as React from "react";
import { useRouter } from "@/hooks/use-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { createOrg } from "@/server/actions/org";
import { authClient } from "@/lib/auth-client";

export function NoOrgActions() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [pending, setPending] = React.useState(false);
  return (
    <div className="flex w-full max-w-sm flex-col gap-3">
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          const res = await createOrg(name);
          setPending(false);
          if (!res.ok) return toast.error(res.error);
          router.replace("/");
          router.refresh();
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Organization name" required />
        <Button type="submit" variant="primary" loading={pending}>
          Create
        </Button>
      </form>
      <Button
        variant="ghost"
        onClick={async () => {
          await authClient.signOut();
          router.replace("/login");
        }}
      >
        Sign out
      </Button>
    </div>
  );
}
