import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { composeMountProblems, composeVolumeName, readComposeMounts, writeComposeMounts } from "@/lib/compose-mounts";

const file = `# Mattermost
services:
  app:
    image: mattermost/mattermost-team-edition
    volumes:
      - config:/mattermost/config # settings
      - /srv/plugins:/mattermost/plugins:ro
      - type: tmpfs
        target: /tmp
      - \${DATA_DIR}:/data
  db:
    image: postgres:17
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  config:
  pgdata:
    driver: local
`;

describe("compose storage", () => {
  it("reads every kind of mount", () => {
    const [app, db] = readComposeMounts(file);
    expect(app.service).toBe("app");
    expect(app.mounts).toEqual([
      { kind: "volume", source: "config", target: "/mattermost/config", readOnly: undefined },
      { kind: "bind", source: "/srv/plugins", target: "/mattermost/plugins", readOnly: true },
      { kind: "other", from: "volumes", index: 2, target: "/tmp", label: "Temporary (tmpfs)" },
      { kind: "other", from: "volumes", index: 3, target: "/data", label: "Path from a variable (${DATA_DIR})" },
    ]);
    expect(db.mounts).toHaveLength(1);
  });

  it("adds volumes and files, keeps comments and untouched entries", () => {
    const [app] = readComposeMounts(file);
    const next = writeComposeMounts(file, "app", [
      ...app.mounts,
      { kind: "volume", source: "data", target: "/mattermost/data" },
      { kind: "file", name: "app.env", target: "/etc/app.env", content: "PRICE=$5\n" },
    ]);
    expect(next).toContain("# Mattermost");
    expect(next).toContain("# settings");
    const doc = YAML.parse(next);
    expect(doc.services.app.volumes).toEqual([
      "config:/mattermost/config",
      "/srv/plugins:/mattermost/plugins:ro",
      { type: "tmpfs", target: "/tmp" },
      "${DATA_DIR}:/data",
      "data:/mattermost/data",
    ]);
    expect(doc.services.app.configs).toEqual([{ source: "app.env", target: "/etc/app.env" }]);
    // Compose interpolates inline content: the dollar is escaped, and read back as written.
    expect(doc.configs["app.env"].content).toBe("PRICE=$$5\n");
    expect(Object.keys(doc.volumes)).toEqual(["config", "pgdata", "data"]);
    const [again] = readComposeMounts(next);
    expect(again.mounts.at(-1)).toEqual({ kind: "file", name: "app.env", target: "/etc/app.env", content: "PRICE=$5\n" });
  });

  it("removes mounts and the declarations nothing uses any more", () => {
    const withFile = writeComposeMounts(file, "app", [{ kind: "file", name: "a.conf", target: "/a.conf", content: "x" }]);
    const doc = YAML.parse(withFile);
    // config was an empty declaration: removed. pgdata has settings (and is used): kept.
    expect(Object.keys(doc.volumes)).toEqual(["pgdata"]);
    const cleared = YAML.parse(writeComposeMounts(withFile, "app", []));
    expect(cleared.services.app.volumes).toBeUndefined();
    expect(cleared.services.app.configs).toBeUndefined();
    expect(cleared.configs).toBeUndefined();
  });

  it("refuses bad mounts", () => {
    expect(composeMountProblems([{ kind: "volume", source: "bad name", target: "rel" }])).toHaveLength(2);
    expect(
      composeMountProblems([
        { kind: "volume", source: "a", target: "/x" },
        { kind: "volume", source: "b", target: "/x" },
      ]),
    ).toEqual(["/x is mounted twice"]);
    expect(() => writeComposeMounts(file, "nope", [])).toThrow(/no service nope/);
  });

  it("writes server files so Docker does not create a directory for them", () => {
    const out = writeComposeMounts("services:\n  a:\n    image: x\n", "a", [{ kind: "bind", source: "/etc/ca.pem", target: "/ca.pem", readOnly: true, hostType: "file" }]);
    expect(YAML.parse(out).services.a.volumes).toEqual([{ type: "bind", source: "/etc/ca.pem", target: "/ca.pem", read_only: true, bind: { create_host_path: false } }]);
    expect(readComposeMounts(out)[0].mounts).toEqual([{ kind: "bind", source: "/etc/ca.pem", target: "/ca.pem", readOnly: true, hostType: "file" }]);
  });

  it("names volumes like Docker Compose", () => {
    expect(composeVolumeName(file, "mm-abc123", "config")).toBe("mm-abc123_config");
    expect(composeVolumeName("services: {}\nvolumes:\n  d:\n    name: shared\n", "p", "d")).toBe("shared");
  });
});
