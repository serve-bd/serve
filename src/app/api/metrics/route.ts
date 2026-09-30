import { NextResponse, type NextRequest } from "next/server";
import { requireOrg } from "@/server/auth";
import { metricSeries, serverSnapshot } from "@/server/metrics";
import { serviceInOrg } from "@/server/services/access";

export async function GET(request: NextRequest) {
  const ctx = await requireOrg();
  const scope = request.nextUrl.searchParams.get("scope") ?? "server";
  const requested = Number(request.nextUrl.searchParams.get("hours") ?? 6);
  const hours = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 168) : 6;
  // Other servers' history is under /api/servers/<id>/metrics (Root admins only).
  if (scope.startsWith("server:")) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // The host itself is shared by every organization: its numbers are for Root admins only.
  if (scope === "server" && !ctx.isInstanceAdmin) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (scope !== "server") {
    try {
      await serviceInOrg(scope, ctx.org.id);
    } catch {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }
  const [series, now] = await Promise.all([metricSeries(scope, hours), scope === "server" ? serverSnapshot() : null]);
  return NextResponse.json({ series, now });
}
