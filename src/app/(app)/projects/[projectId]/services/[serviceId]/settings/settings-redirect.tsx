"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/** The hash is never sent to the server, so the redirect to a section happens here. */
export function SettingsRedirect({ base }: { base: string }) {
  const router = useRouter();
  React.useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "").replace(/[^a-z0-9-]/gi, "");
    router.replace(`${base}/${hash || "general"}`);
  }, [base, router]);
  return null;
}
