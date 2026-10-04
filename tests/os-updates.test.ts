import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = "postgres://test@127.0.0.1:1/test";
process.env.BETTER_AUTH_SECRET = "test-secret-for-os-updates";
const { DOCKER_PACKAGE, parseCheck, upgradeCommand } = await import("@/server/servers/os-updates");

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures/os-updates", `${name}.txt`), "utf8");

describe("OS update checks", () => {
  it("reads each package manager's list (real output)", () => {
    for (const [name, manager] of [
      ["debian_12.0", "apt"],
      ["alpine_3.19.0", "apk"],
      ["fedora_39", "dnf"],
      ["opensuse_leap_15.5", "zypper"],
      ["archlinux_base-20240101.0.204074", "pacman"],
    ] as const) {
      const r = parseCheck(fixture(name));
      expect(r.manager, name).toBe(manager);
      expect(r.packages.length, name).toBeGreaterThan(0);
      for (const p of r.packages) expect(p.name, name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._+:@-]*$/);
    }
    const apt = parseCheck(fixture("debian_12.0")).packages.find((p) => p.name === "bash");
    expect(apt).toMatchObject({ current: "5.2.15-2+b2", next: "5.2.15-2+b13" });
  });

  it("marks Docker's packages, and parses apt lines with Docker on them", () => {
    const out =
      "__PM__=apt\n__LIST__\ndocker-ce/bookworm 5:28.0.0-1 amd64 [upgradable from: 5:27.5.1-1]\ncontainerd.io/bookworm 1.7.25-1 amd64 [upgradable from: 1.7.24-1]\ncurl/bookworm 7.88.1-10+deb12u12 amd64 [upgradable from: 7.88.1-10+deb12u8]\n__REBOOT__\n";
    const r = parseCheck(out);
    expect(r.rebootRequired).toBe(true);
    expect(r.packages.map((p) => [p.name, p.docker])).toEqual([
      ["docker-ce", true],
      ["containerd.io", true],
      ["curl", false],
    ]);
    expect(DOCKER_PACKAGE.test("docker-compose-plugin")).toBe(true);
    expect(DOCKER_PACKAGE.test("dockerfile-lint")).toBe(false);
  });

  it("builds install commands that keep names one word, and refuses others", () => {
    expect(upgradeCommand("apt", ["curl"], [])).toContain("--only-upgrade");
    expect(upgradeCommand("pacman", ["acl"], ["docker", "containerd"])).toBe("pacman -Syu --noconfirm --ignore 'docker','containerd'");
    expect(() => upgradeCommand("apt", ["curl; rm -rf /"], [])).toThrow(/not a package name/);
  });

  it("never refreshes pacman's database: without checkupdates there is no list", async () => {
    const { CHECK_SCRIPT } = await import("@/server/servers/os-updates");
    expect(CHECK_SCRIPT).not.toMatch(/pacman -Sy/);
    expect(parseCheck("__PM__=pacman\n__NOCHECKUPDATES__\n").packages).toEqual([]);
  });

  it("finds no manager on a system without one", () => {
    expect(parseCheck("__PM__=none\n")).toEqual({ manager: null, packages: [], rebootRequired: false });
  });
});
