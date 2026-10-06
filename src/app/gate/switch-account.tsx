"use client";

import { useRouter } from "@/hooks/use-router";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function SwitchAccount() {
  const router = useRouter();
  return (
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
  );
}
