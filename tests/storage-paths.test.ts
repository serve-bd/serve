import { describe, expect, it } from "vitest";
import { blockedPath } from "@/server/backups/storage";

const remote = { root: "/opt/serve", service: (id: string) => `/opt/serve/services/${id}` };

describe("storage backup paths", () => {
  it("allows folders below the compose project's directory", () => {
    expect(blockedPath("/opt/serve/services/svc1/compose/uploads", remote, "svc1", ["/opt/serve/services/svc1/compose"])).toBe(false);
    expect(blockedPath("/opt/serve/services/svc1/repo/apps/web/data/", remote, "svc1", ["/opt/serve/services/svc1/repo/apps/web"])).toBe(false);
  });
  it("blocks the project directory and its parents, which hold the stack's .env", () => {
    const dirs = ["/opt/serve/services/svc1/repo/apps/web"];
    expect(blockedPath("/opt/serve/services/svc1/repo/apps/web", remote, "svc1", dirs)).toBe(true);
    expect(blockedPath("/opt/serve/services/svc1/repo/apps/web/", remote, "svc1", dirs)).toBe(true);
    expect(blockedPath("/opt/serve/services/svc1/repo", remote, "svc1", dirs)).toBe(true);
    expect(blockedPath("/opt/serve/services/svc1/tls", remote, "svc1", dirs)).toBe(true);
    expect(blockedPath("/opt/serve/services/svc1/repo/apps/web/../../..", remote, "svc1", dirs)).toBe(true);
    expect(blockedPath("/opt/serve/services/svc1/compose/uploads", remote, "svc1")).toBe(true);
  });
  it("blocks the server's data folder, other services and system folders", () => {
    expect(blockedPath("/opt/serve/proxy/certs", remote, "svc1")).toBe(true);
    expect(blockedPath("/opt/serve/services/svc2/compose/uploads", remote, "svc1")).toBe(true);
    expect(blockedPath("/opt/serve/services/svc1", remote, "svc1")).toBe(true);
    expect(blockedPath("/etc/ssl", remote, "svc1")).toBe(true);
    expect(blockedPath("/var/run/docker.sock", remote, "svc1")).toBe(true);
  });
  it("allows ordinary host folders", () => {
    expect(blockedPath("/srv/media", remote, "svc1")).toBe(false);
  });
});
