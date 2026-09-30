import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/safe-next";

describe("safeNextPath", () => {
  it("keeps paths on the dashboard", () => {
    expect(safeNextPath("/projects/abc?tab=logs#top")).toBe("/projects/abc?tab=logs#top");
    expect(safeNextPath("/")).toBe("/");
  });

  it("refuses anything that could lead to another site", () => {
    for (const next of ["//evil.com", "/\\evil.com", "/\\/evil.com", "/\t/evil.com", "/\n/evil.com", "https://evil.com", "evil.com", "", undefined, ["/a"]]) {
      expect(safeNextPath(next), String(next)).toBe("/");
    }
  });
});
