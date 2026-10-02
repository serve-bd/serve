import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
vi.mock("@/server/settings", () => ({ getSetting: async () => "root-org" }));
const addresses: Record<string, string | null> = { "git.example.com": "203.0.113.9", "internal.example.com": null, "[2001:db8::1]": "2001:db8::1" };
vi.mock("@/server/net/public-host", () => ({ publicAddress: async (h: string) => addresses[h] ?? null }));
const requests: { url: string; headers?: Record<string, string> }[] = [];
const answers: Record<string, { status: number; headers: Record<string, string> }> = {};
vi.mock("@/server/net/public-fetch", () => ({
  publicRequest: async (url: string, opts: { headers?: Record<string, string> }) => {
    requests.push({ url, headers: opts.headers });
    return { ...(answers[url] ?? { status: 200, headers: {} }), text: "" };
  },
}));

const { followMove, gitAccess, tokenConfig } = await import("@/server/deploy/git");
const src = (repository: string) => ({ type: "git" as const, repository, branch: "main" });

describe("git servers of other organizations", () => {
  it("connects to the public address checked when connecting", async () => {
    const a = await gitAccess(src("https://git.example.com/team/app.git"), "/tmp/x", "org-1");
    expect(a.gitEnv.GIT_CONFIG_KEY_0).toBe("http.curloptResolve");
    expect(a.gitEnv.GIT_CONFIG_VALUE_0).toBe("git.example.com:443:203.0.113.9");
    expect(a.gitEnv.GIT_CONFIG_KEY_1).toBe("http.followRedirects");
    expect(a.gitEnv.GIT_CONFIG_VALUE_1).toBe("false");
    expect(a.gitEnv.GIT_CONFIG_COUNT).toBe("2");
  });
  it("takes a move on the same server only, asking with the repository's token", async () => {
    const info = "/info/refs?service=git-upload-pack";
    answers[`https://git.example.com/old/app.git${info}`] = { status: 301, headers: { location: `/new/app.git${info}` } };
    answers[`https://git.example.com/away/app.git${info}`] = { status: 302, headers: { location: `https://10.0.0.5/app.git${info}` } };
    const env = tokenConfig("https://git.example.com/x", "gitea", "secret");
    requests.length = 0;
    expect(await followMove("https://git.example.com/old/app.git", env)).toBe("https://git.example.com/new/app.git");
    expect(requests[0].headers?.Authorization).toBe(`Basic ${Buffer.from("oauth2:secret").toString("base64")}`);
    expect(await followMove("https://git.example.com/away/app.git", env)).toBe("https://git.example.com/away/app.git");
    expect(await followMove("git@git.example.com:a/b.git", env)).toBe("git@git.example.com:a/b.git");
  });
  it("refuses a server on a private network", async () => {
    await expect(gitAccess(src("https://internal.example.com/a.git"), "/tmp/x", "org-1")).rejects.toThrow(/private network/);
    await expect(gitAccess(src("git@internal.example.com:a/b.git"), "/tmp/x", "org-1")).rejects.toThrow(/private network/);
  });
  it("leaves the Root organization and unknown callers as they were", async () => {
    expect((await gitAccess(src("https://internal.example.com/a.git"), "/tmp/x", "root-org")).gitEnv.GIT_CONFIG_COUNT).toBeUndefined();
    expect((await gitAccess(src("https://internal.example.com/a.git"), "/tmp/x", null)).gitEnv.GIT_CONFIG_COUNT).toBeUndefined();
  });
});
