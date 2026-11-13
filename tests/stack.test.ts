import { describe, expect, it } from "vitest";
import {
  databaseSource,
  deployWaves,
  dependencies,
  gitSource,
  parseEnvFile,
  parseStack,
  serviceKind,
  stackFiles,
  stackVariables,
  toStackName,
  uploadFolder,
  type Stack,
} from "@/lib/stack";

const ok = (text: string, values: Record<string, string> = {}, folder = "shop"): Stack => {
  const r = parseStack(text, values, folder);
  if ("errors" in r) throw new Error(r.errors.join("\n"));
  return r.stack;
};
const errs = (text: string, values: Record<string, string> = {}) => {
  const r = parseStack(text, values, "shop");
  return "errors" in r ? r.errors.join("\n") : "";
};

const SHOP = `
name: shop
services:
  db:
    database: postgres:17
  cache:
    database: redis
  api:
    git: github.com/me/api@main
    build: { rootDir: apps/api, builder: dockerfile }
    port: 3000
    env_file: [./.env.api]
    env:
      DATABASE_URL: \${{ db.DATABASE_URL }}
      SECRET: \${API_SECRET}
      WORKERS: 4
    depends_on: [cache]
    domains: [API.example.com]
  web:
    build: ./web
    env:
      API: http://\${{ api.SERVE_PRIVATE_DOMAIN }}
  tools:
    compose: tools/docker-compose.yml
`;

