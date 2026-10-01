import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import { decrypt, decryptOrNull, encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { notFound, requireToken, tokenService } from "@/server/api-auth";
import { queueDeployment } from "@/server/services/create";
import { logActivity } from "@/server/activity";
import { isInstanceAdmin } from "@/server/auth";
import { composeSecurityIssues } from "@/server/security";
import { getSetting } from "@/server/settings";
import { composeVariables } from "@/lib/compose-vars";

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
  variables: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "Invalid variable name"),
      z
        .string()
        .max(64 * 1024)
        .nullable(),
    )
    .refine((v) => Object.keys(v).length <= 500, "At most 500 variables per request"),
  redeploy: z.boolean().optional(),
});
const MAX_BODY = 8 * 1024 * 1024;

/** Set or remove variables. Scope: write. */
export async function PATCH(request: Request, ctx: Ctx) {
  const { auth, error } = await requireToken(request, "write");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ error: "Too large." }, { status: 413 });
  if (error) return error;
  const { serviceId } = await ctx.params;
  const row = await tokenService(auth, serviceId);
  if (!row) return notFound("Service not found");
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  const entries = Object.entries(parsed.data.variables);
  // Same rule as saveEnvVars: a compose file a Root admin allowed host options for can point them
  // anywhere through its variables, so only Root admins change the ones it uses.
  const compose = row.service.compose;
  if (entries.length && compose?.hostAccess && composeSecurityIssues(compose.content).length) {
    const rootAdmin = auth.organizationId === (await getSetting("rootOrganizationId")) && (await isInstanceAdmin(auth.userId));
    if (!rootAdmin) {
      const used = new Set(composeVariables(compose.content).map((v) => v.name));
      const stored = await db.select({ key: schema.envVar.key, value: schema.envVar.value }).from(schema.envVar).where(eq(schema.envVar.serviceId, serviceId));
      const before = new Map(stored.map((v) => [v.key, decryptOrNull(v.value) ?? ""]));
      const changed = entries.filter(([key, value]) => used.has(key) && before.get(key) !== (value ?? undefined)).map(([key]) => key);
      if (changed.length)
        return Response.json(
          { error: `This compose file uses host options, so only admins of the Root organization can change ${changed.slice(0, 3).join(", ")}.` },
          { status: 403 },
        );
    }
  }
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
