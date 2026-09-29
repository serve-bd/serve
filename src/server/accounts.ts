import { eq, sql } from "drizzle-orm";
import { auth } from "@/server/auth";
import { db, schema } from "@/server/db";
import { newId, slugify } from "@/server/id";
import { UserError } from "@/server/action";

export async function userCount() {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.user);
  return row.n;
}

export async function createAccount(input: { name: string; email: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  const [existing] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
  if (existing) throw new UserError("An account with this email already exists. Sign in instead.");
  if (input.password.length < 8) throw new UserError("Password must be at least 8 characters.");
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email, name: input.name.trim(), emailVerified: true }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await ctx.password.hash(input.password),
  });
  return user;
}

export async function uniqueOrgSlug(name: string) {
  const base = slugify(name, 32);
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const [taken] = await db.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.slug, slug));
    if (!taken) return slug;
  }
  return `${base}-${newId().slice(0, 6)}`;
}

export async function createOrganization(name: string, ownerId: string) {
  const id = newId();
  const [org] = await db
    .insert(schema.organization)
    .values({ id, name: name.trim(), slug: await uniqueOrgSlug(name) })
    .returning();
  await db.insert(schema.member).values({ id: newId(), organizationId: id, userId: ownerId, role: "owner" });
  return org;
}
