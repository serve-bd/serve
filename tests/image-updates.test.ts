import { describe, expect, it } from "vitest";
import { newerVersionTag } from "@/lib/image-versions";

describe("newer version tags", () => {
  it("picks the highest tag of the same form", () => {
    const tags = ["latest", "7-alpine", "8-alpine", "9-alpine", "9", "10-rc1-alpine", "9.1-alpine", "8.10-alpine"];
    expect(newerVersionTag("8-alpine", tags)).toBe("9-alpine");
    expect(newerVersionTag("8.4", ["8.4", "9.7", "26", "9.7.1", "10.0-rc"])).toBe("9.7");
    expect(newerVersionTag("v1.4.2", ["v1.4.10", "1.5.0", "v1.5.0-beta", "v1.4.3"])).toBe("v1.4.10");
  });

  it("finds nothing above the newest, or for tags that are not versions", () => {
    expect(newerVersionTag("9-alpine", ["8-alpine", "9-alpine"])).toBeNull();
    expect(newerVersionTag("latest", ["9", "10"])).toBeNull();
    expect(newerVersionTag("stable-alpine", ["stable-alpine", "9-alpine"])).toBeNull();
  });
});
