import crypto from "node:crypto";
import { publicRequest } from "@/server/net/public-fetch";
import type { SecretProviderConfig, SecretProviderCredentials, SecretProviderKind } from "@/lib/secret-providers";

export class SecretFetchError extends Error {}

export type ProviderClient = { kind: SecretProviderKind; config: SecretProviderConfig; credentials: SecretProviderCredentials; allowPrivate: boolean };

type Res = { status: number; text: string };

/**
 * One request to a secret manager. Root may reach private addresses (a Vault on the LAN);
 * other organizations only public ones. Redirects are never followed: a token must not be
 * sent on to another host.
 */
async function send(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }, allowPrivate: boolean): Promise<Res> {
  try {
    if (!allowPrivate) {
      // A manager's answer can list a whole configuration: a megabyte, not the usual 64 KB.
      const res = await publicRequest(url, { method: init.method ?? "GET", headers: init.headers, body: init.body, maxBytes: 1024 * 1024 });
      return { status: res.status, text: res.text };
    }
    const res = await fetch(url, { method: init.method ?? "GET", headers: init.headers, body: init.body, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    throw new SecretFetchError(`Could not reach ${new URL(url).host}${cause ? ` (${cause})` : `: ${(e as Error).message}`}`);
  }
}

const json = (text: string): Record<string, unknown> => {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** A short reason from an error answer, never the request or its credentials. */
function failure(service: string, res: Res, what: string) {
  const body = json(res.text);
  const msg =
    (Array.isArray(body.errors) && typeof body.errors[0] === "string" ? body.errors[0] : null) ??
    (typeof body.message === "string" ? body.message : null) ??
    (typeof body.Message === "string" ? body.Message : null) ??
    (typeof body.__type === "string" ? String(body.__type).split("#").pop() : null);
  const hint = res.status === 401 || res.status === 403 ? "the credentials were refused or cannot read it" : res.status === 404 ? "it does not exist" : `HTTP ${res.status}`;
  const reason = msg
    ? String(msg)
        .replace(/\s+/g, " ")
        .replace(/^\d+ errors? occurred: /, "")
        .trim()
        .slice(0, 160)
    : "";
  return new SecretFetchError(`${service}: ${what}: ${hint}${reason ? ` (${reason})` : ""}`);
}

const trimUrl = (url: string | undefined, fallback?: string) => (url?.trim() || fallback || "").replace(/\/+$/, "");

/* --------------------------------------------------------------------- Vault */

function vaultHeaders(c: ProviderClient) {
  return { "X-Vault-Token": c.credentials.token ?? "", ...(c.config.namespace ? { "X-Vault-Namespace": c.config.namespace } : {}) };
}

async function vaultSecret(c: ProviderClient, path: string): Promise<Record<string, unknown>> {
  const base = trimUrl(c.config.url);
  const mount = (c.config.mount || "secret").replace(/^\/+|\/+$/g, "");
  const clean = path.replace(/^\/+/, "");
  const v2 = (c.config.kvVersion ?? 2) === 2;
  const url = `${base}/v1/${mount}/${v2 ? "data/" : ""}${clean.split("/").map(encodeURIComponent).join("/")}`;
  const res = await send(url, { headers: vaultHeaders(c) }, c.allowPrivate);
  if (res.status !== 200) throw failure("Vault", res, `secret ${clean}`);
  const body = json(res.text) as { data?: { data?: Record<string, unknown> } & Record<string, unknown> };
  const data = v2 ? body.data?.data : body.data;
  if (!data || typeof data !== "object") throw new SecretFetchError(`Vault: secret ${clean} has no data. Is ${mount} a KV version ${v2 ? 2 : 1} mount?`);
  return data;
}

/* ----------------------------------------------------------------- Infisical */

async function infisicalToken(c: ProviderClient) {
  const base = trimUrl(c.config.url, "https://app.infisical.com");
  const res = await send(
    `${base}/api/v1/auth/universal-auth/login`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: c.credentials.clientId, clientSecret: c.credentials.clientSecret }) },
    c.allowPrivate,
  );
  if (res.status !== 200) throw failure("Infisical", res, "sign in");
  const token = json(res.text).accessToken;
  if (typeof token !== "string") throw new SecretFetchError("Infisical: sign in returned no access token.");
  return { base, token };
}

/** "folder/sub/NAME" → folder "/folder/sub" and secret "NAME". */
export function infisicalPath(path: string) {
  const parts = path.replace(/^\/+/, "").split("/");
  const name = parts.pop() ?? "";
  return { folder: `/${parts.join("/")}`, name };
}

/* ------------------------------------------------------------------- Doppler */

