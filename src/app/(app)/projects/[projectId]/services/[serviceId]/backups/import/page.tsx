import { backupsPage } from "../backups-page";

export const metadata = { title: "Import backup" };

export default function ImportBackupPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/backups/import">) {
  return backupsPage(props.params, "import");
}
