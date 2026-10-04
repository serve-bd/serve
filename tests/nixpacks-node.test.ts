import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nixpacksNodeDefault } from "@/server/deploy/builders";

function project(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-nixnode-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}
const ctx = (contextDir: string, buildEnv: Record<string, string> = {}) => ({ contextDir, buildEnv, build: { buildArgs: [] } }) as never;

describe("Nixpacks Node version", () => {
  it("gives a Node project with no version a supported one", async () => {
    expect(await nixpacksNodeDefault(ctx(project({ "package.json": "{}" })))).toBe(22);
  });
  it("leaves a version the project or its variables choose", async () => {
    expect(await nixpacksNodeDefault(ctx(project({ "package.json": '{"engines":{"node":"20.x"}}' })))).toBeNull();
    expect(await nixpacksNodeDefault(ctx(project({ "package.json": "{}", ".nvmrc": "20" })))).toBeNull();
    expect(await nixpacksNodeDefault(ctx(project({ "package.json": "{}", ".tool-versions": "nodejs 20.11.0\n" })))).toBeNull();
    expect(await nixpacksNodeDefault(ctx(project({ "package.json": "{}" }), { NIXPACKS_NODE_VERSION: "20" }))).toBeNull();
  });
  it("does nothing outside Node projects", async () => {
    expect(await nixpacksNodeDefault(ctx(project({ "go.mod": "module x" })))).toBeNull();
    expect(await nixpacksNodeDefault(ctx(project({ "package.json": "{}", ".tool-versions": "python 3.12\n" })))).toBe(22);
  });
});
