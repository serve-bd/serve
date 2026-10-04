import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));

const { commitStatusFor, providerState, readAnswer, reportCommitStatus, statusContext, statusRequest, CommitStatusRetry } = await import("@/server/git/commit-status");
type Deps = Parameters<typeof reportCommitStatus>[3] & object;
type Ctx = NonNullable<Awaited<ReturnType<Deps["load"]>>>;

const SHA = "a".repeat(40);

describe("deployment state on the commit", () => {
  it("maps every deployment state", () => {
    expect(commitStatusFor({ status: "waiting" })).toEqual({ state: "pending", description: "Waiting for approval" });
    expect(commitStatusFor({ status: "queued" })).toEqual({ state: "pending", description: "Waiting to build" });
    expect(commitStatusFor({ status: "building" })).toEqual({ state: "running", description: "Building" });
    expect(commitStatusFor({ status: "deploying" })).toEqual({ state: "running", description: "Deploying" });
    expect(commitStatusFor({ status: "success" })).toEqual({ state: "success", description: "Deployed" });
    expect(commitStatusFor({ status: "superseded" })).toEqual({ state: "cancelled", description: "Skipped, a newer commit deployed" });
    expect(commitStatusFor({ status: "cancelled" })).toEqual({ state: "cancelled", description: "Cancelled" });
    expect(commitStatusFor({ status: "cancelled", error: "Rejected by Ann." }).description).toBe("Rejected");
    expect(commitStatusFor({ status: "cancelled", error: "Deploys are frozen until Monday." }).description).toBe("Not deployed: Deploys are frozen until Monday.");
  });
  it("gives a failure its short reason: the first line, within GitHub's 140 characters", () => {
    expect(commitStatusFor({ status: "failed", error: "Build failed\n#12 npm ERR! missing script" }).description).toBe("Failed: Build failed");
    const long = commitStatusFor({ status: "failed", error: "x".repeat(500) }).description;
    expect(long.length).toBe(140);
    expect(long.endsWith("…")).toBe(true);
    expect(commitStatusFor({ status: "failed", error: null }).description).toBe("Failed");
  });
  it("speaks each provider's words", () => {
    expect(["pending", "running", "success", "failure", "cancelled"].map((s) => providerState("github", s as never))).toEqual([
      "pending",
      "pending",
      "success",
      "failure",
      "error",
    ]);
    expect(["pending", "running", "success", "failure", "cancelled"].map((s) => providerState("gitea", s as never))).toEqual(["pending", "pending", "success", "failure", "error"]);
    expect(["pending", "running", "success", "failure", "cancelled"].map((s) => providerState("gitlab", s as never))).toEqual([
      "pending",
      "running",
      "success",
      "failed",
      "canceled",
    ]);
    expect(["pending", "running", "success", "failure", "cancelled"].map((s) => providerState("bitbucket", s as never))).toEqual([
      "INPROGRESS",
      "INPROGRESS",
      "SUCCESSFUL",
      "FAILED",
      "STOPPED",
    ]);
  });
  it("names the check per service, environment and preview", () => {
    expect(statusContext("Serve", { name: "web", preview: false, environment: "production" })).toBe("Serve / web");
    expect(statusContext("Serve", { name: "web", preview: false, environment: "staging" })).toBe("Serve / web (staging)");
    expect(statusContext("Serve", { name: "web", preview: true, environment: "production" })).toBe("Serve / web (preview)");
  });
});

