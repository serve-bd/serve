import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
vi.mock("@/server/databases/engines", () => ({ engines: {} }));
vi.mock("@/server/mesh/members", () => ({ meshMemberIds: async () => [], reachesPrivately: () => true }));

const { hostStackReach } = await import("@/server/services/variables");

const empty = { environment: {}, project: {}, org: {} };

describe("hostStackReach", () => {
  it("follows references from the compose variables into own and shared variables", () => {
    const reach = hostStackReach(
      "services:\n  app:\n    image: x\n    volumes:\n      - ${DATA_DIR}:/data\n",
      { DATA_DIR: "${{BASE}}/data", BASE: "${{project.ROOT}}", OTHER: "${{org.UNUSED}}" },
      { environment: {}, project: { ROOT: "${{environment.DISK}}" }, org: { UNUSED: "x" } },
    );
    expect([...reach].sort()).toEqual(["environment:DISK", "own:BASE", "own:DATA_DIR", "project:ROOT"]);
  });

  it("takes a bare reference without an own variable for an environment variable", () => {
    const reach = hostStackReach("x: ${A}\n", { A: "${{B}}" }, empty);
    expect(reach.has("environment:B")).toBe(true);
  });
});
