import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "@/server/net/public-fetch";
import { composeNameClashes, composeSecurityIssues, maskCommand } from "@/server/security";

describe("security fixes", () => {
  it("treats every spelling of a private address as private", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1%eth0"]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    // IPv4-mapped IPv6, dotted and hex, and IPv4 carried by NAT64.
    for (const a of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "[::1]"]) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(a), a).toBe(false);
    expect(isPrivateAddress("not an ip")).toBe(true);
  });

  it("hides secret values in a container command", () => {
    expect(maskCommand(["redis-server", "--requirepass", "s3cret", "--appendonly", "yes"])).toEqual(["redis-server", "--requirepass", "********", "--appendonly", "yes"]);
    expect(maskCommand(["app", "--password=hunter2", "-a", "x"])).toEqual(["app", "--password=********", "-a", "********"]);
    expect(maskCommand(["node", "server.js"])).toEqual(["node", "server.js"]);
  });

  it("refuses compose names that belong to other services", () => {
    const file = `services:
  web:
    image: nginx
    container_name: api-x7k2p9
  api-x7k2p9-worker:
    image: busybox
    networks:
      default:
        aliases: [db-q1w2e3]
`;
    const issues = composeNameClashes(file, ["api-x7k2p9", "db-q1w2e3"]);
    expect(issues).toHaveLength(3);
    expect(composeNameClashes("services:\n  web:\n    image: nginx\n", ["api-x7k2p9"])).toEqual([]);
  });

  it("flags host ports in a compose file", () => {
    expect(composeSecurityIssues("services:\n  a:\n    image: x\n    ports: ['8080:80']\n").join()).toMatch(/ports/);
    expect(composeSecurityIssues("services:\n  a:\n    image: x\n    expose: ['80']\n")).toEqual([]);
  });
});
