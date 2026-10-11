import { describe, expect, it } from "vitest";
import { lineTone } from "@/components/log-viewer";

describe("log line colors", () => {
  it("does not color counts of zero or empty error fields", () => {
    expect(lineTone('200 {"ok":true,"backups":{"failed":0},"abandoned":{"failed":0}}')).toBe("");
    expect(lineTone("done: errors=0 warnings=0")).toBe("");
    expect(lineTone('{"error":null,"warnings":[]}')).toBe("");
    expect(lineTone("failures: 0, exceptions: none")).toBe("");
  });
  it("still colors real problems", () => {
    expect(lineTone('{"failed":2}')).toBe("err");
    expect(lineTone("Error: connect ECONNREFUSED")).toBe("err");
    expect(lineTone('{"error":"timeout"}')).toBe("err");
    expect(lineTone("request failed after 3 tries")).toBe("err");
    expect(lineTone("warning: disk almost full")).toBe("warn");
    expect(lineTone('ok, but "failed":0 and then a fatal crash')).toBe("err");
  });
});
