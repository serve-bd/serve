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
    postgres: ["psql -U $POSTGRES_USER -d $POSTGRES_DB -c '\\dt'", "pg_isready"],
    mysql: ["mysql -uroot -p$MYSQL_ROOT_PASSWORD -e 'show databases'"],
    mariadb: ["mariadb -uroot -p$MARIADB_ROOT_PASSWORD -e 'show databases'"],
    redis: ["redis-cli --version", "du -sh /data"],
    valkey: ["valkey-cli --version", "du -sh /data"],
    mongodb: ["mongosh --quiet -u $MONGO_INITDB_ROOT_USERNAME -p $MONGO_INITDB_ROOT_PASSWORD --eval 'db.adminCommand({listDatabases:1})'"],
  };
  return (
    <PageBody>
      <Console
        serviceId={service.id}
        suggestions={service.database ? (hints[service.database.engine] ?? []) : ["ls -la", "env | sort", "df -h", "cat /etc/os-release"]}
      />
    </PageBody>
  );
}
