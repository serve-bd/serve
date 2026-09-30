import { instanceAdminPage } from "@/server/auth";
import { getSettings } from "@/server/settings";
import { GeneralSettings } from "./general-settings";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  await instanceAdminPage();
  const settings = await getSettings();
  return <GeneralSettings initial={{ timezone: settings.timezone }} />;
}
