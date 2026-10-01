import { describe, expect, it, vi } from "vitest";

// The scripts are plain text; the database module is never reached.
vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
import { branchDatabaseName, branchNamePattern, branchReference, previewBranchName } from "@/lib/database-branches";
import { branchScripts, createScript, deleteScript, maxBranches } from "@/server/databases/branches";

describe("database branches", () => {
  it("names the branch database after the main one", () => {
    expect(branchDatabaseName("app", "feature-x")).toBe("app__feature_x");
    expect(branchDatabaseName("My-App", "pr-12")).toBe("my_app__pr_12");
    expect(branchDatabaseName("a".repeat(80), "b".repeat(30)).length).toBeLessThanOrEqual(63);
  });

  it("accepts simple branch names only", () => {
    for (const ok of ["feature-x", "pr-12", "a"]) expect(branchNamePattern.test(ok)).toBe(true);
    for (const bad of ["-x", "x-", "Feature", "a_b", "a.b", "x".repeat(31)]) expect(branchNamePattern.test(bad)).toBe(false);
    expect(previewBranchName(7)).toBe("pr-7");
  });

  it("builds references", () => {
    expect(branchReference("postgres", "feature-x")).toBe("${{postgres.branches.feature-x.DATABASE_URL}}");
  });

  it("quotes the main password for the shell and refuses odd identifiers", () => {
    const main = { username: "postgres", password: "it's", database: "app" };
    const script = createScript(main, { database: "app__x", username: "app__x", password: "pw" }, null);
    expect(script).toContain("export PGPASSWORD='it'\\''s'");
    expect(script).toContain('CREATE DATABASE "app__x" OWNER "app__x";');
    expect(() => deleteScript(main, { database: 'x"; DROP', username: "x" })).toThrow();
  });

  it("has scripts for every engine", () => {
    const main = { username: "root", password: "pw", database: "app" };
    const b = { database: "app__x", username: "app__x", password: "bp" };
    for (const engine of ["postgres", "mysql", "mariadb", "mongodb", "clickhouse"]) {
      expect(branchScripts(engine).create(main, b, null)).toContain("app__x");
      expect(branchScripts(engine).remove(main, b)).toContain("app__x");
    }
    expect(branchScripts("mysql").create(main, b, null)).toContain("export MYSQL_PWD='pw'");
  });

  it("uses database numbers 1 to 15 for Redis and Valkey", () => {
    const main = { username: "default", password: "pw", database: "0" };
    expect(branchScripts("redis").create(main, { database: "3", username: "default", password: "" }, null)).toContain("-n 3 FLUSHDB");
    expect(() => branchScripts("valkey").create(main, { database: "0", username: "default", password: "" }, null)).toThrow();
    expect(() => branchScripts("redis").remove(main, { database: "16", username: "default", password: "" })).toThrow();
    expect(maxBranches("redis")).toBe(15);
    expect(maxBranches("postgres")).toBe(20);
  });
});
