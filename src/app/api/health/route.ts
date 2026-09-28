import { sql } from "@/server/db";

export async function GET() {
  try {
    await sql`select 1`;
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
