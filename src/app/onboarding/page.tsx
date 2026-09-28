import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { detectPublicIp, systemStatus } from "@/server/system";
import { Logo } from "@/components/brand";
import { OnboardingWizard } from "./wizard";

export const metadata = { title: "Welcome" };

export default async function OnboardingPage() {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) redirect("/");
  const settings = await getSettings();
  const [status, detectedIp, cf, git, projects] = await Promise.all([
    systemStatus(),
    settings.serverIp ? Promise.resolve(settings.serverIp) : detectPublicIp(),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.organizationId, ctx.org.id)),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.gitCredential).where(eq(schema.gitCredential.organizationId, ctx.org.id)),
    db.select({ id: schema.project.id }).from(schema.project).where(eq(schema.project.organizationId, ctx.org.id)).limit(1),
  ]);

  return (
    <div className="relative min-h-screen">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(60%_60%_at_50%_0%,var(--accent-soft),transparent)]" />
      <header className="relative flex h-16 items-center justify-between px-6">
        <Logo />
        <span className="hidden text-[13px] text-muted sm:inline">Signed in as {ctx.user.email}</span>
      </header>
      <main className="relative mx-auto w-full max-w-4xl px-4 pt-6 pb-20">
        <OnboardingWizard
          userName={ctx.user.name}
          initial={{
            instanceName: settings.instanceName,
            serverIp: settings.serverIp ?? detectedIp ?? "",
            wildcardDomain: settings.wildcardDomain ?? "",
            dashboardDomain: settings.dashboardDomain ?? "",
            sslipFallback: settings.sslipFallback,
            acmeEmail: settings.acmeEmail ?? ctx.user.email,
            acmeStaging: settings.acmeStaging,
          }}
          status={{
            docker: status.dockerVersion,
            dockerError: status.dockerError,
            proxyRunning: !!status.proxy?.running,
            nixpacks: status.nixpacks,
            hostname: status.hostname,
            cpus: status.cpus,
            memory: status.memory,
            platform: status.platform,
          }}
          counts={{ cloudflare: cf[0].n, git: git[0].n, hasProject: projects.length > 0 }}
        />
      </main>
    </div>
  );
}
