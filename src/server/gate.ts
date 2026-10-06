import { and, eq, gt } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { env } from "@/server/env";
import { hmac, timingSafeEqual } from "@/server/crypto";
import { memberAccess } from "@/server/permissions";
import { preferHttps, publicBaseUrl } from "@/server/git/github-app";

/*
 * Login wall ("Only my team"). The proxy asks Serve about every request to the app (forward auth).
 * Without a valid cookie the visitor goes to the dashboard to sign in. A member who may reach the
 * app's project gets a one-minute ticket back to the app, where GATE_PATH (proxied to Serve)
 * swaps it for a cookie on the app's own host.
 */

export const GATE_COOKIE = "__serve_gate";
export const GATE_PATH = "/__serve/gate";
/** Serve's own monitors send this header with gateKey(serviceId): they check the app, not the wall. */
export const GATE_KEY_HEADER = "X-Serve-Gate";
const TICKET_S = 60;
export const PASS_S = 7 * 86_400;

/**
 * Ticket: one minute, in the URL back to the app. h and x: the app's host and whether it is HTTPS.
 * i: the Serve session it came from. The pass keeps it: signing out of Serve closes the wall too.
 */
export type Ticket = { k: "t"; u: string; i: string; s: string; h: string; p: string; x: boolean; e: number };
/** Pass: the cookie on the app's host. */
export type Pass = { k: "c"; u: string; i: string; s: string; e: number };

const now = () => Math.floor(Date.now() / 1000);

export function signGate(payload: Omit<Ticket, "e"> | Omit<Pass, "e">) {
  const body = Buffer.from(JSON.stringify({ ...payload, e: now() + (payload.k === "t" ? TICKET_S : PASS_S) })).toString("base64url");
  return `${body}.${hmac(`gate.${body}`)}`;
}

export function verifyGate<T extends Ticket | Pass>(token: string | null | undefined, kind: T["k"]): T | null {
  const [body, sig, extra] = (token ?? "").split(".");
  if (!body || !sig || extra !== undefined || !timingSafeEqual(sig, hmac(`gate.${body}`))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as T;
    return p.k === kind && p.e > now() ? p : null;
  } catch {
    return null;
  }
}

/** Changes every day (today's and yesterday's pass): a key seen once does not open the wall for good. */
const day = () => Math.floor(Date.now() / 86_400_000);
export const gateKey = (serviceId: string, d = day()) => hmac(`gate-monitor.${d}.${serviceId}`);
export const gateKeyValid = (serviceId: string, key: string | null) => !!key && (timingSafeEqual(key, gateKey(serviceId)) || timingSafeEqual(key, gateKey(serviceId, day() - 1)));

const answers = new Map<string, { ok: boolean; at: number }>();
const REMEMBER_MS = 30_000;

/**
 * Whether the Serve session is still signed in and its user is a member of the app's organization
 * who may reach its project. Remembered for 30 seconds: the proxy asks on every request, and a
 * removed member or a sign-out closes the wall in that time.
 */
export async function gateAllows(userId: string, sessionId: string, serviceId: string) {
  const key = `${sessionId}:${userId}:${serviceId}`;
  const hit = answers.get(key);
  if (hit && Date.now() - hit.at < REMEMBER_MS) return hit.ok;
  const [row] = await db
    .select({ projectId: schema.project.id, orgId: schema.project.organizationId })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(eq(schema.service.id, serviceId));
  const [session] = await db
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(and(eq(schema.session.id, sessionId), eq(schema.session.userId, userId), gt(schema.session.expiresAt, new Date())));
  const access = row && session ? await memberAccess(row.orgId, userId) : null;
  const ok = !!access && (!access.projectIds || access.projectIds.includes(row.projectId));
  if (answers.size > 10_000) answers.clear();
  answers.set(key, { ok, at: Date.now() });
  return ok;
}

/** Where a server's proxy reaches Serve: the container next to it on Serve's own machine, the public address elsewhere. */
export async function gateUpstream(serverId: string) {
  // Other servers reach it over the internet with the visitor's cookie: HTTPS whenever the dashboard answers there.
  return serverId === LOCAL_SERVER_ID ? `http://${env.dashboardUpstream}` : await preferHttps(await publicBaseUrl());
}

function hostMatches(pattern: string, host: string) {
  if (pattern === host) return true;
  if (!pattern.startsWith("*.") || !host.endsWith(pattern.slice(1))) return false;
  const label = host.slice(0, host.length - pattern.length + 1);
  return !!label && !label.includes(".");
}

/** The app behind a host, when it has the login wall on and the host is one of its domains. */
export async function gateTarget(serviceId: string, host: string) {
  const service = await db.query.service.findFirst({ where: eq(schema.service.id, serviceId), with: { domains: true } });
  if (!service?.proxy?.login) return null;
  const domain = service.domains.find((d) => !d.redirectTo && hostMatches(d.hostname, host));
  return domain ? { name: service.name, https: domain.https || !!domain.tunnelId } : null;
}
