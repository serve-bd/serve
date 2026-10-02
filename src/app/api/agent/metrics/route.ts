import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db, schema } from "@/server/db";
import { readBodyLimited } from "@/server/http-body";
import { batchSchema, ingestBatch } from "@/server/metrics-agent/ingest";
import { tokenMatches } from "@/server/tunnel";

export const dynamic = "force-dynamic";

const MAX_BODY = 8 * 1024 * 1024;

/**
 * Samples pushed by a server's metrics agent (agent/main.go). The token is "<server id>.<secret>",
 * set when the agent was installed. 410 tells the agent that metrics are off for its server.
 */
export async function POST(request: NextRequest) {
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
  const dot = bearer.lastIndexOf(".");
  const serverId = dot > 0 ? bearer.slice(0, dot) : "";
  const token = dot > 0 ? bearer.slice(dot + 1) : "";
  const [row] = serverId ? await db.select({ agent: schema.server.agent, isLocal: schema.server.isLocal }).from(schema.server).where(eq(schema.server.id, serverId)) : [];
  if (!row || row.isLocal || !token || !tokenMatches(row.agent?.tokenHash || null, token)) return NextResponse.json({ error: "Unknown agent." }, { status: 401 });

  const text = await readBodyLimited(request, MAX_BODY);
  if (text === null) return NextResponse.json({ error: "Too large." }, { status: 413 });
  let parsed: ReturnType<typeof batchSchema.safeParse>;
  try {
    parsed = batchSchema.safeParse(JSON.parse(text));
  } catch {
    return NextResponse.json({ error: "Not JSON." }, { status: 400 });
  }
  if (!parsed.success) return NextResponse.json({ error: "Unexpected samples." }, { status: 400 });

  const result = await ingestBatch(serverId, parsed.data, "push");
  if ("gone" in result) return NextResponse.json({ error: "Metrics are off for this server." }, { status: 410 });
  return NextResponse.json({ ack: result.ack });
}
