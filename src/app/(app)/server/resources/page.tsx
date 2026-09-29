import { hostSummary, listHostContainers } from "./data";
import { ResourcesView } from "./resources-view";

export const metadata = { title: "Resources" };

export default async function ResourcesPage() {
  const [containers, summary] = await Promise.all([listHostContainers(), hostSummary()]);
  return <ResourcesView containers={containers} summary={summary} />;
}
