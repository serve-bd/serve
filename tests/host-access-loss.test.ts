import { describe, expect, it } from "vitest";
import { defaultRuntime, hostAccessLoss, withoutHostAccess } from "@/server/services/types";

describe("copies without host access", () => {
  it("drop host options, swap and a CPU weight over the default, and say so", () => {
    const r = {
      ...defaultRuntime(3000),
      privileged: true,
      swapLimit: 2048,
      memoryLimit: 512,
      cpuWeight: 4096,
      volumes: [{ kind: "bind" as const, source: "/srv", target: "/data" }],
    };
    const copy = withoutHostAccess(r as never);
    expect(copy).toMatchObject({ privileged: false, swapLimit: null, cpuWeight: null, volumes: [] });
    const note = hostAccessLoss(r as never);
    expect(note).toContain("bind mounts");
    expect(note).toContain("privileged mode");
    expect(note).toContain("swap");
    expect(note).toContain("CPU weight");
  });

  it("keep what never reaches past the organization's limits", () => {
    const r = { ...defaultRuntime(3000), swapLimit: 0, memoryLimit: 512, cpuWeight: 512 };
    expect(withoutHostAccess(r)).toMatchObject({ swapLimit: 0, cpuWeight: 512 });
    expect(hostAccessLoss(r)).toBeNull();
  });
});
