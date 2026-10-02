import { describe, expect, it, vi } from "vitest";

// The token of a git connection is sent only to that connection's own server.
const cred = { id: "c", organizationId: "root-org", provider: "github", baseUrl: null as string | null, secret: "x", oauthAppId: null };
vi.mock("@/server/db", () => ({
  db: { select: () => ({ from: () => ({ where: async () => [cred] }) }) },
  schema: { gitCredential: {} },
}));
vi.mock("@/server/settings", () => ({ getSetting: async () => "root-org" }));
vi.mock("@/server/git/oauth", () => ({ credentialToken: async () => "ghp_secret" }));
vi.mock("@/server/git/github-app", () => ({ installationToken: async () => "ghs_secret" }));

const { assertCredentialHost, credentialOrigin, gitAccess } = await import("@/server/deploy/git");
const src = (repository: string) => ({ type: "git" as const, repository, branch: "main", credentialId: "c" });

describe("git connection tokens", () => {
  it("knows each provider's address", () => {
    expect(credentialOrigin({ provider: "github", baseUrl: null })).toBe("https://github.com");
    expect(credentialOrigin({ provider: "github-app", baseUrl: "https://evil.example" })).toBe("https://github.com");
    expect(credentialOrigin({ provider: "gitlab", baseUrl: "https://git.example.com/" })).toBe("https://git.example.com");
    expect(credentialOrigin({ provider: "ssh", baseUrl: null })).toBeNull();
  });

  it("refuses a repository on another server", () => {
    expect(() => assertCredentialHost({ provider: "github", baseUrl: null }, "https://attacker.example/x.git")).toThrow(/github\.com/);
    expect(() => assertCredentialHost({ provider: "github", baseUrl: null }, "http://github.com/a/b.git")).toThrow();
    expect(() => assertCredentialHost({ provider: "gitlab", baseUrl: "https://git.example.com" }, "https://gitlab.com/a/b.git")).toThrow();
    expect(() => assertCredentialHost({ provider: "gitlab", baseUrl: "https://git.example.com" }, "https://git.example.com/a/b.git")).not.toThrow();
  });

  it("never puts the token in the environment of a clone from elsewhere", async () => {
    cred.provider = "github";
    await expect(gitAccess(src("https://attacker.example/x.git"), "/tmp/x", "root-org")).rejects.toThrow(/not for this repository/);
    cred.provider = "github-app";
    await expect(gitAccess(src("https://attacker.example/x.git"), "/tmp/x", "root-org")).rejects.toThrow(/not for this repository/);
    const ok = await gitAccess(src("owner/repo"), "/tmp/x", "root-org");
    expect(ok.gitEnv.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraHeader");
  });
});
