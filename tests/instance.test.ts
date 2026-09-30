import { describe, expect, it } from "vitest";
import { buildManifest, bundleName, compareVersions, expiredBackups, nextImage, scheduleDue } from "@/server/instance/manifest";
import type { InstanceBackup } from "@/server/settings";

const b = (id: string, createdAt: string, status: InstanceBackup["status"] = "success"): InstanceBackup => ({
  id,
  createdAt,
  finishedAt: null,
  status,
  trigger: "schedule",
  filename: `${id}.tar.gz`,
  size: 1,
  s3Key: null,
  s3Status: null,
  error: null,
  version: "0.1.0",
});

describe("instance backup manifest", () => {
  it("describes the bundle and never includes the key", () => {
    const m = buildManifest({
      version: "0.2.0",
      commit: "abc",
      schemaVersion: "0017_x",
      createdAt: new Date("2026-01-02T03:04:05Z"),
      files: ["proxy", "certs"],
      pgServerVersion: "17.2",
    });
    expect(m.kind).toBe("serve-instance-backup");
    expect(m.files).toEqual(["certs", "proxy"]);
    expect(m.encryptionKeyIncluded).toBe(false);
    expect(m.excluded).toContain(".env");
    expect(m.database.file).toBe("database.dump");
  });
  it("names bundles sortably", () => {
    expect(bundleName(new Date("2026-01-02T03:04:05.678Z"), "0.2.0")).toBe("serve-2026-01-02T03-04-05-v0.2.0.tar.gz.enc");
  });
});

describe("retention", () => {
  const list = [b("a", "2026-01-05"), b("b", "2026-01-04"), b("f", "2026-01-03", "failed"), b("c", "2026-01-02"), b("r", "2026-01-01", "running")];
  it("keeps the newest successes and drops older failures", () => {
    expect(expiredBackups(list, 2).map((x) => x.id)).toEqual(["f", "c"]);
  });
  it("never deletes a running backup and keeps at least one", () => {
    const ids = expiredBackups(list, 0).map((x) => x.id);
    expect(ids).not.toContain("r");
    expect(ids).not.toContain("a");
  });
  it("keeps failures newer than the last success", () => {
    expect(expiredBackups([b("x", "2026-01-06", "failed"), b("a", "2026-01-05")], 1)).toEqual([]);
  });
});

describe("schedule", () => {
  it("fires once within the minute after the cron time", () => {
    const now = new Date("2026-01-01T03:00:30Z");
    const due = scheduleDue("0 3 * * *", now, "UTC", null);
    expect(due).toBe("2026-01-01T03:00:00.000Z");
    expect(scheduleDue("0 3 * * *", now, "UTC", due)).toBeNull();
  });
  it("does not fire outside that minute or for invalid crons", () => {
    expect(scheduleDue("0 3 * * *", new Date("2026-01-01T03:02:00Z"), "UTC", null)).toBeNull();
    expect(scheduleDue("not a cron", new Date(), "UTC", null)).toBeNull();
  });
});

describe("versions", () => {
  it("compares numerically", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("v1.2.0", "1.2")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
  });
  it("pins the image to the new version", () => {
    expect(nextImage("ghcr.io/shahriyardx/serve:0.1.0", "v0.2.0")).toBe("ghcr.io/shahriyardx/serve:0.2.0");
    expect(nextImage("ghcr.io/shahriyardx/serve:latest", "0.2.0")).toBe("ghcr.io/shahriyardx/serve:0.2.0");
    expect(nextImage("ghcr.io/shahriyardx/serve:edge", "0.2.0")).toBe("ghcr.io/shahriyardx/serve:0.2.0");
    expect(nextImage("localhost:5000/serve", "0.2.0")).toBe("localhost:5000/serve:0.2.0");
    expect(nextImage("ghcr.io/shahriyardx/serve@sha256:abc", "0.2.0")).toBe("ghcr.io/shahriyardx/serve:0.2.0");
  });
});
