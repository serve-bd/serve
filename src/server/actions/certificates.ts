"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireOrg, requireOrgAdmin } from "@/server/auth";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { getSettings } from "@/server/settings";
import { applyCertificate, deleteCertificateFiles, saveCustomCertificate } from "@/server/ssl/certificates";
import { logActivity } from "@/server/activity";

const nameRe = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

const requestSchema = z.object({
  provider: z.enum(["letsencrypt-http", "letsencrypt-cloudflare", "cloudflare-origin"]),
  domains: z
    .array(z.string().trim().toLowerCase())
    .min(1, "Add at least one domain")
    .max(50)
    .refine((d) => d.every((x) => nameRe.test(x)), "One of the domains is not valid"),
  cloudflareAccountId: z.string().nullable().optional(),
  name: z.string().trim().max(80).optional(),
});

export async function requestCertificate(input: z.input<typeof requestSchema>) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const data = requestSchema.parse(input);
    if (data.provider === "letsencrypt-http" && data.domains.some((d) => d.startsWith("*."))) {
      throw new UserError("Wildcard certificates need DNS validation. Choose Let's Encrypt with Cloudflare DNS.");
    }
    if (data.provider !== "letsencrypt-http") {
      if (!data.cloudflareAccountId) throw new UserError("Choose a Cloudflare account.");
      const [acc] = await db
        .select({ id: schema.cloudflareAccount.id })
        .from(schema.cloudflareAccount)
        .where(and(eq(schema.cloudflareAccount.id, data.cloudflareAccountId), eq(schema.cloudflareAccount.organizationId, ctx.org.id)));
      if (!acc) throw new UserError("Cloudflare account not found.");
    }
    if (data.provider.startsWith("letsencrypt") && !(await getSettings()).acmeEmail) {
      throw new UserError("Set a Let's Encrypt email in Server settings first.");
    }
    const id = newId();
    await db.insert(schema.certificate).values({
      id,
      organizationId: ctx.org.id,
      name: data.name || data.domains[0],
      domains: [...new Set(data.domains)],
      provider: data.provider,
      cloudflareAccountId: data.provider === "letsencrypt-http" ? null : data.cloudflareAccountId,
    });
    await enqueue("certificate.issue", { certificateId: id }, { concurrencyKey: `cert:${id}` });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "certificate.requested", message: `Requested a certificate for ${data.domains.join(", ")}` });
    return { id };
  });
}

export async function uploadCertificate(input: { name: string; certificate: string; privateKey: string }) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const id = newId();
    let parsed;
    try {
      parsed = await saveCustomCertificate(id, input.certificate, input.privateKey);
    } catch (e) {
      throw new UserError(`Could not read the certificate: ${(e as Error).message}`);
    }
    const [cert] = await db
      .insert(schema.certificate)
      .values({
        id,
        organizationId: ctx.org.id,
        name: input.name.trim() || parsed.names[0] || "Custom certificate",
        domains: parsed.names,
        provider: "custom",
        status: parsed.expiresAt < new Date() ? "expired" : "active",
        certPath: parsed.certPath,
        keyPath: parsed.keyPath,
        issuer: parsed.issuer,
        expiresAt: parsed.expiresAt,
        autoRenew: false,
      })
      .returning();
    await applyCertificate(cert);
    return { id };
  });
}

async function certInOrg(id: string, orgId: string) {
  const [cert] = await db
    .select()
    .from(schema.certificate)
    .where(and(eq(schema.certificate.id, id), eq(schema.certificate.organizationId, orgId)));
  if (!cert) throw new UserError("Certificate not found.");
  return cert;
}

export async function renewCertificate(id: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const cert = await certInOrg(id, ctx.org.id);
    if (cert.provider === "custom") throw new UserError("Upload a new file to replace a custom certificate.");
    await enqueue("certificate.issue", { certificateId: id }, { concurrencyKey: `cert:${id}` });
    return null;
  });
}

export async function setCertificateAutoRenew(id: string, autoRenew: boolean) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    await certInOrg(id, ctx.org.id);
    await db.update(schema.certificate).set({ autoRenew }).where(eq(schema.certificate.id, id));
    return null;
  });
}

export async function deleteCertificate(id: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const cert = await certInOrg(id, ctx.org.id);
    await db.update(schema.domain).set({ certificateId: null }).where(eq(schema.domain.certificateId, id));
    await db.delete(schema.certificate).where(eq(schema.certificate.id, id));
    await applyCertificate(cert);
    await deleteCertificateFiles(cert);
    return null;
  });
}

export async function certificateLogs(id: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const cert = await certInOrg(id, ctx.org.id);
    return { logs: cert.logs, status: cert.status, error: cert.lastError };
  });
}
