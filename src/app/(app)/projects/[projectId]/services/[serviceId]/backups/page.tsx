import { backupsPage } from "./backups-page";

export const metadata = { title: "Backups" };

export default function BackupsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/backups">) {
  return backupsPage(props.params, "list");
}
