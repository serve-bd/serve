import { instanceAdminPage } from "@/server/auth";
import { inArray, or, sql } from "drizzle-orm";
import { pickPrimaryDomain } from "@/lib/domains";
import { db, schema } from "@/server/db";
import { getSetting } from "@/server/settings";
import { EmailSettingsForm } from "./email-settings";

export const metadata = { title: "Email" };

/** Mailroom instances deployed with Serve, by the address of their primary domain. */
async function mailroomServices() {
  const rows = await db
    .select({ id: schema.service.id, name: schema.service.name, projectName: schema.project.name })
    .from(schema.service)
    .innerJoin(schema.project, sql`${schema.project.id} = ${schema.service.projectId}`)
    .where(or(sql`${schema.service.compose}->>'content' ilike '%/mailroom%'`, sql`${schema.service.source}->>'image' ilike '%/mailroom%'`));
  if (!rows.length) return [];
  const domains = await db
    .select()
    .from(schema.domain)
    .where(
      inArray(
        schema.domain.serviceId,
        rows.map((r) => r.id),
      ),
    );
  return rows.map((r) => {
    const d = pickPrimaryDomain(domains.filter((x) => x.serviceId === r.id));
    return { id: r.id, label: `${r.name} · ${r.projectName}`, url: d ? `${d.https || d.tunnelId ? "https" : "http"}://${d.hostname}` : null };
  });
}

export default async function EmailSettingsPage() {
  await instanceAdminPage();
  const [email, mailrooms] = await Promise.all([getSetting("email"), mailroomServices()]);
  return (
    <EmailSettingsForm
      mailrooms={mailrooms}
      initial={
        email
          ? {
              provider: email.provider,
              fromName: email.fromName,
              fromAddress: email.fromAddress,
              smtpHost: email.smtp?.host ?? "",
              smtpPort: email.smtp?.port ?? 587,
              smtpSecurity: email.smtp?.security ?? "starttls",
              smtpUsername: email.smtp?.username ?? "",
              hasPassword: !!email.smtp?.password,
              hasApiKey: !!email.apiKey,
              baseUrl: email.baseUrl ?? "",
            }
          : null
      }
    />
  );
}
