/** A Persistent storage row of the image form: where the container keeps data, and an optional volume name. */
export type VolumeRow = { mountPath: string; name: string };

/** Volume name for a container path: /var/lib/app/data becomes var-lib-app-data. */
export function volumeName(mountPath: string) {
  const slug = mountPath
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[^a-zA-Z0-9]+|-+$/g, "")
    .slice(0, 100);
  return slug || "data";
}

/** Named volumes for the filled-in rows; blank rows are skipped. */
export function toVolumes(rows: VolumeRow[]) {
  return rows.filter((r) => r.mountPath.trim()).map((r) => ({ kind: "volume" as const, source: r.name.trim() || volumeName(r.mountPath.trim()), mountPath: r.mountPath.trim() }));
}

/** What keeps the rows from saving, or null. */
export function volumeRowsIssue(rows: VolumeRow[]) {
  const volumes = toVolumes(rows);
  if (volumes.some((v) => !v.mountPath.startsWith("/"))) return "Container paths start with /.";
  if (new Set(volumes.map((v) => v.mountPath)).size < volumes.length) return "Each container path can be used once.";
  if (volumes.some((v) => !/^[a-zA-Z0-9][\w.-]*$/.test(v.source))) return "Volume names use letters, numbers, dots and dashes.";
  return null;
}
