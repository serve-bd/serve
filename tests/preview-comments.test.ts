import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Rows the next db.select() calls answer, in order; inserts are counted.
const state = vi.hoisted(() => ({ selects: [] as unknown[][], inserts: 0 }));
const cf = vi.hoisted(() => ({ zoneFor: vi.fn(), upsertARecord: vi.fn(), upsertTunnelRecord: vi.fn() }));
vi.mock("@/server/db", () => {
  const any: unknown = new Proxy({}, { get: () => any });
  return {
    db: {
      select: () => ({ from: () => ({ where: async () => state.selects.shift() ?? [] }) }),
      insert: () => {
        state.inserts++;
        return { values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }) };
      },
    },
    schema: any,
  };
});
vi.mock("@/server/settings", () => ({ getSetting: async () => "org-root" }));
vi.mock("@/server/git/oauth", () => ({ credentialToken: async () => "SECRET-TOKEN", withCredentialToken: vi.fn() }));
vi.mock("@/server/git/github-app", () => ({ installationToken: async () => "APP-TOKEN" }));
vi.mock("@/server/servers/access", () => ({ serverPublicIp: async () => "203.0.113.7" }));
vi.mock("@/server/cloudflare/api", () => ({ Cloudflare: { forAccount: async () => cf } }));
// The instance's secret tag in the marker, fixed here.
vi.mock("@/server/crypto", async (real) => ({ ...(await real<typeof import("@/server/crypto")>()), hmac: () => "f".repeat(64) }));

const { upsertPreviewComment } = await import("@/server/git/pr-comments");
const PREVIEW_MARKER = `<!-- serve-preview ${"f".repeat(24)} -->`;
const BITBUCKET_MARKER = `[//]: # (serve-preview ${"f".repeat(24)})`;
const { addPreviewDomain, commentOnPullRequest, previewCommentBody } = await import("@/server/services/previews");

type Cred = Parameters<typeof upsertPreviewComment>[0];
const cred = (provider: string, baseUrl: string | null = null, extra: Partial<Cred> = {}) =>
  ({ id: "c1", organizationId: "org-root", oauthAppId: null, name: "x", provider, secret: "enc", publicInfo: null, baseUrl, ...extra }) as Cred;

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[];
let answers: { status: number; body: unknown }[];

