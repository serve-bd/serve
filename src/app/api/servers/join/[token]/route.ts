import { NextResponse, type NextRequest } from "next/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { installScript, knownHostsLine, normalizePublicKey, tokenMatches } from "@/server/tunnel";
import { tunnelHostKey } from "@/server/tunnel/host-key";
import { forgetServer } from "@/server/servers/context";

export const dynamic = "force-dynamic";

/**
 * Join endpoints for servers that connect out. The token in the path is the only credential:
 * it works once, for 24 hours, and only its hash is stored.
 */

async function serverFor(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const rows = await db.select().from(schema.server).where(isNotNull(schema.server.tunnel));
  const row = rows.find((r) => tokenMatches(r.tunnel?.tokenHash ?? null, token));
  if (!row?.tunnel?.tokenExpiresAt || new Date(row.tunnel.tokenExpiresAt).getTime() <= Date.now()) return null;
  return row;
}

const script = (body: string) => new NextResponse(body, { headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" } });

/** The install script (`curl … | sudo bash`). An expired command still answers, with a message. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await serverFor(token);
  if (!row) {
    return script(`#!/bin/sh\necho "This join command expired or was used already. Create a new one on the server's page in Serve." >&2\nexit 1\n`);
  }
  // The address this machine used to download the script (behind a proxy: the forwarded one).
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host).split(",")[0].trim();
  const proto = (request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "")).split(",")[0].trim();
  return script(installScript({ joinUrl: `${proto === "https" ? "https" : "http"}://${host}${request.nextUrl.pathname}`, user: row.username }));
}

/** Registration: the server's tunnel key in, what it needs to connect out. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await serverFor(token);
  if (!row?.tunnel) return new NextResponse("This join command expired or was used already. Create a new one on the server's page in Serve.\n", { status: 404 });
  const form = await request.formData().catch(() => null);
  const clientKey = normalizePublicKey(String(form?.get("publicKey") ?? ""));
  if (!clientKey) return new NextResponse("Send the tunnel's public key.\n", { status: 400 });
  const hostname = String(form?.get("hostname") ?? "")
    .trim()
    .replace(/[^A-Za-z0-9.-]/g, "")
    .slice(0, 63);
  // One machine is one server: its single tunnel service cannot serve two.
  const others = await db.select({ id: schema.server.id, name: schema.server.name, tunnel: schema.server.tunnel }).from(schema.server).where(isNotNull(schema.server.tunnel));
  const twin = others.find((o) => o.id !== row.id && o.tunnel?.clientKey === clientKey);
  if (twin) return new NextResponse(`This machine is already connected to Serve as the server "${twin.name}". Remove that server in Serve first.\n`, { status: 409 });
  const [key] = row.privateKeyId ? await db.select().from(schema.privateKey).where(eq(schema.privateKey.id, row.privateKeyId)) : [];
  if (!key) return new NextResponse("This server has no SSH key in Serve.\n", { status: 409 });
  const host = await tunnelHostKey();
  // The token is used up; the next join needs a new command. Claimed in one statement (only while
  // the token is still there), so two registrations at the same moment cannot both win.
  const claimed = await db
    .update(schema.server)
    .set({
      host: hostname || row.host,
      // A reinstalled machine has a new host key: set up again when it connects, which pins it.
      hostKey: null,
      status: "pending",
      statusMessage: "Waiting for the server to connect",
      tunnel: sql`${schema.server.tunnel} || ${JSON.stringify({ clientKey, tokenHash: null, tokenExpiresAt: null })}::jsonb`,
    })
    .where(and(eq(schema.server.id, row.id), sql`${schema.server.tunnel}->>'tokenHash' = ${row.tunnel.tokenHash}`))
    .returning({ id: schema.server.id });
  if (!claimed.length) return new NextResponse("This join command expired or was used already. Create a new one on the server's page in Serve.\n", { status: 404 });
  forgetServer(row.id);
  // The listener picks up the new key now, and drops a connection that still uses the old one.
  const { enqueue } = await import("@/server/queue");
  await enqueue("tunnel.sync", {}, { concurrencyKey: "tunnel" }).catch(() => {});
  const lines = [
    `SERVE_KEY=${key.publicKey.trim()}`,
    `SSH_USER=${row.username}`,
    `SSH_PORT=${row.port}`,
    `TUNNEL_HOST=${row.tunnel.address}`,
    `TUNNEL_PORT=${row.tunnel.port}`,
    `KNOWN_HOSTS=${knownHostsLine(row.tunnel.address, row.tunnel.port, host.publicKey)}`,
  ];
  return new NextResponse(`${lines.join("\n")}\n`, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
