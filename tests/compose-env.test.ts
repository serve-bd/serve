import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scopeDockerfiles } from "@/server/deploy/build-cache";
import { envFile, writeComposeFiles } from "@/server/deploy/compose";

describe("compose env file", () => {
  it("keeps values without quotes literal in single quotes", () => {
    expect(envFile({ A: "plain $HOME \\n", B: "" })).toBe("A='plain $HOME \\n'\nB=''\n");
  });

  it("escapes values holding a single quote so compose never interpolates them", () => {
    expect(envFile({ A: "it's $HOME ${X}" })).toBe(`A="it's \\$HOME \\\${X}"\n`);
    expect(envFile({ A: `it's "q" \\ end\\` })).toBe(`A="it's \\"q\\" \\\\ end\\\\"\n`);
    expect(envFile({ A: "it's\nnext\r" })).toBe(`A="it's\\nnext\\r"\n`);
  });
});

describe("files Serve writes into a compose project", () => {
  it("replaces links a container planted instead of writing through them", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "serve-links-"));
    try {
      const dir = path.join(root, "repo");
      const victim = path.join(root, "other-tenant.txt");
      fs.mkdirSync(dir);
      fs.writeFileSync(victim, "untouched");
      fs.symlinkSync(victim, path.join(dir, ".env"));
      fs.symlinkSync(victim, path.join(dir, ".serve-compose.yml"));
      await writeComposeFiles({ projectName: "p", dir, file: ".serve-compose.yml", vars: { A: "1" }, log: () => {}, content: "services: {}\n" });
      expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
      expect(fs.lstatSync(path.join(dir, ".env")).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe("A='1'\n");
      expect(fs.statSync(path.join(dir, ".env")).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(path.join(dir, ".serve-compose.yml"), "utf8")).toBe("services: {}\n");

      // A Dockerfile linked to a file outside the repository is refused, not rewritten.
      fs.writeFileSync(victim, "FROM x\nRUN --mount=type=cache,target=/c true\n");
      fs.symlinkSync(victim, path.join(dir, "Dockerfile"));
      await expect(scopeDockerfiles([path.join(dir, "Dockerfile")], "scope", dir)).rejects.toThrow(/outside the repository/);
      expect(fs.readFileSync(victim, "utf8")).not.toContain("scope");
      // A link inside the repository is followed, and the file it points at replaced.
      fs.rmSync(path.join(dir, "Dockerfile"));
      fs.copyFileSync(victim, path.join(dir, "real.Dockerfile"));
      fs.symlinkSync("real.Dockerfile", path.join(dir, "Dockerfile"));
      await scopeDockerfiles([path.join(dir, "Dockerfile")], "scope", dir);
      expect(fs.readFileSync(path.join(dir, "real.Dockerfile"), "utf8")).toContain("id=scope-/c");
      expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
