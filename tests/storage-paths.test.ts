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
  it("blocks the files Serve writes in the project directory", () => {
    const dirs = ["/opt/serve/services/svc1/compose"];
    expect(blockedPath("/opt/serve/services/svc1/compose/.env", remote, "svc1", dirs)).toBe(true);
    expect(blockedPath("/opt/serve/services/svc1/compose/.serve-compose.yml", remote, "svc1", dirs)).toBe(true);
    expect(blockedPath("/opt/serve/services/svc1/compose/config/.env", remote, "svc1", dirs)).toBe(false);
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

describe("storage backups through symbolic links", () => {
  it("judges a linked folder by where it really is", async () => {
    const { execSync } = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { stackStorage } = await import("@/server/backups/storage");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "serve-links-"));
    const project = path.join(root, "services/svc1/compose");
    fs.mkdirSync(path.join(project, "data"), { recursive: true });
    fs.symlinkSync("/etc", path.join(project, "escape"));
    const bind = (Source: string) => ({ Type: "bind", Source, Destination: "/x" });
    const docker = {
      listContainers: async () => [
        {
          Id: "c1",
          Names: ["/web"],
          Labels: { "com.docker.compose.project.working_dir": project },
          Mounts: [bind(path.join(project, "data")), bind(path.join(project, "escape"))],
        },
      ],
    };
    const exec = async (command: string) => ({ code: 0, stdout: execSync(command, { shell: "/bin/sh" }).toString() });
    try {
      const found = await stackStorage({ docker: docker as never, paths: { root, service: (id) => path.join(root, "services", id) }, exec }, "svc1");
      expect(found.map((f) => f.source)).toEqual([path.join(project, "data")]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
