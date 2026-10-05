import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getSession } from "@/server/auth";
import { db, schema } from "@/server/db";
import { env } from "@/server/env";
import type { PageRow } from "./data";

export const unlockCookie = (pageId: string) => `serve_status_${pageId}`;

/** Proof the visitor knew the password. A new password makes every old proof invalid. */
export function unlockToken(pageId: string, passwordHash: string) {
  return crypto.createHmac("sha256", env.authSecret).update(`status-unlock:${pageId}:${passwordHash}`).digest("base64url");
}

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** A signed-in member of the page's organization: they see drafts and locked pages. */
async function isMember(organizationId: string) {
  const session = await getSession().catch(() => null);
  if (!session) return false;
  const [row] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, session.user.id)));
  return !!row;
}

export type PageAccess = "open" | "locked" | "hidden";

/**
 * Whether this visitor may see the page. Drafts exist only for members; a password page asks
 * for its password unless the visitor gave it before (or is a member).
 */
export async function pageAccess(page: Pick<PageRow, "id" | "organizationId" | "visibility" | "passwordHash">): Promise<{ access: PageAccess; member: boolean }> {
  if (page.visibility === "public") return { access: "open", member: false };
  const member = await isMember(page.organizationId);
  if (member) return { access: "open", member };
  if (page.visibility === "draft" || !page.passwordHash) return { access: "hidden", member };
  const jar = await cookies();
  const given = jar.get(unlockCookie(page.id))?.value;
  return { access: given && same(given, unlockToken(page.id, page.passwordHash)) ? "open" : "locked", member };
}
