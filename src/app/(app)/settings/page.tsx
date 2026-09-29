import { getSettings } from "@/server/settings";
import { GeneralSettings } from "./general-settings";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const settings = await getSettings();
  return <GeneralSettings initial={{ timezone: settings.timezone }} />;
}
