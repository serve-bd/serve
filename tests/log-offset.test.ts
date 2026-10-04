import { describe, expect, it } from "vitest";
import { dockerSince, logsFrom } from "@/lib/log-offset";

describe("deployment log offsets", () => {
  const log = "==> Building\nstep 1\nstep 2\n";

  it("answers everything without an offset", () => {
    expect(logsFrom(log, undefined)).toEqual({ logs: log, offset: log.length });
    expect(logsFrom(log, 0)).toEqual({ logs: log, offset: log.length });
  });

  it("answers only what came after the offset", () => {
    const first = logsFrom("==> Building\n", undefined);
    expect(logsFrom(log, first.offset)).toEqual({ logs: "step 1\nstep 2\n", offset: log.length });
    expect(logsFrom(log, log.length)).toEqual({ logs: "", offset: log.length });
  });

  it("starts over when the log got shorter than the offset", () => {
    expect(logsFrom("tail only\n", 5000)).toEqual({ logs: "tail only\n", offset: 10 });
  });

  it("ignores a negative offset", () => {
    expect(logsFrom(log, -3).logs).toBe(log);
  });
});

describe("container log since", () => {
  it("takes Unix seconds as they are", () => {
    expect(dockerSince("1700000000")).toBe("1700000000");
    expect(dockerSince("1700000000.5")).toBe("1700000000.5");
  });

  it("turns RFC 3339 times into seconds with nanoseconds", () => {
    expect(dockerSince("2023-11-14T22:13:20Z")).toBe("1700000000.000000000");
    expect(dockerSince("2023-11-14T22:13:20.25Z")).toBe("1700000000.250000000");
    expect(dockerSince("2023-11-14T22:13:20.123456789Z")).toBe("1700000000.123456789");
    expect(dockerSince("2023-11-15T00:13:20+02:00")).toBe("1700000000.000000000");
  });

  it("refuses anything else", () => {
    expect(dockerSince("yesterday")).toBeNull();
    expect(dockerSince("2023-13-45T99:00:00Z")).toBeNull();
    expect(dockerSince("")).toBeNull();
  });
});
