import { z } from "zod";
import type { ActionResult } from "@/server/action";
import { UserError } from "@/server/action";
import { type ApiAuth, authenticateToken } from "@/server/api-auth";
import { PERMISSION_INFO, type Permission } from "@/lib/permissions";
import { runAsToken } from "./principal";
import { readBodyLimited } from "@/server/http-body";

/*
 * The REST API (/api/v1). Each route names the permissions a token needs; the router checks them
 * before the handler runs, and the handler then runs as the token (see principal.ts), so the
 * dashboard actions it calls check permissions, project limits and plan limits again exactly
 * as they do for a person.
 */

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A permission, "admin" (organization admin) or "instance" (an admin of the Root organization). */
export type Need = Permission | "admin" | "instance";

export type HandlerContext<B = unknown, Q = unknown> = {
  params: Record<string, string>;
  body: B;
  query: Q;
  auth: ApiAuth;
  request: Request;
};

export type ApiRoute = {
  method: Method;
  /** OpenAPI style: /services/{serviceId}/deploy */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  /** Every listed need is required. */
  needs: Need[];
  body?: z.ZodType;
  query?: z.ZodType;
  /** Status of a successful answer (200 by default). */
  status?: number;
  // biome-ignore lint/suspicious/noExplicitAny: each route's own schemas type its handler.
  handler: (c: HandlerContext<any, any>) => Promise<unknown>;
};

/** Typed route helper: the handler sees the parsed body and query. */
export function route<B extends z.ZodType = z.ZodNever, Q extends z.ZodType = z.ZodNever>(
  def: Omit<ApiRoute, "body" | "query" | "handler"> & { body?: B; query?: Q; handler: (c: HandlerContext<z.output<B>, z.output<Q>>) => Promise<unknown> },
): ApiRoute {
  return def as ApiRoute;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Status for an action's error message: not found, not allowed, or a bad request. */
function statusFor(message: string) {
  if (/not found|no longer exists/i.test(message)) return 404;
  if (/^your role cannot|^only (organization |instance )?admins|need to be an admin|not allowed|permission/i.test(message)) return 403;
  if (/already (exists|in use)|is defined twice|already running|in progress/i.test(message)) return 409;
  return 400;
}

/** The data of a dashboard action, or its error as an API error. */
export async function unwrap<T>(result: Promise<ActionResult<T>> | ActionResult<T>): Promise<T> {
  const r = await result;
  if (!r.ok) throw new ApiError(statusFor(r.error), r.error);
  return r.data;
}

const NEED_LABEL: Record<"admin" | "instance", string> = {
  admin: "admin (organization admin)",
  instance: "admin, with an owner who is an admin of the Root organization",
};

export const needLabel = (n: Need) => (n === "admin" || n === "instance" ? NEED_LABEL[n] : `${n} (${PERMISSION_INFO[n].label})`);

/** For a body option that needs more than its route (redeploy: true): refused before anything is saved. */
export function assertCan(auth: ApiAuth, permission: Permission) {
  if (!auth.can(permission)) throw new ApiError(403, `This token cannot do this. It needs: ${needLabel(permission)}.`);
}

async function hasNeed(auth: ApiAuth, need: Need) {
  if (need === "admin") return auth.admin;
  if (need === "instance") {
    if (!auth.admin) return false;
    const { isInstanceAdmin } = await import("@/server/auth");
    return isInstanceAdmin(auth.userId);
  }
  return auth.can(need);
}

type Compiled = { route: ApiRoute; pattern: RegExp; names: string[] };

function compile(routes: ApiRoute[]): Compiled[] {
  return routes.map((route) => {
    const names: string[] = [];
    const source = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
      names.push(name);
      return "([^/]+)";
    });
    return { route, pattern: new RegExp(`^${source}/?$`), names };
  });
}

const MAX_BODY = 10 * 1024 * 1024;

const error = (status: number, message: string, extra?: Record<string, unknown>) => Response.json({ error: message, ...extra }, { status });

function zodMessage(e: z.ZodError, where: string) {
  const issue = e.issues[0];
  return issue ? `${where}${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}` : `Invalid ${where}`;
}

