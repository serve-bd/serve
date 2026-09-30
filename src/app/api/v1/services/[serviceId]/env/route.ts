import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import { decrypt, encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { notFound, requireToken, tokenService } from "@/server/api-auth";
import { queueDeployment } from "@/server/services/create";
import { logActivity } from "@/server/activity";

type Ctx = RouteContext<"/api/v1/services/[serviceId]/env">;

/** Variable values. Scope: read:sensitive. */
export async function GET(request: Request, ctx: Ctx) {
  const { auth, error } = await requireToken(request, "read:sensitive");
  if (error) return error;
  const { serviceId } = await ctx.params;
  if (!(await tokenService(auth, serviceId))) return notFound("Service not found");
  const rows = await db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, serviceId)).orderBy(asc(schema.envVar.key));
  return Response.json({ variables: Object.fromEntries(rows.map((r) => [r.key, decrypt(r.value)])) });
}

const bodySchema = z.object({
  /** Keys to set; null removes the variable. Other variables are kept. */
  variables: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "Invalid variable name"),
    z
      .string()
      .max(64 * 1024)
      .nullable(),
  ),
  redeploy: z.boolean().optional(),
});

/** Set or remove variables. Scope: write. */
export async function PATCH(request: Request, ctx: Ctx) {
  const { auth, error } = await requireToken(request, "write");
  if (error) return error;
  const { serviceId } = await ctx.params;
  const row = await tokenService(auth, serviceId);
  if (!row) return notFound("Service not found");
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  const entries = Object.entries(parsed.data.variables);
  if (entries.length) {
    await db.transaction(async (tx) => {
      const keys = entries.map(([k]) => k);
      const existing = await tx
        .select()
        .from(schema.envVar)
        .where(and(eq(schema.envVar.serviceId, serviceId), inArray(schema.envVar.key, keys)));
      await tx.delete(schema.envVar).where(and(eq(schema.envVar.serviceId, serviceId), inArray(schema.envVar.key, keys)));
      const values = entries
        .filter(([, v]) => v !== null)
        .map(([key, value]) => {
          const prev = existing.find((e) => e.key === key);
          return { id: newId(), serviceId, key, value: encrypt(value!), buildTime: prev?.buildTime ?? true, runtime: prev?.runtime ?? true };
        });
      if (values.length) await tx.insert(schema.envVar).values(values);
    });
    await logActivity({
      userId: auth.userId,
      projectId: row.service.projectId,
      action: "service.variables",
      targetType: "service",
      targetId: serviceId,
      message: `Updated variables of ${row.service.name} via the API`,
    });
  }
  let deploymentId: string | null = null;
  if (parsed.data.redeploy && row.service.status !== "idle") deploymentId = await queueDeployment(serviceId, "redeploy", { userId: auth.userId });
  return Response.json({ ok: true, deploymentId });
}
