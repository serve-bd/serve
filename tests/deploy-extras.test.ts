import { describe, expect, it } from "vitest";

// Modules read these at import time; no database connection is made.
process.env.BETTER_AUTH_SECRET = "test-secret-for-deploy-extras";
process.env.DATABASE_URL = "postgres://test@127.0.0.1:1/test";
const { parsePush, skipMarker } = await import("@/server/git/events");
const { imageWithTag } = await import("@/lib/preview-image");

const h = (o: Record<string, string>) => new Headers(o);

describe("skip markers", () => {
  it("finds the markers CI services read, in any case", () => {
    for (const m of ["[skip ci]", "[ci skip]", "[no ci]", "[skip cd]", "[cd skip]", "[skip deploy]", "[deploy skip]", "[SKIP CI]"]) expect(skipMarker(`Fix typo ${m}`)).toBe(m);
    expect(skipMarker("skip ci without brackets")).toBeNull();
    expect(skipMarker("[skip-ci]")).toBeNull();
    expect(skipMarker(null)).toBeNull();
  });

  it("reads the marker from the whole commit message of each provider", () => {
    const gh = parsePush(h({ "x-github-event": "push" }), { ref: "refs/heads/main", head_commit: { id: "a1", message: "Docs\n\n[skip ci]" } });
    expect(gh).toMatchObject({ message: "Docs", skip: "[skip ci]" });
    const gl = parsePush(h({ "x-gitlab-event": "Push Hook" }), { ref: "refs/heads/main", checkout_sha: "b2", commits: [{ id: "b2", message: "Readme [ci skip]" }] });
    expect(gl).toMatchObject({ skip: "[ci skip]" });
    const bb = parsePush(h({ "x-event-key": "repo:push" }), { push: { changes: [{ new: { name: "main", target: { hash: "c3", message: "x [skip deploy]" } } }] } });
    expect(bb).toMatchObject({ skip: "[skip deploy]" });
    expect(parsePush(h({ "x-github-event": "push" }), { ref: "refs/heads/main", head_commit: { id: "d4", message: "Ship it" } })).toMatchObject({ skip: null });
  });
});

describe("preview image tags", () => {
  it("replaces the tag or digest of the app's image", () => {
    expect(imageWithTag("ghcr.io/acme/web:1.2", "pr-12")).toBe("ghcr.io/acme/web:pr-12");
    expect(imageWithTag("nginx", "pr-3")).toBe("nginx:pr-3");
    expect(imageWithTag("localhost:5000/app", "pr-3")).toBe("localhost:5000/app:pr-3");
    expect(imageWithTag("localhost:5000/app:latest", "v2")).toBe("localhost:5000/app:v2");
    const digest = `sha256:${"a".repeat(64)}`;
    expect(imageWithTag("acme/web@sha256:" + "b".repeat(64), digest)).toBe(`acme/web@${digest}`);
  });

  it("refuses what is not a tag or digest", () => {
    expect(imageWithTag("acme/web", "")).toBeNull();
    expect(imageWithTag("acme/web", "-bad")).toBeNull();
    expect(imageWithTag("acme/web", "a/b")).toBeNull();
    expect(imageWithTag("acme/web", "x".repeat(129))).toBeNull();
    expect(imageWithTag("acme/web", "sha256:abc")).toBeNull();
  });
});