describe("provider requests", () => {
  const t = { repo: "acme/web", sha: SHA, context: "Serve / web", key: "serve-svc1", targetUrl: "https://serve.example.com/projects/p/services/s/deployments/d" };
  const ok = { state: "success" as const, description: "Deployed" };
  it("GitHub and GitHub Enterprise", () => {
    expect(statusRequest("github", { ...t, api: "https://api.github.com" }, ok)).toEqual({
      method: "POST",
      url: `https://api.github.com/repos/acme/web/statuses/${SHA}`,
      body: { state: "success", context: "Serve / web", description: "Deployed", target_url: t.targetUrl },
    });
    expect(statusRequest("github", { ...t, api: "https://ghe.example.com/api/v3" }, ok).url).toBe(`https://ghe.example.com/api/v3/repos/acme/web/statuses/${SHA}`);
  });
  it("GitLab: the project path url-encoded, the check as name", () => {
    const r = statusRequest("gitlab", { ...t, repo: "group/sub/web", api: "https://gitlab.com/api/v4" }, { state: "running", description: "Building" });
    expect(r.url).toBe(`https://gitlab.com/api/v4/projects/group%2Fsub%2Fweb/statuses/${SHA}`);
    expect(r.body).toEqual({ state: "running", name: "Serve / web", description: "Building", target_url: t.targetUrl });
  });
  it("Gitea and Forgejo", () => {
    const r = statusRequest("gitea", { ...t, api: "https://git.example.com/api/v1" }, { state: "cancelled", description: "Cancelled" });
    expect(r.url).toBe(`https://git.example.com/api/v1/repos/acme/web/statuses/${SHA}`);
    expect(r.body).toMatchObject({ state: "error", context: "Serve / web" });
  });
  it("Bitbucket: a stable key, and a link even without a public dashboard", () => {
    const r = statusRequest("bitbucket", { ...t, api: "https://api.bitbucket.org/2.0" }, { state: "failure", description: "Failed: boom" });
    expect(r.url).toBe(`https://api.bitbucket.org/2.0/repositories/acme/web/commit/${SHA}/statuses/build`);
    expect(r.body).toEqual({ key: "serve-svc1", state: "FAILED", name: "Serve / web", description: "Failed: boom", url: t.targetUrl });
    expect(statusRequest("bitbucket", { ...t, targetUrl: null, api: "x" }, ok).body.url).toBe(`https://bitbucket.org/acme/web/commits/${SHA}`);
  });
  it("leaves the link out when the dashboard is not public", () => {
    expect(statusRequest("github", { ...t, targetUrl: null, api: "a" }, ok).body).not.toHaveProperty("target_url");
    expect(statusRequest("gitlab", { ...t, targetUrl: null, api: "a" }, ok).body).not.toHaveProperty("target_url");
  });
});

describe("provider answers", () => {
  it("reads refusals as missing permission", () => {
    expect(readAnswer("github-app", { status: 403, text: '{"message":"Resource not accessible by integration"}' })).toMatchObject({
      ok: false,
      permission: true,
      message: expect.stringContaining("Commit statuses permission"),
    });
    expect(readAnswer("github", { status: 404, text: "" })).toMatchObject({ permission: true });
    expect(readAnswer("gitlab", { status: 401, text: "" })).toMatchObject({ permission: true });
  });
  it("retries only what may pass later", () => {
    expect(readAnswer("github", { status: 502, text: "" })).toMatchObject({ ok: false, permission: false, retry: true });
    expect(readAnswer("github", { status: 429, text: "" })).toMatchObject({ retry: true });
    expect(readAnswer("github", { status: 422, text: '{"message":"No commit found for SHA"}' })).toEqual({
      ok: false,
      permission: false,
      retry: false,
      message: "GitHub answered HTTP 422: No commit found for SHA",
    });
  });
  it("takes GitLab's refusal of a repeated state as done", () => {
    expect(readAnswer("gitlab", { status: 400, text: '{"message":"Cannot transition status via :run from :running"}' })).toEqual({ ok: true });
  });
});

