import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
vi.mock("@/server/docker/client", () => ({ docker: {}, LABEL: {}, listServiceContainers: vi.fn() }));
vi.mock("@/server/servers/context", () => ({ serverOf: vi.fn() }));

import { execCommand } from "@/server/services/exec";

/** A Docker client whose exec ends its output at once and reports `states` on each inspect. */
function fakeDocker(states: { Running: boolean; ExitCode: number | null }[]) {
  let n = 0;
  const exec = {
    start: async () => {
      const stream = new PassThrough();
      setTimeout(() => stream.end(), 5);
      return stream;
    },
    inspect: async () => states[Math.min(n++, states.length - 1)],
  };
  return {
    getContainer: () => ({ exec: async () => exec }),
    modem: { demuxStream: (stream: PassThrough, out: PassThrough) => stream.pipe(out) },
  } as never;
}

describe("execCommand exit code", () => {
  it("waits for the exit code Docker sets just after the output ends", async () => {
    const docker = fakeDocker([
      { Running: true, ExitCode: null },
      { Running: false, ExitCode: 3 },
    ]);
    expect((await execCommand("c", "false", { docker })).exitCode).toBe(3);
  });

  it("does not count an unknown exit code as a success", async () => {
    const docker = fakeDocker([{ Running: false, ExitCode: null }]);
    expect((await execCommand("c", "true", { docker })).exitCode).toBe(1);
  });

  it("keeps a real success", async () => {
    const docker = fakeDocker([{ Running: false, ExitCode: 0 }]);
    expect((await execCommand("c", "true", { docker })).exitCode).toBe(0);
  });
});
