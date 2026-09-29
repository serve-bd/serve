import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// Modules read these at import time; no database connection is made.
process.env.BETTER_AUTH_SECRET = "test-secret-for-git-webhooks";
process.env.DATABASE_URL = "postgres://test@127.0.0.1:1/test";
const { verifyWebhookSignature } = await import("@/server/git/signature");
const { parsePullRequest, parsePush } = await import("@/server/git/events");
const { createHookRequest, deleteHookRequest, repoPath } = await import("@/server/git/repo-webhooks");
const { authorizeUrl, exchangeCode, refreshTokens, redirectUri, signOAuthState, verifyOAuthState } = await import("@/server/git/oauth");
const { authHeaders } = await import("@/server/git/providers");
const { withToken } = await import("@/server/deploy/git");
const { encrypt } = await import("@/server/crypto");

const secret = "s3cret";
const body = JSON.stringify({ ref: "refs/heads/main" });
const hex = crypto.createHmac("sha256", secret).update(body).digest("hex");
const h = (o: Record<string, string>) => new Headers(o);

describe("webhook signatures", () => {
  it("accepts each provider's signing scheme", () => {
    expect(verifyWebhookSignature(h({ "x-hub-signature-256": `sha256=${hex}` }), body, secret)).toBe(true);
    expect(verifyWebhookSignature(h({ "x-gitea-signature": hex }), body, secret)).toBe(true);
    expect(verifyWebhookSignature(h({ "x-gitlab-token": secret }), body, secret)).toBe(true);
    expect(verifyWebhookSignature(h({ "x-event-key": "repo:push", "x-hub-signature": `sha256=${hex}` }), body, secret)).toBe(true);
    expect(verifyWebhookSignature(h({}), body, secret, secret)).toBe(true);
  });

  it("rejects wrong or missing signatures", () => {
    expect(verifyWebhookSignature(h({ "x-gitea-signature": hex.replace(/.$/, "0") }), body, secret)).toBe(false);
    expect(verifyWebhookSignature(h({ "x-gitlab-token": "nope" }), body, secret)).toBe(false);
    // GitHub's sha1 X-Hub-Signature without X-Event-Key is not Bitbucket.
    expect(verifyWebhookSignature(h({ "x-hub-signature": `sha256=${hex}` }), body, secret)).toBe(false);
    expect(verifyWebhookSignature(h({}), body, secret)).toBe(false);
  });
});

describe("event parsing", () => {
  it("reads Bitbucket pushes and pull requests", () => {
    const push = parsePush(h({ "x-event-key": "repo:push" }), {
      push: { changes: [{ new: { name: "main", target: { hash: "abc123", message: "Fix\n", author: { raw: "Ann <a@x>" } } } }] },
    });
    expect(push).toMatchObject({ branch: "main", sha: "abc123", message: "Fix", author: "Ann <a@x>" });
    expect(parsePush(h({ "x-event-key": "diagnostics:ping" }), {})).toBe("ping");

    const pr = {
      pullrequest: {
        id: 7,
        title: "Feature",
        author: { nickname: "ann" },
        source: { branch: { name: "feat" }, commit: { hash: "def" }, repository: { full_name: "team/app" } },
        destination: { repository: { full_name: "team/app" } },
      },
    };
    expect(parsePullRequest(h({ "x-event-key": "pullrequest:created" }), pr)).toMatchObject({
      action: "deploy",
      pr: { number: 7, branch: "feat", sha: "def", repository: "https://bitbucket.org/team/app.git", fullName: "team/app" },
    });
    expect(parsePullRequest(h({ "x-event-key": "pullrequest:fulfilled" }), pr)?.action).toBe("close");
    const fork = { pullrequest: { ...pr.pullrequest, source: { ...pr.pullrequest.source, repository: { full_name: "evil/app" } } } };
    expect(parsePullRequest(h({ "x-event-key": "pullrequest:updated" }), fork)?.action).toBe("fork");
  });

  it("reads Gitea and GitLab events", () => {
    const gitea = parsePush(h({ "x-gitea-event": "push" }), { ref: "refs/heads/main", head_commit: { id: "1a", message: "msg\nbody", author: { name: "Bo" } } });
    expect(gitea).toMatchObject({ branch: "main", sha: "1a", message: "msg", author: "Bo" });
    const mr = parsePullRequest(h({ "x-gitlab-event": "Merge Request Hook" }), {
      object_attributes: { iid: 3, action: "open", title: "T", source_branch: "b", last_commit: { id: "9" }, source_project_id: 1, target_project_id: 1 },
    });
    expect(mr).toMatchObject({ action: "deploy", pr: { number: 3, branch: "b", sha: "9" } });
  });
});

