import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSpec, gpuError } from "@/server/deploy/containers";
import { dnsOptionProblem, joinArgs, serverPlatform, splitArgs, sysctlProblem, ulimitProblem } from "@/server/deploy/options";
import { containerOptionsSchema } from "@/server/deploy/runtime-schema";
import { defaultRuntime, type RuntimeConfig } from "@/server/services/types";

const spec = (runtime: Partial<RuntimeConfig>) =>
  createSpec({ name: "c", image: "img", slug: "s", serviceId: "svc", kind: "app", env: {}, runtime: { ...defaultRuntime(), ...runtime }, aliases: [], network: "n" });
const schema = z.object(containerOptionsSchema).partial();
const errors = (value: unknown) => {
  const r = schema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("container options: validation", () => {
  it("accepts ulimits Docker knows, with soft at most hard", () => {
    expect(ulimitProblem({ name: "nofile", soft: 1024, hard: 65536 })).toBeNull();
    expect(ulimitProblem({ name: "memlock", soft: -1, hard: -1 })).toBeNull();
    expect(ulimitProblem({ name: "core", soft: 0, hard: -1 })).toBeNull();
    expect(ulimitProblem({ name: "files", soft: 1, hard: 1 })).toMatch(/not a limit/);
    expect(ulimitProblem({ name: "nofile", soft: 10, hard: 5 })).toMatch(/soft limit/);
    expect(ulimitProblem({ name: "nproc", soft: -1, hard: 5 })).toMatch(/soft limit/);
    expect(ulimitProblem({ name: "nofile", soft: 1, hard: 2_000_000 })).toMatch(/up to 1048576/);
    expect(ulimitProblem({ name: "nofile", soft: -1, hard: -1 })).toMatch(/cannot be unlimited/);
    expect(ulimitProblem({ name: "stack", soft: 1.5, hard: 2 })).toMatch(/whole number/);
    expect(
      errors({
        ulimits: [
          { name: "nofile", soft: 1, hard: 1 },
          { name: "nofile", soft: 2, hard: 2 },
        ],
      }),
    ).toEqual(["Set each limit once."]);
  });

  it("allows only sysctls of the container's own namespaces", () => {
    expect(sysctlProblem("net.core.somaxconn", "1024")).toBeNull();
    expect(sysctlProblem("net.ipv4.ip_unprivileged_port_start", "0")).toBeNull();
    expect(sysctlProblem("kernel.shmmax", "68719476736")).toBeNull();
    expect(sysctlProblem("fs.mqueue.msg_max", "100")).toBeNull();
    expect(sysctlProblem("kernel.sem", "250 32000 100 128")).toBeNull();
    expect(sysctlProblem("vm.overcommit_memory", "1")).toMatch(/whole server/);
    expect(sysctlProblem("kernel.hostname", "x")).toMatch(/whole server/);
    expect(sysctlProblem("fs.file-max", "1")).toMatch(/whole server/);
    expect(sysctlProblem("net.core.somaxconn", "1\n2")).toMatch(/value/);
    expect(errors({ sysctls: { "vm.swappiness": "1" } })[0]).toMatch(/whole server/);
  });

  it("checks DNS servers, search domains and resolver options", () => {
    expect(errors({ dns: ["1.1.1.1", "2606:4700:4700::1111"], dnsSearch: ["corp.internal"], dnsOptions: ["ndots:2", "timeout:1", "rotate"] })).toEqual([]);
    expect(errors({ dns: ["dns.google"] })).toEqual(["DNS servers are IP addresses, like 1.1.1.1."]);
    expect(errors({ dns: ["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4"] })).toEqual(["Containers use at most 3 DNS servers."]);
    expect(errors({ dnsSearch: ["bad domain"] })).toEqual(["Use domains like example.internal"]);
    expect(dnsOptionProblem("ndots")).toMatch(/needs a number/);
    expect(dnsOptionProblem("rotate:1")).toMatch(/takes no value/);
    expect(dnsOptionProblem("evil;rm")).toMatch(/not a resolver option/);
  });

  it("checks devices, GPUs, platform and pull policy", () => {
    expect(errors({ devices: [{ host: "/dev/ttyUSB0" }, { host: "/dev/dri/renderD128", container: "/dev/dri/renderD128", permissions: "rw" }], gpus: "all" })).toEqual([]);
    expect(errors({ devices: [{ host: "/etc/shadow" }] })).toHaveLength(1);
    expect(errors({ devices: [{ host: "/dev/../etc/shadow" }] })).toHaveLength(1);
    expect(errors({ gpus: 0 })).toHaveLength(1);
    expect(errors({ gpus: 2, platform: "linux/arm64", pullPolicy: "missing" })).toEqual([]);
    expect(errors({ platform: "windows/amd64" })).toHaveLength(1);
  });

  it("splits entrypoints like a shell and joins them back", () => {
    expect(splitArgs(`/bin/sh -c "echo hi && ls" 'a b' c\\ d`)).toEqual(["/bin/sh", "-c", "echo hi && ls", "a b", "c d"]);
    expect(() => splitArgs(`"open`)).toThrow(/quote/);
    const args = ["tini", "--", "it's", "a b", ""];
    expect(splitArgs(joinArgs(args))).toEqual(args);
  });

  it("maps docker info architectures to platforms", () => {
    expect(serverPlatform("x86_64")).toBe("linux/amd64");
    expect(serverPlatform("aarch64")).toBe("linux/arm64");
    expect(serverPlatform("armv7l")).toBe("linux/arm/v7");
    expect(serverPlatform(undefined)).toBeNull();
  });
});

describe("container options: Docker create options", () => {
  it("leaves everything unset by default", () => {
    const out = spec({});
    expect(out).not.toHaveProperty("platform");
    expect(out.Entrypoint).toBeUndefined();
    for (const key of ["Ulimits", "Sysctls", "Dns", "DnsSearch", "DnsOptions", "Devices", "DeviceRequests"] as const) expect(out.HostConfig?.[key]).toBeUndefined();
  });

  it("passes each option to Docker", () => {
    const out = spec({
      entrypoint: ["/bin/sh", "-c"],
      ulimits: [{ name: "nofile", soft: 1024, hard: 4096 }],
      sysctls: { "net.core.somaxconn": "1024" },
      dns: ["1.1.1.1"],
      dnsSearch: ["corp.internal"],
      dnsOptions: ["ndots:2"],
      devices: [{ host: "/dev/ttyUSB0" }, { host: "/dev/dri/card0", container: "/dev/card", permissions: "rw" }],
      gpus: "all",
      platform: "linux/arm64",
    });
    expect(out.Entrypoint).toEqual(["/bin/sh", "-c"]);
    expect((out as { platform?: string }).platform).toBe("linux/arm64");
    expect(out.HostConfig).toMatchObject({
      Ulimits: [{ Name: "nofile", Soft: 1024, Hard: 4096 }],
      Sysctls: { "net.core.somaxconn": "1024" },
      Dns: ["1.1.1.1"],
      DnsSearch: ["corp.internal"],
      DnsOptions: ["ndots:2"],
      Devices: [
        { PathOnHost: "/dev/ttyUSB0", PathInContainer: "/dev/ttyUSB0", CgroupPermissions: "rwm" },
        { PathOnHost: "/dev/dri/card0", PathInContainer: "/dev/card", CgroupPermissions: "rw" },
      ],
      DeviceRequests: [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] }],
    });
    expect(spec({ gpus: 2 }).HostConfig?.DeviceRequests).toEqual([{ Driver: "nvidia", Count: 2, Capabilities: [["gpu"]] }]);
  });

  it("explains a server without GPU support", () => {
    const docker = new Error('(HTTP code 500) server error - could not select device driver "nvidia" with capabilities: [[gpu]]');
    expect(gpuError(docker, { gpus: "all" })?.message).toMatch(/NVIDIA Container Toolkit is missing/);
    expect(gpuError(docker, { gpus: null })).toBeNull();
    expect(gpuError(new Error("port is already allocated"), { gpus: 1 })).toBeNull();
  });
});
