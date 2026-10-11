import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { railpackStartFor } from "@/server/deploy/builders";

async function project(pkg: object, files: Record<string, string> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "railpack-start-"));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, name), text);
  return dir;
}

describe("start commands Railpack does not find on its own", () => {
  it("runs SvelteKit's Node build", async () => {
    expect(await railpackStartFor(await project({ devDependencies: { "@sveltejs/kit": "2", "@sveltejs/adapter-node": "5" } }))).toBe("node build");
  });
  it("leaves SvelteKit with its own start script, or another adapter, to Railpack", async () => {
    expect(await railpackStartFor(await project({ scripts: { start: "node server.js" }, devDependencies: { "@sveltejs/kit": "2", "@sveltejs/adapter-node": "5" } }))).toBeNull();
    expect(await railpackStartFor(await project({ devDependencies: { "@sveltejs/kit": "2", "@sveltejs/adapter-static": "3" } }))).toBeNull();
  });
  it("prefers a production start script, with the project's package manager", async () => {
    expect(await railpackStartFor(await project({ scripts: { start: "nest start", "start:prod": "node dist/main" } }))).toBe("npm run start:prod");
    expect(await railpackStartFor(await project({ scripts: { "start:prod": "node dist/main" } }, { "pnpm-lock.yaml": "" }))).toBe("pnpm run start:prod");
  });
  it("says nothing for an ordinary app or no package.json", async () => {
    expect(await railpackStartFor(await project({ scripts: { start: "node index.js" } }))).toBeNull();
    expect(await railpackStartFor(await fs.mkdtemp(path.join(os.tmpdir(), "railpack-start-")))).toBeNull();
  });
});
