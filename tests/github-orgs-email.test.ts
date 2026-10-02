import { afterEach, describe, expect, it, vi } from "vitest";
import { githubMembersOnly } from "@/server/sso/github-orgs";

function mockGithub(emails: { email: string; primary: boolean; verified: boolean }[], publicEmail: string | null = null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
      if (url.endsWith("/user")) return json({ id: 1, login: "someone", name: "Someone", email: publicEmail, avatar_url: "" });
      if (url.endsWith("/user/emails")) return json(emails);
      if (url.includes("/user/memberships/orgs/")) return json({ state: "active" }, 200, { "x-oauth-scopes": "read:org" });
      return json({}, 404);
    }),
  );
}

describe("GitHub organization sign-in and the email domain rule", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses an unverified address of an allowed domain", async () => {
    mockGithub([{ email: "ceo@example.com", primary: true, verified: false }]);
    const info = await githubMembersOnly(["acme"], ["example.com"])({ accessToken: "t" });
    expect(info?.user.email).toBe("");
  });

  it("uses a verified address over an unverified primary one", async () => {
    mockGithub([
      { email: "new@example.com", primary: true, verified: false },
      { email: "me@example.com", primary: false, verified: true },
    ]);
    const info = await githubMembersOnly(["acme"], ["example.com"])({ accessToken: "t" });
    expect(info?.user).toMatchObject({ email: "me@example.com", emailVerified: true });
  });

  it("lets members in without a domain rule", async () => {
    mockGithub([{ email: "me@other.org", primary: true, verified: true }]);
    const info = await githubMembersOnly(["acme"], [])({ accessToken: "t" });
    expect(info?.user.email).toBe("me@other.org");
  });
});