function setup(over: { deployment?: Partial<Ctx["deployment"]>; service?: Partial<Ctx["service"]>; credential?: Partial<NonNullable<Ctx["credential"]>> | null } = {}) {
  const ctx: Ctx = {
    deployment: { id: "dep1", status: "success", error: null, commitSha: SHA, rollbackOf: null, upload: null, ...over.deployment },
    service: {
      id: "svc1",
      name: "web",
      projectId: "p1",
      preview: false,
      environment: "production",
      source: { type: "git", repository: "https://github.com/acme/web.git", branch: "main", credentialId: "cred1" },
      enabled: true,
      ...over.service,
    },
    credential:
      over.credential === null
        ? null
        : ({ id: "cred1", provider: "github", baseUrl: null, oauthAppId: null, organizationId: "org1", ...over.credential } as NonNullable<Ctx["credential"]>),
  };
  const calls = { sent: [] as { url: string; body: unknown; headers: Record<string, string> }[], logs: [] as string[], blocks: [] as string[] };
  let answers: { status: number; text: string }[] = [{ status: 201, text: "{}" }];
  let blocked: { message: string; until: number } | null = null;
  const deps: Deps = {
    load: async () => ctx,
    blocked: async () => blocked,
    block: async (_id, message) => void calls.blocks.push(message),
    log: async (_id, message) => void calls.logs.push(message),
    token: async () => ({ value: "tok", refresh: async () => "fresh" }),
    send: async (req, headers) => {
      calls.sent.push({ url: req.url, body: req.body, headers });
      const a = answers.shift() ?? { status: 201, text: "" };
      if (a.status === 0) throw new Error("connect ETIMEDOUT");
      return a;
    },
    baseUrl: async () => "https://serve.example.com",
    product: async () => "Serve",
  };
  return {
    ctx,
    calls,
    deps,
    answer: (...a: { status: number; text: string }[]) => (answers = a),
    block: (b: typeof blocked) => (blocked = b),
  };
}

