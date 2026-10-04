import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

/** A select whose steps return themselves until `where`, which resolves to `rows`. */
function chain(rows: unknown[], calls: string[], tag: string) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin"]) c[m] = () => c;
  c.where = () => {
    calls.push(tag);
    return Promise.resolve(rows);
  };
  return c;
}

const state = vi.hoisted(() => ({ calls: [] as string[], running: 0 }));

vi.mock("@/server/db", async () => {
  const schema = await import("@/server/db/schema");
  const tx = {
    execute: async () => void state.calls.push("lock"),
    select: () => chain([{ n: state.running }], state.calls, "count"),
  };
  return {
    schema,
    db: {
      select: () => chain([], state.calls, "limits"),
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});
vi.mock("@/server/settings", () => ({ getSettings: async () => ({ rootOrganizationId: "root", defaultOrgLimits: { concurrentBuilds: 2 } }) }));
vi.mock("@/server/docker/client", () => ({ docker: {}, LABEL: {}, listServiceContainers: vi.fn() }));
vi.mock("@/server/servers/context", () => ({ serverOf: vi.fn() }));

import { JobTimeout, jobTimeoutMinutes } from "@/lib/job-timeouts";
import { claimBuildSlot } from "@/server/limits";
import { execCommand, killMarkedScript } from "@/server/services/exec";

describe("job time limits", () => {
  it("gives long work hours and quick syncs minutes", () => {
    expect(jobTimeoutMinutes("deploy")).toBe(120);
    // A server's own deployment limit wins, shorter or longer than the build's.
    expect(jobTimeoutMinutes("deploy", { serverDeployMinutes: 15, buildTimeoutMinutes: 240 })).toBe(15);
    expect(jobTimeoutMinutes("deploy", { serverDeployMinutes: 600 })).toBe(600);
    expect(jobTimeoutMinutes("backup.restore")).toBeGreaterThanOrEqual(120);
    expect(jobTimeoutMinutes("server.setup")).toBe(120);
    expect(jobTimeoutMinutes("proxy.sync")).toBeLessThanOrEqual(30);
    expect(jobTimeoutMinutes("tunnel.sync")).toBeLessThanOrEqual(30);
    expect(jobTimeoutMinutes("certificate.issue")).toBeLessThanOrEqual(30);
    expect(jobTimeoutMinutes("something-new")).toBe(60);
  });

  it("outlives the build timeout a service set, and a task's own timeout", () => {
    expect(jobTimeoutMinutes("deploy", { buildTimeoutMinutes: 30 })).toBe(120);
    expect(jobTimeoutMinutes("deploy", { buildTimeoutMinutes: 240 })).toBe(300);
    expect(jobTimeoutMinutes("task.run", { taskTimeoutSeconds: 86_400 })).toBe(1440 + 15);
    expect(jobTimeoutMinutes("task.run", { taskTimeoutSeconds: 60 })).toBe(120);
  });

  it("says plainly why the job stopped", () => {
    const reason = new JobTimeout(30);
    expect(reason).toBeInstanceOf(Error);
    expect(reason.message).toMatch(/after 30 minutes/);
  });
});

describe("organization build slots", () => {
  it("counts under the lock and claims only with a free slot", async () => {
    state.calls.length = 0;
    state.running = 1;
    const claim = vi.fn(async () => true);
    expect(await claimBuildSlot("org", "dep", claim)).toEqual({ value: true });
    expect(state.calls.indexOf("lock")).toBeLessThan(state.calls.indexOf("count"));
    expect(claim).toHaveBeenCalledOnce();

    state.running = 2;
    claim.mockClear();
    expect(await claimBuildSlot("org", "dep", claim)).toBeNull();
    expect(claim).not.toHaveBeenCalled();
  });

  it("claims without a lock when the deploy belongs to no organization", async () => {
    state.calls.length = 0;
    expect(await claimBuildSlot(null, "dep", async () => false)).toEqual({ value: false });
    expect(state.calls).not.toContain("lock");
  });
});

describe("exec timeout", () => {
  it("runs a second exec that kills the timed out command's processes", async () => {
    const execs: { Cmd: string[]; Env?: string[] }[] = [];
    const docker = {
      getContainer: () => ({
        exec: async (opts: { Cmd: string[]; Env?: string[] }) => {
          execs.push(opts);
          const first = execs.length === 1;
          return {
            start: async () => {
              const stream = new PassThrough();
              // The command never ends; the killer ends at once.
              if (!first) setTimeout(() => stream.end(), 5);
              return stream;
            },
            inspect: async () => ({ Running: first, ExitCode: null }),
          };
        },
      }),
      modem: { demuxStream: (stream: PassThrough, out: PassThrough) => stream.pipe(out) },
    } as never;
    const result = await execCommand("c", "sleep 1000", { docker, timeoutSeconds: 0.05 });
    expect(result).toMatchObject({ timedOut: true, exitCode: 124 });
    expect(execs).toHaveLength(2);
    const marker = execs[0].Env?.find((e) => e.startsWith("SERVE_EXEC="));
    expect(marker).toMatch(/^SERVE_EXEC=[0-9a-f]{16}$/);
    expect(execs[1].Cmd.join(" ")).toContain(marker);
    // The killer must not carry the marker, or it would kill itself.
    expect(execs[1].Env ?? []).not.toContain(marker);
  });

  it("does not run the killer when the command finished", async () => {
    let count = 0;
    const docker = {
      getContainer: () => ({
        exec: async () => {
          count++;
          return {
            start: async () => {
              const stream = new PassThrough();
              setTimeout(() => stream.end(), 5);
              return stream;
            },
            inspect: async () => ({ Running: false, ExitCode: 0 }),
          };
        },
      }),
      modem: { demuxStream: (stream: PassThrough, out: PassThrough) => stream.pipe(out) },
    } as never;
    await execCommand("c", "true", { docker });
    expect(count).toBe(1);
  });

  it("kills exactly the marked processes", async () => {
    const marker = "SERVE_EXEC=0123456789abcdef";
    const marked = spawn("sh", ["-c", "sleep 30 & wait"], { env: { ...process.env, SERVE_EXEC: "0123456789abcdef" }, stdio: "ignore" });
    const other = spawn("sleep", ["30"], { stdio: "ignore" });
    const exited = new Promise((r) => marked.on("exit", r));
    await new Promise((r) => setTimeout(r, 100));
    execFileSync("sh", ["-c", killMarkedScript(marker)]);
    await exited;
    expect(marked.signalCode).toBe("SIGKILL");
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
    other.kill();
  });

  it("refuses a marker that could break out of the script", () => {
    expect(() => killMarkedScript("SERVE_EXEC=x'; reboot; '")).toThrow();
  });
});
