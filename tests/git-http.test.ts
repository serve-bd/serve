import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/settings", () => ({ getSetting: async () => "root-org" }));
const publicRequest = vi.fn(async () => ({ status: 200, headers: { "x-oauth-scopes": "repo" }, text: '{"login":"me"}' }));
vi.mock("@/server/net/public-fetch", () => ({ publicRequest }));
const { gitHttp } = await import("@/server/git/http");

describe("git provider requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    publicRequest.mockClear();
  });

  it("reaches another organization's self-hosted server only on a public address", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const res = await gitHttp("https://git.example.com/api/v1/user", { headers: { a: "b" } }, { selfHosted: true, organizationId: "org-2" });
    expect(publicRequest).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.header("X-OAuth-Scopes")).toBe("repo");
    expect(JSON.parse(res.text).login).toBe("me");
  });

  it("lets Root reach its own server, without following redirects", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await gitHttp("http://10.0.0.5/api/v1/user", {}, { selfHosted: true, organizationId: "root-org" });
    expect(publicRequest).not.toHaveBeenCalled();
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("error");
  });

  it("fetches hosted providers as usual", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await gitHttp("https://api.github.com/user", {}, { selfHosted: false, organizationId: "org-2" });
    expect(publicRequest).not.toHaveBeenCalled();
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("follow");
  });
});
