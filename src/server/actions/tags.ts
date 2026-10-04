"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { serviceInOrg } from "@/server/services/access";
import { TAG_COLOR_NAMES } from "@/lib/tags";
import { deployTag, newTagSecret, setServiceTags, tagName } from "@/server/tags";

const color = z.enum(TAG_COLOR_NAMES as [string, ...string[]]);

async function tagInOrg(tagId: string, organizationId: string) {
  const [row] = await db
    .select()
    .from(schema.tag)
    .where(and(eq(schema.tag.id, tagId), eq(schema.tag.organizationId, organizationId)));
  if (!row) throw new UserError("Tag not found.");
  return row;
}

/** A clash with another tag of the organization, said plainly. */
async function uniqueName(organizationId: string, name: string, except?: string) {
  const all = await db.select({ id: schema.tag.id, name: schema.tag.name }).from(schema.tag).where(eq(schema.tag.organizationId, organizationId));
  if (all.some((t) => t.id !== except && t.name.toLowerCase() === name.toLowerCase())) throw new UserError(`There is a tag ${name} already.`);
}

export async function createTag(input: { name: string; color?: string }) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const data = z.object({ name: z.string(), color: color.optional() }).parse(input);
    const name = tagName(data.name);
    await uniqueName(ctx.org.id, name);
    const id = newId();
    await db.insert(schema.tag).values({ id, organizationId: ctx.org.id, name, color: data.color ?? "gray", deploySecret: newTagSecret() });
    return { id };
  });
}

export async function updateTag(tagId: string, input: { name?: string; color?: string }) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const data = z.object({ name: z.string().optional(), color: color.optional() }).parse(input);
    await tagInOrg(tagId, ctx.org.id);
    const patch: { name?: string; color?: string } = {};
    if (data.name !== undefined) {
      patch.name = tagName(data.name);
      await uniqueName(ctx.org.id, patch.name, tagId);
    }
    if (data.color) patch.color = data.color;
    if (Object.keys(patch).length) await db.update(schema.tag).set(patch).where(eq(schema.tag.id, tagId));
    return null;
  });
}

/** The tag goes from every service; the services stay. */
export async function deleteTag(tagId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    await tagInOrg(tagId, ctx.org.id);
    await db.delete(schema.tag).where(eq(schema.tag.id, tagId));
    return null;
  });
}

/** A new secret for the tag's deploy hook: the old URL stops working. */
export async function rotateTagHook(tagId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    await tagInOrg(tagId, ctx.org.id);
    await db.update(schema.tag).set({ deploySecret: newTagSecret() }).where(eq(schema.tag.id, tagId));
    return null;
  });
}

/** The tags of a service, by name; new names become tags of the organization. */
export async function saveServiceTags(serviceId: string, names: string[]) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const list = z.array(z.string().max(60)).max(50).parse(names);
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.parentServiceId) throw new UserError("Previews follow their app: tag the app.");
    await setServiceTags(serviceId, ctx.org.id, list);
    return null;
  });
}

/** Deploys every service of the tag the member can reach. */
export async function deployTagAction(tagId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    await tagInOrg(tagId, ctx.org.id);
    return deployTag(tagId, { trigger: "redeploy", userId: ctx.user.id, canAccessProject: (id) => ctx.canAccessProject(id) });
  });
}
