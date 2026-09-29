import { requireOrg } from "@/server/auth";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { Console } from "./console";

export const metadata = { title: "Console" };

export default async function ConsolePage(props: PageProps<"/projects/[projectId]/services/[serviceId]/console">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  const hints: Record<string, string[]> = {
    postgres: ["psql", "psql -c '\\dt'", "pg_isready"],
    mysql: ["mysql -uroot", "mysql -uroot -e 'show databases'"],
    mariadb: ["mariadb -uroot", "mariadb -uroot -e 'show databases'"],
    redis: ["redis-cli", "redis-cli info memory"],
    valkey: ["valkey-cli", "valkey-cli info memory"],
    mongodb: ["mongosh -u $MONGO_INITDB_ROOT_USERNAME -p $MONGO_INITDB_ROOT_PASSWORD"],
    clickhouse: ["clickhouse-client"],
  };
  return (
    <PageBody>
      <Console
        serviceId={service.id}
        suggestions={service.database ? (hints[service.database.engine] ?? []) : ["ls -la", "env | sort", "df -h", "top"]}
      />
    </PageBody>
  );
}
