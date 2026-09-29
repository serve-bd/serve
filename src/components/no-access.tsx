import { LockKeyhole } from "lucide-react";
import { PageBody } from "@/components/shell/page-header";
import { Card, EmptyState } from "@/components/ui/misc";
import { cannotMessage, type Permission } from "@/lib/permissions";

/** Shown instead of a page the member's role does not allow. */
export function NoAccess({ permission, bare }: { permission: Permission; bare?: boolean }) {
  const card = (
    <Card>
      <EmptyState icon={<LockKeyhole />} title={cannotMessage(permission)} description="Ask an admin of this organization to change your role." />
    </Card>
  );
  return bare ? card : <PageBody>{card}</PageBody>;
}
