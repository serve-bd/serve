import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { builtServices, composeRollbackProblem, parseCompose, pinComposeImages, pulledDigest, rollbackPin, snapshotTag, transformCompose } from "@/server/deploy/compose";
import type { ComposeSnapshot } from "@/server/db/schema";

const file = `services:
  web:
    build: ./web
    image: shop-web
    pull_policy: build
    environment:
      ENABLED: "yes"
      CODE: "0o12"
      TOKEN: \${TOKEN}
  db:
    image: postgres:\${PG:-16}
    pull_policy: always
  worker:
    image: busybox
    profiles: [jobs]
`;

const snapshot: ComposeSnapshot = {
  mode: "inline",
  content: file,
  images: {
    web: { ref: "shop-web", id: "sha256:aaa", digest: null, tag: "serve/compose/shop:d1-web" },
    db: { ref: "postgres:16", id: "sha256:bbb", digest: "postgres@sha256:123", tag: "serve/compose/shop:d1-db" },
  },
};

describe("which compose deployments can be rolled back", () => {
  it("needs a successful deployment that recorded its file and images", () => {
    expect(composeRollbackProblem({ status: "success", commitSha: null, composeSnapshot: snapshot })).toBeNull();
    expect(composeRollbackProblem({ status: "failed", commitSha: null, composeSnapshot: snapshot })).toMatch(/successful/);
    // Deployed before Serve recorded snapshots: refused, never deployed with today's images.
    expect(composeRollbackProblem({ status: "success", commitSha: null, composeSnapshot: null })).toMatch(/before Serve recorded/);
    expect(composeRollbackProblem({ status: "success", commitSha: null, composeSnapshot: { ...snapshot, images: {} } })).toMatch(/No images/);
  });

  it("needs the commit and the file's path of a file from git", () => {
    const git: ComposeSnapshot = { ...snapshot, mode: "git", file: "deploy/compose.yaml" };
    expect(composeRollbackProblem({ status: "success", commitSha: "abc", composeSnapshot: git })).toBeNull();
    expect(composeRollbackProblem({ status: "success", commitSha: null, composeSnapshot: git })).toMatch(/commit/);
    expect(composeRollbackProblem({ status: "success", commitSha: "abc", composeSnapshot: { ...git, file: undefined } })).toMatch(/path/);
  });
});

describe("the image a rolled-back service runs", () => {
  const where = "this server";
  it("is Serve's tag while it holds the very image", () => {
    expect(rollbackPin("web", snapshot.images.web, "sha256:aaa", where)).toEqual({ image: "serve/compose/shop:d1-web", pullPolicy: "never" });
  });

  it("is the recorded digest once the tag is gone or points elsewhere", () => {
    expect(rollbackPin("db", snapshot.images.db, null, where)).toEqual({ image: "postgres@sha256:123", pullPolicy: "missing" });
    expect(rollbackPin("db", snapshot.images.db, "sha256:other", where)).toEqual({ image: "postgres@sha256:123", pullPolicy: "missing" });
  });

  it("fails for a built image that is gone: building again would not give the same image", () => {
    expect(() => rollbackPin("web", snapshot.images.web, null, where)).toThrow(/no longer on this server/);
  });
});

describe("pinning the recorded file", () => {
  it("runs each recorded service on its image, without building or pulling anything newer", () => {
    const pinned = parseCompose(
      pinComposeImages(file, {
        web: { image: "serve/compose/shop:d1-web", pullPolicy: "never" },
        db: { image: "postgres@sha256:123", pullPolicy: "missing" },
      }),
    );
    expect(pinned.services?.web).toMatchObject({ image: "serve/compose/shop:d1-web", pull_policy: "never" });
    expect(pinned.services?.web.build).toBeUndefined();
    expect(pinned.services?.db).toMatchObject({ image: "postgres@sha256:123", pull_policy: "missing" });
    // A service that ran no container stays as written.
    expect(pinned.services?.worker).toEqual({ image: "busybox", profiles: ["jobs"] });
  });

  it("keeps every other value as written through Serve's own changes", () => {
    const pinned = pinComposeImages(file, { db: { image: "postgres@sha256:123", pullPolicy: "missing" } });
    const out = YAML.parse(transformCompose(pinned, "shop", "svc1"), { version: "1.1" });
    expect(out.services.web.environment).toEqual({ ENABLED: "yes", CODE: "0o12", TOKEN: "${TOKEN}" });
    expect(out.services.web.build).toBe("./web");
  });

  it("refuses a recorded service the file does not have", () => {
    expect(() => pinComposeImages(file, { gone: { image: "x", pullPolicy: "never" } })).toThrow(/gone/);
  });
});

describe("recorded references", () => {
  it("prefers the digest of the repository the file named", () => {
    expect(pulledDigest("postgres:16", ["mirror.local/postgres@sha256:1", "postgres@sha256:2"])).toBe("postgres@sha256:2");
    expect(pulledDigest("docker.io/library/postgres:16", ["postgres@sha256:2"])).toBe("postgres@sha256:2");
    expect(pulledDigest("ghcr.io/a/b:1", ["ghcr.io/a/b@sha256:3"])).toBe("ghcr.io/a/b@sha256:3");
    expect(pulledDigest("localhost:5000/app", ["localhost:5000/app@sha256:4"])).toBe("localhost:5000/app@sha256:4");
    expect(pulledDigest("shop-web", [])).toBeNull();
  });

  it("knows which services the file builds (no registry digest for those)", () => {
    expect([...builtServices(file)]).toEqual(["web"]);
  });

  it("tags valid for Docker, also for long service names", () => {
    expect(snapshotTag("shop", "d1", "web")).toBe("serve/compose/shop:d1-web");
    const long = snapshotTag("shop", "abcdefghijklmnop", "s".repeat(200));
    expect(long.split(":")[1]).toMatch(/^abcdefghijklmnop-[0-9a-f]{16}$/);
  });
});
