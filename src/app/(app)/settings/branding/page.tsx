import { instanceAdminPage } from "@/server/auth";
import { getSettings } from "@/server/settings";
import { brandFromConfig } from "@/server/branding";
import { BrandingSettings } from "./branding-settings";

export const metadata = { title: "Branding" };

export default async function BrandingPage() {
  await instanceAdminPage();
  const settings = await getSettings();
  const config = settings.branding;
  return (
    <BrandingSettings
      initial={{ name: settings.instanceName, showName: config?.showName ?? true, accent: config?.accent ?? "" }}
      brand={brandFromConfig(settings.instanceName, config)}
      has={{ logo: !!config?.logo, logoDark: !!config?.logoDark, favicon: !!config?.favicon }}
    />
  );
}
