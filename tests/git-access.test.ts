import { beforeEach, describe, expect, it, vi } from "vitest";

type Login = { id: string; name: string; provider: string; baseUrl: null; oauthAppId: null; organizationId: string };
const login = (id: string, provider = "github"): Login => ({ id, name: `login-${id}`, provider, baseUrl: null, oauthAppId: null, organizationId: "o" });

let logins: Login[] = [];
/** Repositories each login lists; null: it cannot list. */
let listed: Record<string, string[] | null> = {};
/** Which credentials (null: none) ls-remote reaches the repository with. */
let reach = new Set<string | null>();

vi.mock("@/server/db", () => {
  const where = () => Promise.resolve(logins.filter((l) => l.name === named));
  return { db: { select: () => ({ from: () => ({ where }) }) }, schema: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }) };
});
let named = "";
vi.mock("drizzle-orm", () => ({ and: () => ({}), eq: (_c: unknown, v: string) => ((named = v), {}) }));
vi.mock("@/server/deploy/git", () => ({
  gitLoginsFor: async () => logins,
  normalizeRepoUrl: (u: string) => u,
  listRemoteBranches: async (s: { credentialId: string | null }) => {
    if (!reach.has(s.credentialId)) throw new Error("no");
    return ["main"];
  },
}));
vi.mock("@/server/git/github-app", () => ({
  listAppRepositories: async (c: Login) => (listed[c.id] ?? []).map((fullName) => ({ fullName })),
}));
vi.mock("@/server/git/oauth", () => ({ withCredentialToken: async (c: Login, fn: (t: string) => unknown) => fn(c.id) }));
vi.mock("@/server/git/providers", () => ({
  listRepositories: async (_p: string, token: string) => {
    const l = listed[token];
    if (l === null) throw new Error("API down");
    return (l ?? []).map((fullName) => ({ fullName }));
  },
}));

const { findGitAccess, repoPath } = await import("@/server/git/access");
const REPO = "https://github.com/acme/api.git";

describe("finding a git login with access", () => {
  beforeEach(() => {
    logins = [login("app", "github-app"), login("tok")];
    listed = { app: ["acme/web"], tok: ["Acme/API"] };
    reach = new Set();
  });

  it("reads owner/repo from clone URLs", () => {
    expect(repoPath("https://github.com/Acme/API.git")).toBe("acme/api");
    expect(repoPath("https://gitlab.example.com/group/sub/app/")).toBe("group/sub/app");
    expect(repoPath("git@github.com:acme/api.git")).toBeNull();
  });

  it("takes the first login that lists the repository", async () => {
    expect(await findGitAccess("o", REPO)).toEqual({ credentialId: "tok", login: "login-tok", note: null });
  });

  it("gives a public repository a login too, for deploys on push", async () => {
    reach = new Set([null, "app", "tok"]);
    expect(await findGitAccess("o", REPO)).toMatchObject({ credentialId: "tok" });
  });

  it("deploys a public repository nobody listed without a login, and says pushes will not deploy", async () => {
    listed = { app: [], tok: [] };
    reach = new Set([null, "app", "tok"]);
    expect(await findGitAccess("o", REPO)).toMatchObject({ credentialId: null, note: expect.stringMatching(/pushes do not deploy/) });
  });

  it("tries cloning with each login when a private repository is in no list", async () => {
    listed = { app: [], tok: null };
    reach = new Set(["tok"]);
    expect(await findGitAccess("o", REPO)).toMatchObject({ credentialId: "tok" });
  });

  it("names every login it tried when none reach a private repository", async () => {
    listed = { app: [], tok: [] };
    expect(await findGitAccess("o", REPO)).toEqual({ error: expect.stringMatching(/tried login-app, login-tok/) });
    logins = [];
    expect(await findGitAccess("o", REPO)).toEqual({ error: expect.stringMatching(/add a git login with access/) });
  });

  it("uses only the login the file names", async () => {
    expect(await findGitAccess("o", REPO, "login-app")).toEqual({ error: expect.stringMatching(/"login-app" has no access/) });
    expect(await findGitAccess("o", REPO, "login-tok")).toMatchObject({ credentialId: "tok" });
    expect(await findGitAccess("o", REPO, "nobody")).toEqual({ error: expect.stringMatching(/No git login is named "nobody"/) });
  });
});
