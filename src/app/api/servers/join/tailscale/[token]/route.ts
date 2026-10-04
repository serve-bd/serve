import { NextResponse, type NextRequest } from "next/server";
import { eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { tokenMatches } from "@/server/tunnel";
import { getTailnet } from "@/server/tailscale";
import { completeJoin, JoinRefused, prepareKey } from "@/server/tailscale/join";
import { joinScript, realNodeKey } from "@/server/tailscale/script";

export const dynamic = "force-dynamic";

/**
 * Join endpoints for servers that connect through Tailscale. The token in the path is the only
 * credential: it works until the machine has joined (once), for 24 hours, and only its hash is
 * stored. The auth key is made when the machine asks for it, so it never expires while waiting.
 */

const EXPIRED = "This join command expired or was used already. Create a new one on the server's page in the dashboard.";

async function serverFor(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const rows = await db.select().from(schema.server).where(isNotNull(schema.server.tailscale));
  const row = rows.find((r) => tokenMatches(r.tailscale?.tokenHash ?? null, token));
  if (!row?.tailscale?.tokenExpiresAt || new Date(row.tailscale.tokenExpiresAt).getTime() <= Date.now()) return null;
  // The tailnet is the instance's: an organization's server never joins it.
  if (row.ownerOrganizationId || row.isLocal) return null;
  return row;
}

const script = (body: string) => new NextResponse(body, { headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" } });
const text = (body: string, status = 200) =>
  new NextResponse(`${body.trim()}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** The install script (`curl … | sudo bash`). An expired command still answers, with a message. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await serverFor(token);
  if (!row) return script(`#!/bin/sh\necho "${EXPIRED}" >&2\nexit 1\n`);
  // The address this machine used to download the script (behind a proxy: the forwarded one).
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host).split(",")[0].trim();
  const proto = (request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "")).split(",")[0].trim();
  return script(joinScript({ joinUrl: `${proto === "https" ? "https" : "http"}://${host}${request.nextUrl.pathname}`, user: row.username }));
}

/** step=key: Serve's SSH key and an auth key (or none when the machine is in the tailnet already). step=done: the machine joined. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await serverFor(token);
  if (!row?.tailscale) return text(EXPIRED, 404);
  const form = await request.formData().catch(() => null);
  const field = (k: string) => String(form?.get(k) ?? "").trim();
  try {
    if (field("step") === "key") {
      const tailnet = await getTailnet(row.tailscale.tailnetId);
      if (!tailnet) return text("The Tailscale integration this command was made for was removed. Connect Tailscale again and make a new command.", 409);
      const [key] = row.privateKeyId ? await db.select().from(schema.privateKey).where(eq(schema.privateKey.id, row.privateKeyId)) : [];
      if (!key) return text("This server has no SSH key in the dashboard.", 409);
      const plan = await prepareKey(
        row,
        tailnet,
        {
          state: field("state").replace(/[^A-Za-z]/g, "") || null,
          nodeKey: realNodeKey(field("nodeKey")),
          suffix:
            field("suffix")
              .replace(/[^A-Za-z0-9.-]/g, "")
              .slice(0, 253) || null,
        },
        field("force") === "1",
      );
      const lines = [
        `SERVE_KEY=${key.publicKey.trim()}`,
        `SSH_USER=${row.username}`,
        `TS_HOSTNAME=${plan.hostname}`,
        `ALREADY=${plan.already ? 1 : 0}`,
        ...(plan.already ? [] : [`AUTH_KEY=${plan.authKey}`]),
      ];
      return text(lines.join("\n"));
    }
    if (field("step") === "done") {
      const nodeKey = realNodeKey(field("nodeKey"));
      if (!nodeKey) return text("Send the machine's Tailscale node key.", 400);
      const joined = await completeJoin(row.id, nodeKey, { tokenHash: row.tailscale.tokenHash ?? undefined });
      return text(`OK ${joined.address}`);
    }
    return text("Unknown step.", 400);
  } catch (error) {
    if (error instanceof JoinRefused) return text(error.message, error.status);
    console.error("[tailscale join]", error);
    return text("Serve could not finish this step. Check the dashboard's logs.", 500);
  }
}
