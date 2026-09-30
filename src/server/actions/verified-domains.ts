"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { logActivity } from "@/server/activity";
import { domainOwnership } from "@/server/domains/ownership";

const nameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((h) =>
    h
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^\*\./, ""),
  )
  .pipe(z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/, "Enter a domain like example.com"));

/** Whether this organization may use a domain, and the TXT record to add when not yet. Remembers a new proof. */
export async function checkDomainOwnership(hostname: string) {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    const name = nameSchema.parse(hostname);
    const result = await domainOwnership({ id: ctx.org.id, isRoot: ctx.isRoot }, name);
    if (result.verified && (result.via === "txt" || result.via === "cloudflare")) {
      await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "domain.verified", message: `Verified ${result.name ?? name}` });
    }
    return result;
  });
}

/** Forgets a verification. Domains already added keep working; new ones need the proof again. */
export async function removeVerifiedDomain(id: string) {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    const [row] = await db
      .delete(schema.verifiedDomain)
      .where(and(eq(schema.verifiedDomain.id, id), eq(schema.verifiedDomain.organizationId, ctx.org.id)))
      .returning();
    if (!row) throw new UserError("Not found.");
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "domain.unverified", message: `Removed the verification of ${row.name}` });
    return null;
  });
}