describe("serve-compose.yml", () => {
  it("reads a stack with every kind of service", () => {
    const s = ok(SHOP, { API_SECRET: "s3cret" });
    expect(s.name).toBe("shop");
    expect(Object.keys(s.services)).toEqual(["db", "cache", "api", "web", "tools"]);
    expect(Object.values(s.services).map(serviceKind)).toEqual(["database", "database", "git", "upload", "compose"]);
    expect(s.services.api.env).toEqual({ DATABASE_URL: "${{ db.DATABASE_URL }}", SECRET: "s3cret", WORKERS: "4" });
    expect(s.services.api.domains).toEqual(["api.example.com"]);
    expect(errs('services:\n  a: { image: x, domains: ["not a host"] }\n')).toMatch(/hostname/);
    expect(uploadFolder(s.services.web)).toBe("./web");
    expect(uploadFolder(s.services.api)).toBeNull();
    expect(stackFiles(s)).toEqual([".env.api", "tools/docker-compose.yml"]);
  });

  it("deploys in waves: dependencies and links first", () => {
    const s = ok(SHOP, { API_SECRET: "x" });
    expect(dependencies(s, "api")).toEqual([
      { on: "cache", condition: "healthy" },
      { on: "db", condition: "healthy" },
    ]);
    expect(deployWaves(s)).toEqual([["db", "cache", "tools"], ["api"], ["web"]]);
  });

  it("refuses loops, naming them", () => {
    const e = errs("services:\n  a: { image: x, depends_on: [b] }\n  b: { image: x, env: { A: '${{ a.PORT }}' } }\n");
    expect(e).toMatch(/loop: a -> b -> a/);
    expect(errs("services:\n  a: { image: x, depends_on: [a] }\n")).toMatch(/cannot depend on itself/);
    expect(errs("services:\n  a: { image: x, depends_on: [nope] }\n")).toMatch(/"nope" is not a service/);
  });

  it("takes depends_on with conditions", () => {
    const s = ok("services:\n  db: { database: mysql }\n  a: { image: x, depends_on: { db: { condition: started } } }\n");
    expect(dependencies(s, "a")).toEqual([{ on: "db", condition: "started" }]);
  });

  it("links to services outside the stack are not dependencies", () => {
    const s = ok("services:\n  a: { image: x, env: { U: '${{ other.URL }}', S: '${{ shared.X }}', O: '${{ a.PORT }}' } }\n");
    expect(dependencies(s, "a")).toEqual([]);
  });

  it("fills ${VAR} like docker compose, never ${{ }}", () => {
    const text = "services:\n  a:\n    image: x:${TAG:-latest}\n    env: { A: '${A-unset}', B: '$${HOME}', C: '${{ b.X }}', D: 'p$$w' }\n  b: { image: y }\n";
    expect(stackVariables(text)).toEqual(["TAG", "A"]);
    const s = ok(text, { A: "" });
    expect(s.services.a.image).toBe("x:latest");
    expect(s.services.a.env).toEqual({ A: "", B: "${HOME}", C: "${{ b.X }}", D: "p$w" });
    expect(errs("services:\n  a: { image: '${IMG}' }\n")).toMatch(/services\.a\.image: IMG is not set/);
    expect(errs("services:\n  a: { image: '${IMG:?pick an image}' }\n", { IMG: "" })).toMatch(/pick an image/);
  });

  it("needs exactly one source", () => {
    expect(errs("services:\n  a: { port: 80 }\n")).toMatch(/Give a source/);
    expect(errs("services:\n  a: { image: x, git: github.com/a/b }\n")).toMatch(/Pick one source, not git and image/);
    expect(errs("services:\n  a: { build: { builder: dockerfile } }\n")).toMatch(/Build settings need git/);
    expect(errs("services:\n  a: { database: postgres, port: 5432 }\n")).toMatch(/takes no build, port or domains/);
  });

  it("checks names, keys and paths", () => {
    expect(errs("services:\n  bad_name: { image: x }\n")).toMatch(/services\.bad_name/);
    expect(errs("services:\n  shared: { image: x }\n")).toMatch(/shared variables/);
    expect(errs("services:\n  a: { image: x, colour: red }\n")).toMatch(/unknown setting "colour"/);
    expect(errs("services:\n  a: { build: ../outside }\n")).toMatch(/inside the stack's folder/);
    expect(errs("services:\n  a: { image: x, env_file: /etc/passwd }\n")).toMatch(/inside the stack's folder/);
    expect(errs("services:\n  a: { image: x, env_file: ~/.ssh/id }\n")).toMatch(/inside the stack's folder/);
    expect(errs("services:\n  Api: { image: x }\n  api: { image: y }\n")).toMatch(/differ only in case/);
    expect(errs("services: {}\n")).toMatch(/at least one service/);
    expect(errs("- a\n")).toMatch(/must hold a map/);
    expect(errs("services: [\n")).toMatch(/not valid YAML/);
  });

  it("names the stack after its folder when the file does not", () => {
    expect(ok("services:\n  a: { image: x }\n", {}, "My Shop").name).toBe("My-Shop");
    expect(toStackName("...")).toBe("");
    const r = parseStack("services:\n  a: { image: x }\n", {}, "...");
    expect("errors" in r && r.errors[0]).toMatch(/give the stack a name/);
  });

  it("reads Windows line endings and a byte order mark", () => {
    expect(ok("\uFEFFservices:\r\n  a:\r\n    image: x\r\n").services.a.image).toBe("x");
  });

  it("reuses serve.json's settings", () => {
    const s = ok("services:\n  a:\n    image: x\n    deploy: { replicas: 3 }\n    healthcheck: { path: /up }\n");
    expect(s.services.a.deploy?.replicas).toBe(3);
    expect(errs("services:\n  a:\n    image: x\n    tasks: [{ name: t, schedule: '0 3 * * *', command: x }, { name: t, schedule: '0 4 * * *', command: y }]\n")).toMatch(
      /Two tasks are named "t"/,
    );
  });

  it("reads git and database shorthands", () => {
    expect(gitSource("github.com/me/api@main")).toEqual({ repository: "https://github.com/me/api", branch: "main", account: null });
    expect(gitSource("https://gitlab.com/me/api.git#dev")).toEqual({ repository: "https://gitlab.com/me/api.git", branch: "dev", account: null });
    expect(gitSource("git@github.com:me/api.git")).toEqual({ repository: "git@github.com:me/api.git", branch: null, account: null });
    expect(gitSource("git@github.com:me/api.git@v2")).toEqual({ repository: "git@github.com:me/api.git", branch: "v2", account: null });
    expect(gitSource({ repo: "github.com/me/api", account: "work" })).toEqual({ repository: "https://github.com/me/api", branch: null, account: "work" });
    expect(databaseSource("postgres:17")).toEqual({ engine: "postgres", version: "17" });
    expect(databaseSource("valkey")).toEqual({ engine: "valkey", version: null });
    expect(databaseSource("oracle:23")).toMatchObject({ error: expect.stringMatching(/Unknown database "oracle"/) });
  });

  it("reads .env files like docker compose", () => {
    const r = parseEnvFile('# c\nA=1\nexport B = two words # note\nC="x\\ny"\nD=\'$raw\'\nE="multi\nline"\nF=\n');
    expect(r).toEqual({ values: { A: "1", B: "two words", C: "x\ny", D: "$raw", E: "multi\nline", F: "" } });
    expect(parseEnvFile("not a line")).toMatchObject({ error: expect.stringMatching(/line 1/) });
    expect(parseEnvFile('A="open')).toMatchObject({ error: expect.stringMatching(/not closed/) });
  });
});

describe("applying a stack again", () => {
  it("keeps values changed in the dashboard since the last up, unless forced", async () => {
    const { variableChanges } = await import("@/lib/stack");
    const current = new Map([
      ["A", "1"],
      ["B", "edited"],
      ["C", "3"],
      ["D", "mine"],
      ["E", "edited too"],
    ]);
    const last = { A: "1", B: "2", C: "3", E: "5" };
    const file = { A: "1", B: "two", F: "6" };
    expect(variableChanges(current, file, last, false)).toEqual({ set: ["F"], kept: ["B", "E"], remove: ["C"] });
    expect(variableChanges(current, file, last, true)).toEqual({ set: ["B", "F"], kept: [], remove: ["C", "E"] });
    // A variable made in the dashboard (never set by the file) is not the file's to remove.
    expect(variableChanges(current, {}, {}, true).remove).toEqual([]);
  });

  it("links to a stack service by the name it got", async () => {
    const { rewriteLinks } = await import("@/lib/stack");
    const names = new Map([
      ["db", "db-2"],
      ["web", "web"],
    ]);
    expect(rewriteLinks({ A: "${{ db.DATABASE_URL }}", B: "x ${{DB.PORT}} ${{ web.PORT }} ${{ shared.X }} ${{ other.Y }}" }, names)).toEqual({
      A: "${{ db-2.DATABASE_URL }}",
      B: "x ${{ db-2.PORT }} ${{ web.PORT }} ${{ shared.X }} ${{ other.Y }}",
    });
  });
});