async function dopplerAll(c: ProviderClient): Promise<Record<string, string>> {
  const q = new URLSearchParams({ format: "json" });
  if (c.config.project) q.set("project", c.config.project);
  if (c.config.config) q.set("config", c.config.config);
  const res = await send(`https://api.doppler.com/v3/configs/config/secrets/download?${q}`, { headers: { authorization: `Bearer ${c.credentials.token}` } }, false);
  if (res.status !== 200) throw failure("Doppler", res, "secrets");
  return json(res.text) as Record<string, string>;
}

/* ----------------------------------------------------------------------- AWS */

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: crypto.BinaryLike, s: string) => crypto.createHmac("sha256", key).update(s, "utf8").digest();

/**
 * AWS Signature Version 4 for a request with a body. `amzDate` is YYYYMMDDTHHMMSSZ. Returns the
 * headers to send (host, x-amz-date, session token and authorization).
 */
export function signV4(opts: {
  method: string;
  host: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  amzDate: string;
}): Record<string, string> {
  const date = opts.amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...opts.headers, host: opts.host, "x-amz-date": opts.amzDate };
  if (opts.sessionToken) headers["x-amz-security-token"] = opts.sessionToken;
  const names = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]));
  const canonicalHeaders = names.map((k) => `${k}:${lower[k]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonical = [opts.method, opts.path, opts.query ?? "", canonicalHeaders, signedHeaders, sha256(opts.body)].join("\n");
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", opts.amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, date), opts.region), opts.service), "aws4_request");
  const signature = crypto.createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

async function awsCall(c: ProviderClient, service: "secretsmanager" | "ssm", target: string, payload: unknown) {
  const region = c.config.region?.trim() || "us-east-1";
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new SecretFetchError(`AWS: "${region}" is not a region name.`);
  const host = `${service}.${region}.amazonaws.com`;
  const body = JSON.stringify(payload);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const headers = signV4({
    method: "POST",
    host,
    path: "/",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": target },
    body,
    region,
    service,
    accessKeyId: c.credentials.accessKeyId ?? "",
    secretAccessKey: c.credentials.secretAccessKey ?? "",
    sessionToken: c.credentials.sessionToken || undefined,
    amzDate,
  });
  const { host: _host, ...sendHeaders } = headers;
  return send(`https://${host}/`, { method: "POST", headers: sendHeaders, body }, false);
}

/* -------------------------------------------------------------------- public */

/** Pick `field` from a secret with several values; without one, a secret with a single value gives it. */
function pick(data: Record<string, unknown>, field: string | null, where: string): string {
  if (field !== null) {
    if (!(field in data)) throw new SecretFetchError(`${where} has no field ${field}. Fields: ${Object.keys(data).join(", ") || "none"}.`);
    const v = data[field];
    return typeof v === "string" ? v : JSON.stringify(v);
  }
  const keys = Object.keys(data);
  if (keys.length === 1) {
    const v = data[keys[0]];
    return typeof v === "string" ? v : JSON.stringify(v);
  }
  throw new SecretFetchError(`${where} has several fields (${keys.join(", ")}). Name one after a colon, like ${where.split(" ").pop()}:${keys[0] ?? "FIELD"}.`);
}

/**
 * Fetch secrets of one provider. `refs` are `path` + optional `field`; the result maps
 * "path" or "path:field" to the value, or to an Error for that one reference.
 */
