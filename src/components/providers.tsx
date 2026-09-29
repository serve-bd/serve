"use client";

import * as React from "react";
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

/**
 * Serve never installs a service worker. One left on this address by another app (a PWA once
 * run on the same host and port) serves stale files, so remove it.
 */
function useNoServiceWorker() {
  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.getRegistrations().then(async (regs) => {
      if (!regs.length) return;
      await Promise.all(regs.map((r) => r.unregister()));
      if ("caches" in window) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
      // Fresh files from now on; the page in front of the user may still come from the old worker.
      if (navigator.serviceWorker.controller) window.location.reload();
    });
  }, []);
}

export function Providers({ children, brand }: { children: React.ReactNode; brand: Brand }) {
  useNoServiceWorker();
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
