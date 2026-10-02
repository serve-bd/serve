import { describe, expect, it, vi } from "vitest";

// Postgres dumps come as .dump, .backup or .dmp files, plain or gzipped. Restore tells the format by its first bytes.

vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({ db: {}, schema: {} }));

import { importFilename } from "@/server/backups";

describe("importFilename", () => {
  it("accepts pg_dump files with a .dmp extension", () => {
    expect(importFilename("postgres", "app", "pg-dump-app-1727000000.dmp")).toMatch(/^app-import-.*-pg-dump-app-1727000000\.dmp$/);
    expect(importFilename("postgres", "app", "app.dmp.gz")).toMatch(/\.dmp\.gz$/);
  });

  it("refuses .dmp for engines that cannot restore it", () => {
    expect(() => importFilename("mysql", "app", "app.dmp")).toThrow(/Upload a/);
  });
});
