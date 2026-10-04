"use client";

import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/hooks/use-action";
import { makeDefaultServer } from "@/server/actions/servers";

/** Makes this server the organization's default; the Default badge in the title shows the result. */
export function MakeDefaultButton({ serverId }: { serverId: string }) {
  const make = useAction(makeDefaultServer);
  return (
    <Button size="sm" variant="secondary" loading={make.pending} onClick={() => void make.run(serverId)}>
      <Star /> Make default
    </Button>
  );
}
