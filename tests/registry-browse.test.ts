import { describe, expect, it } from "vitest";
import { sameRegistryHost, sortTags, splitImage } from "@/server/registries/browse";

describe("splitImage", () => {
  it("reads host, repository and tag", () => {
    expect(splitImage("nginx")).toEqual({ host: "docker.io", repo: "library/nginx", tag: null });
    expect(splitImage("traefik/whoami:latest")).toEqual({ host: "docker.io", repo: "traefik/whoami", tag: "latest" });
    expect(splitImage("ghcr.io/Serve-BD/serve:0.1.9")).toEqual({ host: "ghcr.io", repo: "serve-bd/serve", tag: "0.1.9" });
    expect(splitImage("registry.example.com:5000/team/app")).toEqual({ host: "registry.example.com:5000", repo: "team/app", tag: null });
    expect(splitImage("localhost/app:dev")).toEqual({ host: "localhost", repo: "app", tag: "dev" });
    expect(splitImage("docker.io/library/redis:7@sha256:abc123")).toEqual({ host: "docker.io", repo: "library/redis", tag: "7" });
  });
});

describe("sameRegistryHost", () => {
  it("treats every spelling of Docker Hub as one", () => {
    expect(sameRegistryHost("docker.io", "registry-1.docker.io")).toBe(true);
    expect(sameRegistryHost("index.docker.io", "docker.io")).toBe(true);
    expect(sameRegistryHost("ghcr.io", "docker.io")).toBe(false);
    expect(sameRegistryHost("GHCR.io", "ghcr.io")).toBe(true);
  });
});

describe("sortTags", () => {
  it("puts the newest first when dates are known", () => {
    const tags = sortTags([
      { name: "1.0", updatedAt: "2026-01-01T00:00:00Z" },
      { name: "1.1", updatedAt: "2026-02-01T00:00:00Z" },
      { name: "latest", updatedAt: "2026-02-01T00:00:00Z" },
    ]);
    expect(tags.map((t) => t.name)).toEqual(["latest", "1.1", "1.0"]);
  });

  it("puts latest first, then versions from high to low, without dates", () => {
    const tags = sortTags(["1.9", "1.10", "latest", "1.2"].map((name) => ({ name, updatedAt: null })));
    expect(tags.map((t) => t.name)).toEqual(["latest", "1.10", "1.9", "1.2"]);
  });

  it("keeps one entry per tag, with its newest date", () => {
    const tags = sortTags([
      { name: "v1", updatedAt: "2026-01-01T00:00:00Z" },
      { name: "v1", updatedAt: "2026-03-01T00:00:00Z" },
    ]);
    expect(tags).toEqual([{ name: "v1", updatedAt: "2026-03-01T00:00:00Z" }]);
  });
});