describe("repository webhooks", () => {
  it("reads repository paths from clone URLs", () => {
    expect(repoPath("https://gitlab.com/group/sub/app.git")).toBe("group/sub/app");
    expect(repoPath("git@gitea.example.com:team/app.git")).toBe("team/app");
    expect(repoPath("ssh://git@host:2222/team/app.git")).toBe("team/app");
    expect(repoPath("https://git.example.com/gitea/team/app.git", "https://git.example.com/gitea")).toBe("team/app");
    expect(() => repoPath("https://example.com/")).toThrow();
  });

  it("builds provider hook requests", () => {
    const url = "https://serve.example.com/api/webhooks/git/svc";
    const gl = createHookRequest("gitlab", "https://gitlab.com/api/v4", "group/app", url, secret);
    expect(gl.url).toBe("https://gitlab.com/api/v4/projects/group%2Fapp/hooks");
    expect(gl.body).toMatchObject({ url, token: secret, push_events: true, merge_requests_events: true, enable_ssl_verification: true });
    const gt = createHookRequest("gitea", "https://git.x/api/v1", "team/app", url, secret);
    expect(gt.body).toMatchObject({ type: "gitea", events: ["push", "pull_request"], config: { url, secret, content_type: "json" } });
    const bb = createHookRequest("bitbucket", "https://api.bitbucket.org/2.0", "ws/app", url, secret);
    expect(bb.url).toBe("https://api.bitbucket.org/2.0/repositories/ws/app/hooks");
    expect(bb.body).toMatchObject({ secret, events: expect.arrayContaining(["repo:push", "pullrequest:created"]) });
    expect(createHookRequest("bitbucket", "https://api.bitbucket.org/2.0", "ws/app", url, secret, "Acme Cloud").body).toMatchObject({ description: "Acme Cloud" });
    const gh = createHookRequest("github", "https://api.github.com", "o/r", url, secret);
    expect(gh.body).toMatchObject({ name: "web", config: { url, secret } });
    expect(deleteHookRequest("bitbucket", "https://api.bitbucket.org/2.0", "ws/app", "{abc}").url).toBe("https://api.bitbucket.org/2.0/repositories/ws/app/hooks/%7Babc%7D");
    expect(deleteHookRequest("gitlab", "https://gitlab.com/api/v4", "g/a", "12").url).toBe("https://gitlab.com/api/v4/projects/g%2Fa/hooks/12");
  });
});

describe("oauth", () => {
  afterEach(() => vi.unstubAllGlobals());
  const app = {
    id: "a1",
    organizationId: "o1",
    provider: "gitlab" as const,
    name: "GitLab",
    baseUrl: null,
    clientId: "cid",
    clientSecret: encrypt("csecret"),
    groupPath: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("builds authorize URLs", () => {
    const redirect = redirectUri("https://serve.example.com/", "gitlab");
    expect(redirect).toBe("https://serve.example.com/api/git/oauth/gitlab/callback");
    const gl = new URL(authorizeUrl(app, redirect, "st"));
    expect(gl.origin + gl.pathname).toBe("https://gitlab.com/oauth/authorize");
    expect(Object.fromEntries(gl.searchParams)).toMatchObject({
      client_id: "cid",
      redirect_uri: redirect,
      response_type: "code",
      state: "st",
      scope: "api read_user read_repository",
    });
    const gt = new URL(authorizeUrl({ ...app, provider: "gitea", baseUrl: "https://git.x/" }, redirect, "st"));
    expect(gt.origin + gt.pathname).toBe("https://git.x/login/oauth/authorize");
    const bb = new URL(authorizeUrl({ ...app, provider: "bitbucket" }, redirect, "st"));
    expect(bb.origin + bb.pathname).toBe("https://bitbucket.org/site/oauth2/authorize");
    expect(bb.searchParams.has("redirect_uri")).toBe(false);
  });

  it("exchanges codes and refreshes tokens", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 7200 }), { status: 200 });
    });
    const t = await exchangeCode(app, "code1", "https://s/cb");
    expect(t).toMatchObject({ accessToken: "at", refreshToken: "rt" });
    expect(t.expiresAt! - Date.now()).toBeGreaterThan(7000_000);
    expect(calls[0].url).toBe("https://gitlab.com/oauth/token");
    const form = new URLSearchParams(calls[0].init.body as URLSearchParams);
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: "authorization_code", code: "code1", redirect_uri: "https://s/cb", client_id: "cid", client_secret: "csecret" });

    await refreshTokens({ ...app, provider: "bitbucket" }, "rt");
    expect(calls[1].url).toBe("https://bitbucket.org/site/oauth2/access_token");
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("cid:csecret").toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(calls[1].init.body as URLSearchParams))).toEqual({ grant_type: "refresh_token", refresh_token: "rt" });
  });

  it("reports provider errors", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "The code expired." }), { status: 400 }));
    await expect(exchangeCode(app, "x", "https://s/cb")).rejects.toThrow("The code expired.");
  });

  it("signs state and uses Bearer headers for OAuth tokens", () => {
    const st = signOAuthState({ appId: "a1", organizationId: "o1", userId: "u1" });
    expect(verifyOAuthState(st)).toMatchObject({ appId: "a1" });
    expect(verifyOAuthState(st.replace(/.$/, "x"))).toBeNull();
    expect(authHeaders("gitlab", "t", { oauth: true })).toEqual({ authorization: "Bearer t" });
    expect(authHeaders("gitlab", "t")).toEqual({ "PRIVATE-TOKEN": "t" });
  });

  it("puts tokens in clone URLs", () => {
    expect(withToken("https://gitlab.com/g/a.git", "gitlab", "tok")).toBe("https://oauth2:tok@gitlab.com/g/a.git");
    expect(withToken("https://bitbucket.org/w/a.git", "bitbucket", "tok")).toBe("https://x-token-auth:tok@bitbucket.org/w/a.git");
    expect(withToken("https://git.x/t/a.git", "gitea", "tok")).toBe("https://oauth2:tok@git.x/t/a.git");
  });
});