export async function fetchSecrets(c: ProviderClient, refs: { path: string; field: string | null }[]): Promise<Map<string, string | Error>> {
  const out = new Map<string, string | Error>();
  const keyOf = (r: { path: string; field: string | null }) => (r.field === null ? r.path : `${r.path}:${r.field}`);
  // A few requests at a time: a service with many references must not trip the provider's rate limit.
  const each = async (fn: (r: { path: string; field: string | null }) => Promise<string>) => {
    const queue = [...refs];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        try {
          out.set(keyOf(r), await fn(r));
        } catch (e) {
          out.set(keyOf(r), e instanceof SecretFetchError ? e : new SecretFetchError((e as Error).message));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, refs.length) }, worker));
  };

  if (c.kind === "vault") {
    const byPath = new Map<string, Promise<Record<string, unknown>>>();
    await each(async (r) => {
      if (!byPath.has(r.path)) byPath.set(r.path, vaultSecret(c, r.path));
      return pick(await (byPath.get(r.path) as Promise<Record<string, unknown>>), r.field, `Vault secret ${r.path}`);
    });
  } else if (c.kind === "infisical") {
    let auth: Promise<{ base: string; token: string }> | null = null;
    await each(async (r) => {
      auth ??= infisicalToken(c);
      const { base, token } = await auth;
      const { folder, name } = infisicalPath(r.path);
      const q = new URLSearchParams({ workspaceId: c.config.projectId ?? "", environment: c.config.environment ?? "", secretPath: folder });
      const res = await send(`${base}/api/v3/secrets/raw/${encodeURIComponent(name)}?${q}`, { headers: { authorization: `Bearer ${token}` } }, c.allowPrivate);
      if (res.status !== 200) throw failure("Infisical", res, `secret ${r.path}`);
      const value = (json(res.text).secret as { secretValue?: unknown } | undefined)?.secretValue;
      if (typeof value !== "string") throw new SecretFetchError(`Infisical: secret ${r.path} has no value.`);
      return value;
    });
  } else if (c.kind === "doppler") {
    let all: Promise<Record<string, string>> | null = null;
    await each(async (r) => {
      all ??= dopplerAll(c);
      const secrets = await all;
      if (!(r.path in secrets)) throw new SecretFetchError(`Doppler: there is no secret ${r.path} in this config.`);
      return secrets[r.path];
    });
  } else if (c.kind === "aws-secrets") {
    const byId = new Map<string, Promise<string>>();
    const getSecret = async (id: string) => {
      const res = await awsCall(c, "secretsmanager", "secretsmanager.GetSecretValue", { SecretId: id });
      if (res.status !== 200) throw failure("AWS Secrets Manager", res, `secret ${id}`);
      const str = json(res.text).SecretString;
      if (typeof str !== "string") throw new SecretFetchError(`AWS Secrets Manager: secret ${id} is binary; only text secrets can be used.`);
      return str;
    };
    await each(async (r) => {
      if (!byId.has(r.path)) byId.set(r.path, getSecret(r.path));
      const str = await (byId.get(r.path) as Promise<string>);
      if (r.field === null) return str;
      const parsed = json(str);
      if (!Object.keys(parsed).length) throw new SecretFetchError(`AWS Secrets Manager: secret ${r.path} is not JSON, so it has no field ${r.field}.`);
      return pick(parsed, r.field, `AWS secret ${r.path}`);
    });
  } else {
    await each(async (r) => {
      if (r.field !== null) throw new SecretFetchError(`AWS Parameter Store: parameters have no fields. Use ${r.path} without :${r.field}.`);
      const res = await awsCall(c, "ssm", "AmazonSSM.GetParameter", { Name: r.path, WithDecryption: true });
      if (res.status !== 200) throw failure("AWS Parameter Store", res, `parameter ${r.path}`);
      const value = (json(res.text).Parameter as { Value?: unknown } | undefined)?.Value;
      if (typeof value !== "string") throw new SecretFetchError(`AWS Parameter Store: parameter ${r.path} has no value.`);
      return value;
    });
  }
  return out;
}

/** Check the address and credentials without reading a particular secret. */
export async function testProvider(c: ProviderClient): Promise<string> {
  if (c.kind === "vault") {
    const res = await send(`${trimUrl(c.config.url)}/v1/auth/token/lookup-self`, { headers: vaultHeaders(c) }, c.allowPrivate);
    if (res.status !== 200) throw failure("Vault", res, "token");
    const ttl = (json(res.text).data as { ttl?: number } | undefined)?.ttl;
    return ttl ? `Connected. The token expires in ${Math.round(ttl / 3600)} hours; renew it before then.` : "Connected. The token does not expire.";
  }
  if (c.kind === "infisical") {
    const { base, token } = await infisicalToken(c);
    const q = new URLSearchParams({ workspaceId: c.config.projectId ?? "", environment: c.config.environment ?? "", secretPath: "/" });
    const res = await send(`${base}/api/v3/secrets/raw?${q}`, { headers: { authorization: `Bearer ${token}` } }, c.allowPrivate);
    if (res.status !== 200) throw failure("Infisical", res, "project secrets");
    const n = (json(res.text).secrets as unknown[] | undefined)?.length ?? 0;
    return `Connected. ${n} secret${n === 1 ? "" : "s"} in the root folder.`;
  }
  if (c.kind === "doppler") {
    const n = Object.keys(await dopplerAll(c)).length;
    return `Connected. ${n} secret${n === 1 ? "" : "s"} in this config.`;
  }
  const [service, target, label] =
    c.kind === "aws-secrets"
      ? (["secretsmanager", "secretsmanager.ListSecrets", "AWS Secrets Manager"] as const)
      : (["ssm", "AmazonSSM.DescribeParameters", "AWS Parameter Store"] as const);
  const res = await awsCall(c, service, target, { MaxResults: 1 });
  if (res.status === 200) return "Connected.";
  // A key allowed to read secrets but not to list them is the least-privilege setup: the
  // signature and keys were accepted.
  if (String(json(res.text).__type ?? "").endsWith("AccessDeniedException"))
    return "Connected. The key may not list secrets, which is fine: it only needs to read the ones you reference.";
  throw failure(label, res, "sign in");
}