beforeEach(() => {
  calls = [];
  answers = [];
  state.selects = [];
  state.inserts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
      const a = answers.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(a.body), { status: a.status });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("preview comment per provider", () => {
  it("GitLab (self-hosted): makes a merge request note, then edits it", async () => {
    const c = cred("gitlab", "https://git.example.com/");
    answers = [
      { status: 200, body: [{ id: 1, body: "hi", system: false }] },
      { status: 201, body: {} },
    ];
    expect(await upsertPreviewComment(c, "https://git.example.com/group/sub/app.git", 12, "Body", { create: true })).toBe("created");
    const notes = "https://git.example.com/api/v4/projects/group%2Fsub%2Fapp/merge_requests/12/notes";
    expect(calls[0]).toMatchObject({ url: `${notes}?per_page=100&order_by=created_at&sort=asc`, method: "GET" });
    expect(calls[1]).toMatchObject({ url: notes, method: "POST", body: { body: `${PREVIEW_MARKER}\nBody` } });
    expect(calls[1].headers["PRIVATE-TOKEN"]).toBe("SECRET-TOKEN");

    calls = [];
    answers = [
      { status: 200, body: [{ id: 9, body: `${PREVIEW_MARKER}\nold`, system: false }] },
      { status: 200, body: {} },
    ];
    expect(await upsertPreviewComment(c, "https://git.example.com/group/sub/app.git", 12, "New", { create: true })).toBe("updated");
    expect(calls[1]).toMatchObject({ url: `${notes}/9`, method: "PUT", body: { body: `${PREVIEW_MARKER}\nNew` } });
  });

  it("GitLab through OAuth sends a Bearer token", async () => {
    answers = [{ status: 200, body: [] }];
    await upsertPreviewComment(cred("gitlab", null, { oauthAppId: "app" }), "https://gitlab.com/o/r.git", 3, "B", { create: true });
    expect(calls[0].url.startsWith("https://gitlab.com/api/v4/projects/o%2Fr/")).toBe(true);
    expect(calls[0].headers.authorization).toBe("Bearer SECRET-TOKEN");
  });

  it("Gitea/Forgejo: makes an issue comment, then edits it", async () => {
    const c = cred("gitea", "https://forgejo.example.org");
    answers = [
      { status: 200, body: [] },
      { status: 201, body: {} },
    ];
    expect(await upsertPreviewComment(c, "https://forgejo.example.org/o/r.git", 5, "Body", { create: true })).toBe("created");
    expect(calls[0]).toMatchObject({ url: "https://forgejo.example.org/api/v1/repos/o/r/issues/5/comments", method: "GET" });
    expect(calls[1]).toMatchObject({ url: "https://forgejo.example.org/api/v1/repos/o/r/issues/5/comments", method: "POST", body: { body: `${PREVIEW_MARKER}\nBody` } });
    expect(calls[1].headers.authorization).toBe("token SECRET-TOKEN");

    calls = [];
    answers = [
      { status: 200, body: [{ id: 44, body: `x ${PREVIEW_MARKER}` }] },
      { status: 200, body: {} },
    ];
    expect(await upsertPreviewComment(c, "https://forgejo.example.org/o/r.git", 5, "New", { create: true })).toBe("updated");
    expect(calls[1]).toMatchObject({ url: "https://forgejo.example.org/api/v1/repos/o/r/issues/comments/44", method: "PATCH", body: { body: `${PREVIEW_MARKER}\nNew` } });
  });

  it("Bitbucket Cloud: makes a pull request comment with an invisible marker, then edits it", async () => {
    const c = cred("bitbucket");
    answers = [
      { status: 200, body: { values: [] } },
      { status: 201, body: {} },
    ];
    expect(await upsertPreviewComment(c, "https://bitbucket.org/ws/repo.git", 8, "Body", { create: true })).toBe("created");
    const comments = "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/8/comments";
    expect(calls[0]).toMatchObject({ url: `${comments}?pagelen=100`, method: "GET" });
    expect(calls[1]).toMatchObject({ url: comments, method: "POST", body: { content: { raw: `${BITBUCKET_MARKER}\nBody` } } });
    expect(calls[1].headers.authorization).toBe("Bearer SECRET-TOKEN");

    calls = [];
    const mine = { id: 70, content: { raw: `${BITBUCKET_MARKER}\nold` } };
    answers = [
      { status: 200, body: { values: [{ ...mine, id: 69, deleted: true }, mine] } },
      { status: 200, body: {} },
    ];
    expect(await upsertPreviewComment(c, "https://bitbucket.org/ws/repo.git", 8, "New", { create: true })).toBe("updated");
    expect(calls[1]).toMatchObject({ url: `${comments}/70`, method: "PUT", body: { content: { raw: `${BITBUCKET_MARKER}\nNew` } } });
  });

  it("GitHub keeps its issue comments", async () => {
    answers = [
      { status: 200, body: [{ id: 3, body: PREVIEW_MARKER }] },
      { status: 200, body: {} },
    ];
    await upsertPreviewComment(cred("github-app"), "o/r", 4, "B", { create: true });
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/4/comments?per_page=100");
    expect(calls[1]).toMatchObject({ url: "https://api.github.com/repos/o/r/issues/comments/3", method: "PATCH" });
    expect(calls[1].headers.authorization).toBe("Bearer APP-TOKEN");
  });

  it("never edits someone else's comment that copies the marker anyone can read in the source", async () => {
    answers = [
      {
        status: 200,
        body: [
          { id: 8, body: "<!-- serve-preview -->\nmine now" },
          { id: 9, body: "<!-- serve-preview 0123456789abcdef01234567 -->" },
        ],
      },
      { status: 201, body: {} },
    ];
    expect(await upsertPreviewComment(cred("github-app"), "o/r", 4, "B", { create: true })).toBe("created");
    expect(calls[1]).toMatchObject({ url: "https://api.github.com/repos/o/r/issues/4/comments", method: "POST" });
  });

  it("on teardown only edits: no comment is made when there was none", async () => {
    answers = [{ status: 200, body: [] }];
    expect(await upsertPreviewComment(cred("gitea", "https://g.example"), "https://g.example/o/r", 5, "gone", { create: false })).toBe("none");
    expect(calls).toHaveLength(1);
  });

  it("a refusal throws a message without the token, and never calls another host", async () => {
    answers = [{ status: 403, body: { message: "SECRET-TOKEN is not allowed" } }];
    const err = await upsertPreviewComment(cred("gitlab", "https://git.example.com"), "https://git.example.com/o/r.git", 1, "B", { create: true }).catch((e: Error) => e);
    expect(String(err)).toContain("GitLab answered HTTP 403");
    expect(String(err)).not.toContain("SECRET-TOKEN");
    expect(calls.every((c) => c.url.startsWith("https://git.example.com/"))).toBe(true);
  });

  it("only calls the credential's host, whatever host the repository URL names", async () => {
    answers = [
      { status: 200, body: [] },
      { status: 201, body: {} },
    ];
    await upsertPreviewComment(cred("gitea", "https://g.example"), "https://evil.example/o/r.git", 1, "B", { create: true });
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["g.example", "g.example"]);
  });

  it("refuses a repository path it cannot read, before any request", async () => {
    await expect(upsertPreviewComment(cred("gitea", "https://g.example"), "https://g.example/../x", 1, "B", { create: true })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("commentOnPullRequest", () => {
  const parent = { id: "svc", name: "web", source: { type: "git", credentialId: "c1", repository: "https://gitlab.com/o/r.git" } } as never;

  it("logs a failure and never throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    state.selects = [[cred("gitlab")]];
    answers = [{ status: 500, body: {} }];
    await expect(commentOnPullRequest(parent, { number: 2, sha: null }, { url: "https://x.example" })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("GitLab answered HTTP 500"));
    expect(String(error.mock.calls)).not.toContain("SECRET-TOKEN");
    error.mockRestore();
  });

  it("neutralizes user-controlled text in the comment", () => {
    const body = previewCommentBody("we`b\n# @everyone [x](http://evil)", "<script>", { url: "https://pr-1.example.com" });
    expect(body).toContain("`we b # @everyone [x](http://evil)`");
    expect(body).toContain("Commit `latest`");
    expect(body.split("\n").some((l) => l.startsWith("#"))).toBe(false);
  });
});

describe("preview DNS record failure", () => {
  const parent = { id: "p", serverId: "srv", projectId: "proj", previewDomain: "pr-{pr}.example.com" } as never;

  it("adds no address that cannot resolve, and says why", async () => {
    // Name not taken; the app's own domain has a Cloudflare A record.
    state.selects = [[], [{ id: "d", tunnelId: null, cloudflareAccountId: "cfa", cloudflareRecordId: "rec", https: true, generated: false, redirectTo: null }]];
    cf.zoneFor.mockResolvedValue({ id: "zone" });
    cf.upsertARecord.mockRejectedValue(new Error("pr-7.example.com already has a CNAME record (elsewhere.example). Remove it in Cloudflare first."));
    const result = await addPreviewDomain(parent, "preview", 7);
    expect(result).toEqual({
      added: false,
      dnsProblem:
        "The DNS record for pr-7.example.com could not be created in Cloudflare: pr-7.example.com already has a CNAME record (elsewhere.example). Remove it in Cloudflare first.",
    });
    expect(state.inserts).toBe(0);
  });

  it("the comment shows the problem, not the address as working", () => {
    const body = previewCommentBody("web", "a".repeat(40), { url: "https://web-pr7.serve.example", dnsProblem: "The DNS record for pr-7.example.com could not be created" });
    expect(body).toContain("⚠️ `The DNS record for pr-7.example.com could not be created`");
    expect(body).toContain("Until then the preview answers at https://web-pr7.serve.example");
    expect(body).not.toContain("🔗");
    expect(previewCommentBody("web", null, { url: null, dnsProblem: "x" })).toContain("Until then the preview has no address.");
  });
});
