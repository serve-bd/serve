import { describe, expect, it } from "vitest";
import { statefulMounts, uncoveredPaths, volumesFor } from "@/server/deploy/image-volumes";
import type { VolumeMount } from "@/server/services/types";

const vol = (source: string, mountPath: string, kind: VolumeMount["kind"] = "volume"): VolumeMount => ({ kind, source, mountPath });

describe("image VOLUME paths", () => {
  it("finds declared paths no mount covers", () => {
    expect(uncoveredPaths(["/var/lib/postgresql"], [])).toEqual(["/var/lib/postgresql"]);
    // The same path, a parent or a child of it covers it; a sibling with a common prefix does not.
    expect(uncoveredPaths(["/var/lib/postgresql/"], [vol("pg", "/var/lib/postgresql")])).toEqual([]);
    expect(uncoveredPaths(["/var/lib/postgresql"], [vol("pg", "/var/lib/postgresql/data")])).toEqual([]);
    expect(uncoveredPaths(["/data/db"], [vol("d", "/data", "bind")])).toEqual([]);
    expect(uncoveredPaths(["/data"], [vol("d", "/database")])).toEqual(["/data"]);
    expect(uncoveredPaths(["/data", "/data", "/logs"], [])).toEqual(["/data", "/logs"]);
  });

  it("names new volumes after the path, unique among the service's volumes", () => {
    expect(volumesFor(["/var/lib/postgresql", "/data", "/srv/data", "/"], [vol("data", "/other")])).toEqual([
      vol("postgresql", "/var/lib/postgresql"),
      vol("data-2", "/data"),
      vol("data-3", "/srv/data"),
      vol("data-4", "/"),
    ]);
    expect(volumesFor(["/opt/My App"], [])[0].source).toBe("my-app");
  });

  it("marks mounts on declared paths as holding the app's state", () => {
    const mounts = [vol("pg", "/var/lib/postgresql"), vol("conf", "/etc/app.conf", "file"), vol("cache", "/cache")];
    expect(statefulMounts(["/var/lib/postgresql"], mounts)).toEqual([mounts[0]]);
    expect(statefulMounts([], mounts)).toEqual([]);
  });
});
