import { redirect } from "next/navigation";
import { desc, eq, isNull } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { env } from "@/server/env";
import { tunnelPort } from "@/server/tunnel";
import { ownerFor } from "@/server/servers/access";
import { detectPublicIp, systemStatus } from "@/server/system";
import { Logo } from "@/components/brand";
import { OnboardingWizard } from "./wizard";

export const metadata = { title: "Welcome" };

export default async function OnboardingPage() {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) redirect("/");
  const settings = await getSettings();
  // Keys another server can use belong to the same owner as the servers added here (see /servers/new).
  const owner = ownerFor(ctx);
  const [status, detectedIp, projects, keys, [local]] = await Promise.all([
    systemStatus(),
    settings.serverIp ? Promise.resolve(settings.serverIp) : detectPublicIp(),
    db.select({ id: schema.project.id }).from(schema.project).where(eq(schema.project.organizationId, ctx.org.id)).limit(1),
    db
      .select({ id: schema.privateKey.id, name: schema.privateKey.name, publicKey: schema.privateKey.publicKey, fingerprint: schema.privateKey.fingerprint })
      .from(schema.privateKey)
      .where(owner ? eq(schema.privateKey.organizationId, owner) : isNull(schema.privateKey.organizationId))
      .orderBy(desc(schema.privateKey.createdAt)),
    db.select({ publicIp: schema.server.publicIp }).from(schema.server).where(eq(schema.server.isLocal, true)),
  ]);
  // Where a server without a public IP connects to: never a loopback address.
  const fromUrl = new URL(env.appUrl).hostname;
  const tunnel = { address: local?.publicIp ?? (/^(localhost|127\.|0\.0\.0\.0$|\[?::1\]?$)/.test(fromUrl) ? "" : fromUrl), port: tunnelPort() };

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
          initial={{ instanceName: settings.instanceName, serverIp: settings.serverIp ?? detectedIp ?? "" }}
          keys={keys}
          tunnel={tunnel}
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
          hasProject={projects.length > 0}
        />
      </main>
    </div>
  );
}