describe("reporting a deployment", () => {
  it("sends the deployment's state with a link to it", async () => {
    const s = setup();
    expect(await reportCommitStatus("dep1", "success", {}, s.deps)).toBe("sent");
    expect(s.calls.sent).toHaveLength(1);
    expect(s.calls.sent[0].url).toBe(`https://api.github.com/repos/acme/web/statuses/${SHA}`);
    expect(s.calls.sent[0].body).toEqual({
      state: "success",
      context: "Serve / web",
      description: "Deployed",
      target_url: "https://serve.example.com/projects/p1/services/svc1/deployments/dep1",
    });
    expect(s.calls.sent[0].headers.authorization).toBe("Bearer tok");
  });
  it("never sends an older state: a job queued for it is stale once the deployment moved on", async () => {
    const s = setup({ deployment: { status: "success" } });
    expect(await reportCommitStatus("dep1", "building", {}, s.deps)).toBe("stale");
    expect(s.calls.sent).toHaveLength(0);
  });
  it("skips what has nothing to report on", async () => {
    for (const over of [
      { credential: null },
      { credential: { provider: "ssh" as const } },
      { deployment: { commitSha: null } },
      { deployment: { commitSha: "abc1234" } },
      { deployment: { rollbackOf: "dep0" } },
      { deployment: { upload: { archive: "x" } } },
      { service: { enabled: false } },
      { service: { source: { type: "image", image: "nginx" } } },
    ]) {
      const s = setup(over);
      expect(await reportCommitStatus("dep1", "success", {}, s.deps)).toBe("skipped");
      expect(s.calls.sent).toHaveLength(0);
    }
  });
  it("uses each provider's API and token header", async () => {
    const gl = setup({ credential: { provider: "gitlab" }, service: { source: { type: "git", repository: "https://gitlab.com/acme/web.git", branch: "main" } } });
    await reportCommitStatus("dep1", undefined, {}, gl.deps);
    expect(gl.calls.sent[0].url).toBe(`https://gitlab.com/api/v4/projects/acme%2Fweb/statuses/${SHA}`);
    expect(gl.calls.sent[0].headers["PRIVATE-TOKEN"]).toBe("tok");
    const oauth = setup({
      credential: { provider: "gitlab", oauthAppId: "app1" },
      service: { source: { type: "git", repository: "https://gitlab.com/acme/web.git", branch: "main" } },
    });
    await reportCommitStatus("dep1", undefined, {}, oauth.deps);
    expect(oauth.calls.sent[0].headers.authorization).toBe("Bearer tok");
    const gt = setup({
      credential: { provider: "gitea", baseUrl: "https://git.example.com" },
      service: { source: { type: "git", repository: "https://git.example.com/acme/web.git", branch: "main" } },
    });
    await reportCommitStatus("dep1", undefined, {}, gt.deps);
    expect(gt.calls.sent[0].url).toBe(`https://git.example.com/api/v1/repos/acme/web/statuses/${SHA}`);
    expect(gt.calls.sent[0].headers.authorization).toBe("token tok");
    const bb = setup({ credential: { provider: "bitbucket" }, service: { source: { type: "git", repository: "https://bitbucket.org/acme/web.git", branch: "main" } } });
    await reportCommitStatus("dep1", undefined, {}, bb.deps);
    expect(bb.calls.sent[0].url).toBe(`https://api.bitbucket.org/2.0/repositories/acme/web/commit/${SHA}/statuses/build`);
    expect(bb.calls.sent[0].body).toMatchObject({ key: "serve-svc1", state: "SUCCESSFUL" });
    const ghe = setup({
      credential: { baseUrl: "https://ghe.example.com" },
      service: { source: { type: "git", repository: "https://ghe.example.com/acme/web.git", branch: "main" } },
    });
    await reportCommitStatus("dep1", undefined, {}, ghe.deps);
    expect(ghe.calls.sent[0].url).toBe(`https://ghe.example.com/api/v3/repos/acme/web/statuses/${SHA}`);
  });
  it("omits the link when the dashboard has no public address", async () => {
    const s = setup();
    s.deps.baseUrl = async () => null;
    await reportCommitStatus("dep1", undefined, {}, s.deps);
    expect(s.calls.sent[0].body).not.toHaveProperty("target_url");
  });
  it("remembers a refusal for the credential and says so in the deployment log", async () => {
    const s = setup({ credential: { provider: "github-app" } });
    s.answer({ status: 403, text: '{"message":"Resource not accessible by integration"}' }, { status: 403, text: "" });
    expect(await reportCommitStatus("dep1", undefined, {}, s.deps)).toBe("refused");
    // The app's token was made fresh once: it may predate the accepted permission.
    expect(s.calls.sent).toHaveLength(2);
    expect(s.calls.sent[1].headers.authorization).toBe("Bearer fresh");
    expect(s.calls.blocks[0]).toMatch(/Commit statuses permission/);
    expect(s.calls.logs[0]).toMatch(/Commit statuses permission/);
  });
  it("does not ask again while the refusal is remembered", async () => {
    const s = setup();
    s.block({ message: "GitHub refused the status: the token needs the repo:status scope", until: Date.now() + 60_000 });
    expect(await reportCommitStatus("dep1", undefined, {}, s.deps)).toBe("blocked");
    expect(s.calls.sent).toHaveLength(0);
    expect(s.calls.logs[0]).toMatch(/repo:status/);
  });
  it("tries an OAuth token again once after a 401", async () => {
    const s = setup({
      credential: { provider: "gitlab", oauthAppId: "app1" },
      service: { source: { type: "git", repository: "https://gitlab.com/acme/web.git", branch: "main" } },
    });
    s.answer({ status: 401, text: "" }, { status: 201, text: "" });
    expect(await reportCommitStatus("dep1", undefined, {}, s.deps)).toBe("sent");
    expect(s.calls.sent[1].headers.authorization).toBe("Bearer fresh");
  });
  it("retries a provider that is down, and logs it on the last try", async () => {
    const s = setup();
    s.answer({ status: 503, text: "" });
    await expect(reportCommitStatus("dep1", undefined, {}, s.deps)).rejects.toBeInstanceOf(CommitStatusRetry);
    expect(s.calls.logs).toHaveLength(0);
    s.answer({ status: 0, text: "" });
    expect(await reportCommitStatus("dep1", undefined, { last: true }, s.deps)).toBe("failed");
    expect(s.calls.logs[0]).toMatch(/No answer from the provider: connect ETIMEDOUT/);
    expect(s.calls.blocks).toHaveLength(0);
  });
  it("logs a missing token without retrying", async () => {
    const s = setup({ credential: { provider: "github-app" } });
    s.deps.token = async () => {
      throw new Error("The GitHub App is not installed yet.");
    };
    expect(await reportCommitStatus("dep1", undefined, {}, s.deps)).toBe("failed");
    expect(s.calls.logs).toEqual(["The GitHub App is not installed yet."]);
  });
  it("reports a preview under its app's name", async () => {
    const s = setup({ service: { preview: true } });
    await reportCommitStatus("dep1", undefined, {}, s.deps);
    expect(s.calls.sent[0].body).toMatchObject({ context: "Serve / web (preview)" });
  });
});
