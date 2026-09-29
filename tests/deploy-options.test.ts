import { describe, expect, it } from "vitest";
import { buildArgFlags, globToRegExp, matchesWatchPaths, statusMatcher, userLabels, validExtraHosts } from "@/server/deploy/options";

describe("watch paths", () => {
  it("matches globs", () => {
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("**/*.md").test("docs/x/readme.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("readme.md")).toBe(true);
    expect(globToRegExp("apps/web").test("apps/web/page.tsx")).toBe(true);
    expect(globToRegExp("package.json").test("package.json")).toBe(true);
  });
  it("decides whether a push deploys", () => {
    expect(matchesWatchPaths(["docs/a.md"], ["apps/web/**"])).toBe(false);
    expect(matchesWatchPaths(["apps/web/x.ts", "docs/a.md"], ["apps/web/**"])).toBe(true);
    expect(matchesWatchPaths(["docs/a.md"], ["!docs/**"])).toBe(false);
    expect(matchesWatchPaths(["src/a.ts"], ["!docs/**"])).toBe(true);
    expect(matchesWatchPaths(null, ["apps/web/**"])).toBe(true);
    expect(matchesWatchPaths(["x"], [])).toBe(true);
  });
});

describe("health check status", () => {
  it("parses ranges and lists", () => {
    const m = statusMatcher("200-299, 304");
    expect(m(204)).toBe(true);
    expect(m(304)).toBe(true);
    expect(m(302)).toBe(false);
    expect(statusMatcher(null)(404)).toBe(true);
    expect(statusMatcher(null)(502)).toBe(false);
  });
});

describe("container options", () => {
  it("builds args and filters invalid entries", () => {
    expect(
      buildArgFlags([
        { key: "NODE_VERSION", value: "22" },
        { key: "bad key", value: "x" },
      ]),
    ).toEqual(["--build-arg", "NODE_VERSION=22"]);
    expect(validExtraHosts(["db.internal:10.0.0.5", "nope", "gw:host-gateway"])).toEqual(["db.internal:10.0.0.5", "gw:host-gateway"]);
    expect(
      userLabels([
        { key: "team", value: "web" },
        { key: "serve.service", value: "x" },
      ]),
    ).toEqual({ team: "web" });
  });
});
