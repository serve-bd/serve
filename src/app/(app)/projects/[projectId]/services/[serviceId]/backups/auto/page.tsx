import { backupsPage } from "../backups-page";

export const metadata = { title: "Auto backup" };

export default function AutoBackupPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/backups/auto">) {
  return backupsPage(props.params, "auto");
}