function queryObject(url: URL) {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

/** Adds headers; a response whose headers cannot change (one passed through from fetch) is copied first. */
function setHeaders(res: Response, headers: Record<string, string>) {
  try {
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    for (const [k, v] of Object.entries(headers)) copy.headers.set(k, v);
    return copy;
  }
}

export function createRouter(routes: ApiRoute[], publicRoutes: Record<string, (request: Request) => Promise<Response>> = {}) {
  const compiled = compile(routes);

  return async function handle(request: Request, path: string): Promise<Response> {
    const method = request.method.toUpperCase() as Method;
    const normalized = `/${path.replace(/^\/+|\/+$/g, "")}`;
    if (method === "GET" && publicRoutes[normalized]) return publicRoutes[normalized](request);

    const matches = compiled.map((c) => ({ c, m: c.pattern.exec(normalized) })).filter((x) => x.m);
    if (!matches.length) return error(404, `No API route ${method} ${normalized}. See /api/v1/openapi.json.`);
    const hit = matches.find((x) => x.c.route.method === method);
    if (!hit) {
      const allow = [...new Set(matches.map((x) => x.c.route.method))].join(", ");
      return new Response(JSON.stringify({ error: `Use ${allow} for ${normalized}.` }), { status: 405, headers: { allow, "content-type": "application/json" } });
    }
    const { route: r, names } = hit.c;
    let params: Record<string, string>;
    try {
      params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit.m![i + 1])]));
    } catch {
      return error(400, `Invalid path ${normalized}.`);
    }

    const { getSettings } = await import("@/server/settings");
    const { apiEnabled, apiRateLimit } = await getSettings();
    if (!apiEnabled) return error(503, "The API is turned off. An admin of this Serve instance can turn it on in Settings → Security.");
    const { auth, error: authError } = await authenticateToken(request);
    if (authError) return authError;
    const { takeRequest } = await import("./rate-limit");
    const rate = takeRequest(auth.tokenId, apiRateLimit);
    if (!rate.allowed) {
      const res = error(429, `Too many requests: this token may make ${apiRateLimit} per minute. Try again after the Retry-After seconds.`);
      setHeaders(res, rate.headers);
      return res;
    }
    const response = await dispatch(auth);
    return setHeaders(response, rate.headers);

    async function dispatch(auth: ApiAuth): Promise<Response> {
      const missing: Need[] = [];
      for (const need of r.needs) if (!(await hasNeed(auth, need))) missing.push(need);
      if (missing.length)
        return error(403, `This token cannot do this. It needs: ${missing.map(needLabel).join(", ")}. A token never has more than its owner's role allows.`, { missing });

      let body: unknown;
      if (r.body) {
        let raw: unknown = {};
        const text = await readBodyLimited(request, MAX_BODY);
        if (text === null) return error(413, "The request body is too large (10 MB at most).");
        if (text.trim()) {
          try {
            raw = JSON.parse(text);
          } catch {
            return error(400, "The request body is not valid JSON.");
          }
        }
        const parsed = r.body.safeParse(raw);
        if (!parsed.success) return error(400, zodMessage(parsed.error, "body"));
        body = parsed.data;
      }
      let query: unknown;
      if (r.query) {
        const parsed = r.query.safeParse(queryObject(new URL(request.url)));
        if (!parsed.success) return error(400, zodMessage(parsed.error, "query"));
        query = parsed.data;
      }

      try {
        const result = await runAsToken(auth, () => r.handler({ params, body, query, auth, request }));
        if (result instanceof Response) return result;
        return Response.json(result ?? { ok: true }, { status: r.status ?? 200 });
      } catch (e) {
        if (e instanceof ApiError) return error(e.status, e.message);
        if (e instanceof UserError) return error(statusFor(e.message), e.message);
        if (e instanceof z.ZodError) return error(400, zodMessage(e, "body"));
        const digest = e && typeof e === "object" && "digest" in e ? String((e as { digest: unknown }).digest) : "";
        if (digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404") || digest === "NEXT_NOT_FOUND") return error(404, "Not found");
        if (digest.startsWith("NEXT_REDIRECT")) return error(403, "This token cannot do this.");
        const { ForbiddenError } = await import("@/server/auth");
        if (e instanceof ForbiddenError) return error(403, (e as Error).message);
        console.error(`[api] ${method} ${normalized}`, e);
        return error(500, "Something went wrong. Check the server logs for details.");
      }
    }
  };
}
