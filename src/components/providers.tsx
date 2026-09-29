"use client";

import type * as React from "react";
import { SWRConfig } from "swr";
import { ProgressProvider } from "@bprogress/next/app";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmProvider } from "@/components/ui/confirm";

async function fetcher(url: string) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    // Same storage key as before, so saved choices carry over.
    <ThemeProvider attribute="data-theme" storageKey="serve-theme" defaultTheme="system" enableSystem disableTransitionOnChange>
      <ProgressProvider color="var(--accent)" height="2px" options={{ showSpinner: false }} shallowRouting delay={120}>
        <SWRConfig value={{ fetcher, revalidateOnFocus: true, dedupingInterval: 1000, keepPreviousData: true }}>
          <TooltipProvider delay={300}>
            <Toaster>
              <ConfirmProvider>{children}</ConfirmProvider>
            </Toaster>
          </TooltipProvider>
        </SWRConfig>
      </ProgressProvider>
    </ThemeProvider>
  );
}
