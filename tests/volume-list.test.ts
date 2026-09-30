import { describe, expect, it } from "vitest";
import { volumeListSchema } from "@/server/services/volume-schema";

describe("volumeListSchema", () => {
  it("accepts distinct container paths", () => {
    const r = volumeListSchema.safeParse([
      { kind: "volume", source: "data", mountPath: "/data" },
      { kind: "file", source: "app.conf", mountPath: "/etc/app.conf", content: "" },
    ]);
    expect(r.success).toBe(true);
  });

  it("refuses one path mounted twice, also with a trailing slash", () => {
    const r = volumeListSchema.safeParse([
      { kind: "volume", source: "a", mountPath: "/data" },
      { kind: "volume", source: "b", mountPath: "/data/" },
    ]);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toMatch(/mounted twice/);
  });

  it("refuses a mount on / itself", () => {
    const r = volumeListSchema.safeParse([{ kind: "volume", source: "root", mountPath: "/" }]);
    expect(r.success).toBe(false);
  });
});
