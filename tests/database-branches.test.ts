import { describe, expect, it, vi } from "vitest";

// The scripts are plain text; the database module is never reached.
vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
import { branchDatabaseName, branchNamePattern, branchReference, previewBranchName } from "@/lib/database-branches";
import { createScript, deleteScript } from "@/server/databases/branches";

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
});
