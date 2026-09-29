import { describe, expect, it } from "vitest";
import { distributionProblem, isDistributed, needsRegistry, normalizeDistribution, runServerIds } from "@/server/deploy/distribution";
import { authServer, defaultRepository, imageRef, normalizeHost, normalizeRepository, parsePushDigest, renderTag } from "@/server/registries/refs";

describe("normalizeDistribution", () => {
  it("drops the primary from the build and extra servers and removes duplicates", () => {
    const d = normalizeDistribution("a", { buildServerId: "a", extraServerIds: ["b", "a", "b", "c"], repository: "  ", tag: "" });
    expect(d).toEqual({ buildServerId: null, registryId: null, repository: null, tag: null, tagLatest: false, extraServerIds: ["b", "c"] });
  });

  it("treats a missing config as the classic single-server setup", () => {
    expect(runServerIds("a", null)).toEqual(["a"]);
    expect(isDistributed("a", null)).toBe(false);
    expect(isDistributed("a", { extraServerIds: ["a"] })).toBe(false);
    expect(isDistributed("a", { extraServerIds: ["b"] })).toBe(true);
  });
});

describe("distributionProblem", () => {
  it("needs a registry to move a built image to other servers", () => {
    const extra = normalizeDistribution("a", { extraServerIds: ["b"] });
    expect(needsRegistry(extra, "git")).toBe(true);
    expect(distributionProblem(extra, "git")).toMatch(/registry/);
    const build = normalizeDistribution("a", { buildServerId: "b" });
    expect(distributionProblem(build, "git")).toMatch(/built on another server/);
  });

  it("lets prebuilt images run on extra servers without a registry", () => {
    const extra = normalizeDistribution("a", { extraServerIds: ["b"] });
    expect(needsRegistry(extra, "image")).toBe(false);
    expect(distributionProblem(extra, "image")).toBeNull();
  });

  it("needs a repository when pushing", () => {
    expect(distributionProblem(normalizeDistribution("a", { registryId: "r" }), "git")).toMatch(/repository/);
    expect(distributionProblem(normalizeDistribution("a", { registryId: "r", repository: "team/app", extraServerIds: ["b"] }), "git")).toBeNull();
  });
});

describe("registry references", () => {
  it("renders tag patterns into valid Docker tags", () => {
    const vars = { commit: "4f2a9c1e8b7d0000", deployment: "k3j9x2pqzz", branch: "feature/login", service: "web", now: new Date("2026-03-04T10:00:00Z") };
    expect(renderTag(null, vars)).toBe("4f2a9c1-k3j9x2pq");
    expect(renderTag("{branch}-{date}", vars)).toBe("feature-login-20260304");
    expect(renderTag("{service}:{commit}", vars)).toBe("web-4f2a9c1e8b7d0000");
    // No commit (image sources, first builds): never an empty or invalid tag.
    expect(renderTag("{short}", { ...vars, commit: null })).toBe("k3j9x2pq");
    expect(renderTag("x".repeat(200), vars)).toHaveLength(128);
  });

  it("builds references by tag or digest", () => {
    expect(imageRef("ghcr.io", "acme/web", "v1")).toBe("ghcr.io/acme/web:v1");
    expect(imageRef("ghcr.io", "acme/web", "sha256:abc")).toBe("ghcr.io/acme/web@sha256:abc");
  });

  it("normalizes hosts and repositories", () => {
    expect(normalizeHost("https://Registry.Example.com:5000/v2/")).toBe("registry.example.com:5000");
    expect(() => normalizeHost("not a host")).toThrow();
    expect(normalizeRepository("/Acme/Web/")).toBe("acme/web");
    expect(() => normalizeRepository("acme//web")).toThrow();
    expect(() => normalizeRepository("acme/web:latest")).toThrow();
  });

  it("reads the pushed digest from the Engine's status line", () => {
    const digest = `sha256:${"d5".repeat(32)}`;
    expect(parsePushDigest(`abc123-k3j9: digest: ${digest} size: 1022`)).toBe(digest);
    expect(parsePushDigest("e2de96513ba9: Pushed")).toBeNull();
  });

  it("uses Docker Hub's legacy auth address", () => {
    expect(authServer("docker.io")).toBe("https://index.docker.io/v1/");
    expect(authServer("ghcr.io")).toBe("ghcr.io");
  });

  it("suggests a repository under the namespace or username", () => {
    expect(defaultRepository({ namespace: null, username: "Jane" }, "web-1a2b")).toBe("jane/web-1a2b");
    expect(defaultRepository({ namespace: "acme/team", username: "jane" }, "web")).toBe("acme/team/web");
  });
});
