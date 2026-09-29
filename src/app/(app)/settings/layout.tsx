import { redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { getSettings } from "@/server/settings";
import { securityChecks } from "@/server/security-checks";
import { PageHeader } from "@/components/shell/page-header";
import { SectionNav } from "@/components/shell/section-nav";
import { ProductName } from "@/components/brand";

export default async function SettingsLayout({ children }: LayoutProps<"/settings">) {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) redirect("/");
  const settings = await getSettings();
  const security = (await securityChecks(settings)).some((c) => c.status === "warn");

  return (
    <>
      <PageHeader
        title="Settings"
        description={
          <>
            Settings for this <ProductName /> instance, shared by every organization and server.
          </>
        }
      />
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 pt-4 pb-16 sm:px-8 lg:flex-row lg:gap-10 lg:pt-6">
        <SectionNav
          groups={[
            {
              title: "Instance",
              items: [
                { href: "/settings", label: "General", icon: "Settings2", exact: true },
                { href: "/settings/branding", label: "Branding", icon: "Palette" },
                { href: "/settings/organizations", label: "Organizations", icon: "Building2" },
                { href: "/settings/dashboard", label: "Dashboard & TLS", icon: "Globe" },
                { href: "/settings/email", label: "Email", icon: "Mail" },
                { href: "/settings/sign-in", label: "Sign-in", icon: "KeyRound" },
                { href: "/settings/advanced", label: "Advanced", icon: "SlidersHorizontal" },
                { href: "/settings/backups", label: "Backups", icon: "HardDriveDownload" },
                { href: "/settings/updates", label: "Updates", icon: "Download" },
              ],
            },
            {
              title: "Security",
              items: [{ href: "/settings/security", label: "Security", icon: "ShieldCheck", warn: security }],
            },
          ]}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
      </div>
    </>
  );
}
