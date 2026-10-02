import { notFound } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { listDatabaseUsers } from "@/server/actions/database-users";
import { usersSupported } from "@/server/databases/users";
import { PageBody } from "@/components/shell/page-header";
import { UsersView } from "./users-view";

export const metadata = { title: "Users" };

export default async function UsersPage(props: { params: Promise<{ projectId: string; serviceId: string }> }) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  if (service.type !== "database" || !usersSupported(service.database) || service.parentServiceId) notFound();
  const running = service.status === "running";
  // The logins live inside the database: they are read from it on every visit.
  const res = running ? await listDatabaseUsers(service.id) : null;
  return (
    <PageBody>
      <UsersView
        serviceId={service.id}
        serviceName={service.name}
        engine={service.database!.engine}
        running={running}
        error={res && !res.ok ? res.error : null}
        users={res?.ok ? res.data.users : []}
        databases={res?.ok ? res.data.databases : []}
        mainDatabase={service.database!.database}
        canManage={ctx.can("services.manage")}
        canSecrets={ctx.can("variables.view-secrets")}
      />
    </PageBody>
  );
}
