import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
vi.mock("@/server/settings", () => ({ getSetting: async () => "root-org" }));
const addresses: Record<string, string | null> = { "git.example.com": "203.0.113.9", "internal.example.com": null, "[2001:db8::1]": "2001:db8::1" };
vi.mock("@/server/net/public-host", () => ({ publicAddress: async (h: string) => addresses[h] ?? null }));

const { gitAccess } = await import("@/server/deploy/git");
const src = (repository: string) => ({ type: "git" as const, repository, branch: "main" });

describe("git servers of other organizations", () => {
  it("connects to the public address checked when connecting", async () => {
    const a = await gitAccess(src("https://git.example.com/team/app.git"), "/tmp/x", "org-1");
    expect(a.gitEnv.GIT_CONFIG_KEY_0).toBe("http.curloptResolve");
    expect(a.gitEnv.GIT_CONFIG_VALUE_0).toBe("git.example.com:443:203.0.113.9");
    expect(a.gitEnv.GIT_CONFIG_COUNT).toBe("1");
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
