import Link from "next/link";
import { SearchX } from "lucide-react";
import { PageBody } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/misc";

/** Missing pages, and projects or services the member's access does not include. */
export default function NotFound() {
  return (
    <PageBody>
      <Card>
        <EmptyState
          icon={<SearchX />}
          title="Nothing here"
          description="This page does not exist, or it belongs to a project you do not have access to. Ask an admin if you need it."
          action={
            <Link href="/projects" className={buttonVariants({ size: "sm" })}>
              Go to projects
            </Link>
          }
        />
      </Card>
    </PageBody>
  );
}
