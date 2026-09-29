"use client";

import type * as React from "react";
import { SWRConfig } from "swr";
import { ProgressProvider } from "@bprogress/next/app";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmProvider } from "@/components/ui/confirm";
import { BrandProvider } from "@/components/brand";
import type { Brand } from "@/server/branding";

async function fetcher(url: string) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export function Providers({ children, brand }: { children: React.ReactNode; brand: Brand }) {
  return (
    // Same storage key as before, so saved choices carry over.
    <ThemeProvider attribute="data-theme" storageKey="serve-theme" defaultTheme="system" enableSystem disableTransitionOnChange>
      <ProgressProvider color="var(--accent)" height="2px" options={{ showSpinner: false }} shallowRouting delay={120}>
        <SWRConfig value={{ fetcher, revalidateOnFocus: true, dedupingInterval: 1000, keepPreviousData: true }}>
          <TooltipProvider delay={300}>
            <Toaster>
              <ConfirmProvider>
                <BrandProvider brand={brand}>{children}</BrandProvider>
              </ConfirmProvider>
            </Toaster>
          </TooltipProvider>
        </SWRConfig>
      </ProgressProvider>
    </ThemeProvider>
  );
}
