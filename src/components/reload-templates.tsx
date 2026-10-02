"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { reloadTemplateCatalog } from "@/server/actions/templates";

/** Fetches the newest built-in templates from GitHub and shows them. */
export function ReloadTemplates({ className }: { className?: string }) {
  const { run, pending } = useAction(reloadTemplateCatalog, { result: (d) => `Template list updated: ${d.count} templates` });
  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      className={cn("flex-none", className)}
      onClick={() => void run()}
      disabled={pending}
      title="Load the newest templates"
      aria-label="Load the newest templates"
    >
      <RefreshCw className={cn(pending && "animate-spin")} />
    </Button>
  );
}
