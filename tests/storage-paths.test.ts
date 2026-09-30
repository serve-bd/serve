import { describe, expect, it } from "vitest";
import { blockedPath } from "@/server/backups/storage";

const remote = { root: "/opt/serve", service: (id: string) => `/opt/serve/services/${id}` };

describe("storage backup paths", () => {
  it("allows folders inside the service's own folder", () => {
    expect(blockedPath("/opt/serve/services/svc1/compose/uploads", remote, "svc1")).toBe(false);
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
