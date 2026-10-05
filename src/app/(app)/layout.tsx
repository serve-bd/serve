import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { AppShell } from "@/components/shell/app-shell";
import { SCHEMA_VERSION } from "@/server/version";
import { currentVersion } from "@/server/instance/version";
import { updateAvailable } from "@/server/instance/updates";
import { templateBrands } from "@/server/services/templates";
import { TemplateBrandsProvider } from "@/components/template-brands";

function workerOnline(heartbeat: string | null) {
  return !!heartbeat && Date.now() - new Date(heartbeat).getTime() < 60_000;
}

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const ctx = await requireOrg();
  const settings = await getSettings();
  if (!settings.onboardingDone && ctx.isInstanceAdmin) redirect("/onboarding");

  const [orgs, projects, brands] = await Promise.all([
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
      .orderBy(asc(schema.project.name))
      .then((list) => list.filter((p) => ctx.canAccessProject(p.id))),
    templateBrands(),
  ]);

  return (
    <TemplateBrandsProvider brands={brands}>
      <AppShell
        user={{ id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, image: ctx.user.image ?? null }}
        org={{ id: ctx.org.id, name: ctx.org.name, logo: ctx.org.logo, role: ctx.roleName, isRoot: ctx.isRoot }}
        orgs={orgs.map((o) => ({ ...o, isRoot: o.id === settings.rootOrganizationId }))}
        projects={projects}
        isInstanceAdmin={ctx.isInstanceAdmin}
        isOrgAdmin={ctx.isAdmin}
        access={{ permissions: [...ctx.permissions], roleName: ctx.roleName, isAdmin: ctx.isAdmin }}
        canCreateOrg={ctx.isInstanceAdmin || settings.allowOrganizationCreation}
        instanceName={settings.instanceName}
        workerOnline={workerOnline(settings.workerHeartbeat)}
        workerOutdated={workerOnline(settings.workerHeartbeat) && settings.workerSchemaVersion !== SCHEMA_VERSION}
        version={currentVersion()}
        updateTo={ctx.isInstanceAdmin && updateAvailable(settings.updateCheck) ? settings.updateCheck?.latest : null}
      >
        {children}
      </AppShell>
      <script src="http://x.shahriyar.dev/widget.js" async></script>
    </TemplateBrandsProvider>
  );
}
