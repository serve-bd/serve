import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { AppShell } from "@/components/shell/app-shell";
import { SCHEMA_VERSION } from "@/server/version";

function workerOnline(heartbeat: string | null) {
  return !!heartbeat && Date.now() - new Date(heartbeat).getTime() < 60_000;
}

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const ctx = await requireOrg();
  const settings = await getSettings();
  if (!settings.onboardingDone && ctx.isInstanceAdmin) redirect("/onboarding");

  const [orgs, projects] = await Promise.all([
    db
      .select({ id: schema.organization.id, name: schema.organization.name, logo: schema.organization.logo, role: schema.member.role })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
      .where(eq(schema.member.userId, ctx.user.id))
      .orderBy(asc(schema.organization.createdAt)),
    db
      .select({ id: schema.project.id, name: schema.project.name, color: schema.project.color })
      .from(schema.project)
      .where(eq(schema.project.organizationId, ctx.org.id))
      .orderBy(asc(schema.project.name)),
  ]);

  return (
    <AppShell
      user={{ id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, image: ctx.user.image ?? null }}
      org={{ id: ctx.org.id, name: ctx.org.name, logo: ctx.org.logo, role: ctx.role, isRoot: ctx.isRoot }}
      orgs={orgs.map((o) => ({ ...o, isRoot: o.id === settings.rootOrganizationId }))}
      projects={projects}
      isInstanceAdmin={ctx.isInstanceAdmin}
      canCreateOrg={ctx.isInstanceAdmin || settings.allowOrganizationCreation}
      instanceName={settings.instanceName}
      workerOnline={workerOnline(settings.workerHeartbeat)}
      workerOutdated={workerOnline(settings.workerHeartbeat) && settings.workerSchemaVersion !== SCHEMA_VERSION}
    >
      {children}
    </AppShell>
  );
}
