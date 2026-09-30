import { describe, expect, it } from "vitest";
import { toVolumes, volumeName, volumeRowsIssue } from "@/app/(app)/projects/[projectId]/new/volume-rows";
import { volumeSchema } from "@/server/services/volume-schema";

describe("new service persistent storage", () => {
  it("names a volume after its container path", () => {
    expect(volumeName("/var/lib/app/data")).toBe("var-lib-app-data");
    expect(volumeName("/data/")).toBe("data");
    expect(volumeName("/")).toBe("data");
    expect(volumeName("/srv/my app/.cache")).toBe("srv-my-app-.cache");
  });
  it("turns filled rows into named volumes the server accepts", () => {
    const volumes = toVolumes([
      { mountPath: " /data ", name: "" },
      { mountPath: "/uploads", name: "files" },
      { mountPath: "", name: "ignored" },
    ]);
    expect(volumes).toEqual([
      { kind: "volume", source: "data", mountPath: "/data" },
      { kind: "volume", source: "files", mountPath: "/uploads" },
    ]);
    for (const v of volumes) expect(volumeSchema.safeParse(v).success).toBe(true);
  });
  it("reports rows that would not save", () => {
    expect(volumeRowsIssue([{ mountPath: "data", name: "" }])).toMatch(/start with/);
    expect(
      volumeRowsIssue([
        { mountPath: "/data", name: "" },
        { mountPath: "/data", name: "other" },
      ]),
    ).toMatch(/once/);
    expect(volumeRowsIssue([{ mountPath: "/data", name: "-bad" }])).toMatch(/Volume names/);
    expect(volumeRowsIssue([{ mountPath: "", name: "" }])).toBeNull();
  });
});
