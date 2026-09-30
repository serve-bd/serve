import { describe, expect, it } from "vitest";
import { autoLayout, CARD_H, CARD_W, NET_W, networkLayout, SERVER_W } from "@/lib/canvas-layout";
import { referencedService, referencesIn } from "@/lib/refs";
import { serviceUses } from "@/server/services/uses";

const svc = (id: string, name: string, serverId = "s1") => ({ id, name, slug: `${id}-ab12`, serverId });

describe("references in variables", () => {
  const list = [svc("pg", "Postgres"), svc("cache", "Redis Cache"), svc("a", "api"), svc("b", "API")];

  it("finds services by slug, name or dashed name", () => {
    expect(referencedService(list, "pg-ab12")?.id).toBe("pg");
    expect(referencedService(list, "postgres")?.id).toBe("pg");
    expect(referencedService(list, "redis-cache")?.id).toBe("cache");
    expect(referencedService(list, "Redis Cache")?.id).toBe("cache");
    expect(referencedService(list, "nope")).toBeUndefined();
  });

  it("answers to a shared name with neither service, only to slugs", () => {
    expect(referencedService(list, "api")).toBeUndefined();
    expect(referencedService(list, "a-ab12")?.id).toBe("a");
  });

  it("reads service references out of values", () => {
    expect(referencesIn(["postgres://${{postgres.HOST}}:${{ postgres.PORT }}/x", "${{OWN}}", "${{shared.KEY}}"])).toEqual([
      { name: "postgres", key: "HOST" },
      { name: "postgres", key: "PORT" },
      { name: "shared", key: "KEY" },
    ]);
  });
});

describe("what each service uses", () => {
  const services = [svc("web", "web", "s1"), svc("pg", "postgres", "s2"), svc("api", "api", "s1")];
  const vars = [
    { serviceId: "web", key: "DATABASE_URL", value: "${{postgres.DATABASE_URL}}" },
    { serviceId: "web", key: "API_URL", value: "${{api.SERVE_PUBLIC_URL}}" },
    { serviceId: "web", key: "DB_HOST", value: "${{postgres.HOST}}" },
    { serviceId: "api", key: "SELF", value: "${{api.PORT}}" },
  ];

  it("lists uses with their variables, private or not, and broken across unconnected servers", () => {
    const uses = serviceUses(services, vars, () => false);
    expect(uses.get("web")).toEqual([
      { id: "pg", variables: ["DATABASE_URL", "DB_HOST"], private: true, broken: true },
      { id: "api", variables: ["API_URL"], private: false, broken: false },
    ]);
    // A service referencing itself is not a use.
    expect(uses.get("api")).toBeUndefined();
  });

  it("is not broken when the servers share a private network", () => {
    const uses = serviceUses(services, vars, () => true);
    expect(uses.get("web")?.find((u) => u.id === "pg")?.broken).toBe(false);
  });
});

describe("automatic canvas layout", () => {
  const overlaps = (pos: Record<string, { x: number; y: number }>) => {
    const list = Object.values(pos);
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) if (Math.abs(list[i].x - list[j].x) < CARD_W && Math.abs(list[i].y - list[j].y) < CARD_H) return true;
    return false;
  };

  it("puts a user left of what it uses", () => {
    const pos = autoLayout([
      { id: "web", serverId: "s1", uses: [{ id: "db" }] },
      { id: "db", serverId: "s1", uses: [] },
    ]);
    expect(pos.web.x).toBeLessThan(pos.db.x);
  });

  it("packs unrelated services into rows instead of one column", () => {
    const pos = autoLayout(Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, serverId: "one", uses: [] })));
    expect(new Set(Object.values(pos).map((p) => p.y)).size).toBe(2);
    expect(overlaps(pos)).toBe(false);
  });

  it("gives each server its own column, users' servers first", () => {
    const pos = autoLayout([
      { id: "db", serverId: "b", uses: [] },
      { id: "app", serverId: "a", uses: [{ id: "db" }] },
      { id: "worker", serverId: "a", uses: [{ id: "db" }] },
      { id: "cache", serverId: "b", uses: [] },
    ]);
    expect(Math.max(pos.app.x, pos.worker.x)).toBeLessThan(Math.min(pos.db.x, pos.cache.x));
    expect(overlaps(pos)).toBe(false);
  });

  it("ignores uses of services that are not on the canvas", () => {
    expect(() => autoLayout([{ id: "x", serverId: "s", uses: [{ id: "elsewhere" }] }])).not.toThrow();
  });
});

describe("private networks canvas layout", () => {
  it("puts networks above their servers and a shared server between its networks", () => {
    const pos = networkLayout({
      networks: [
        { id: "a", servers: ["s1", "s2"] },
        { id: "b", servers: ["s2", "s3"] },
      ],
      servers: ["s1", "s2", "s3"],
    });
    expect(pos["network:a"].y).toBeLessThan(pos["server:s1"].y);
    expect(pos["network:b"].y).toBeLessThan(pos["server:s3"].y);
    const mid = (pos["network:a"].x + pos["network:b"].x) / 2;
    expect(Math.abs(pos["server:s2"].x + SERVER_W / 2 - (mid + NET_W / 2))).toBeLessThan(SERVER_W);
  });

  it("puts servers in no network in a row below, and skips unknown servers", () => {
    const pos = networkLayout({ networks: [{ id: "a", servers: ["s1", "gone"] }], servers: ["s1", "x", "y"] });
    expect(pos["server:gone"]).toBeUndefined();
    expect(pos["server:x"].y).toBeGreaterThan(pos["server:s1"].y);
    expect(pos["server:x"].y).toBe(pos["server:y"].y);
    expect(pos["server:y"].x).toBeGreaterThan(pos["server:x"].x);
  });

  it("works with no networks at all", () => {
    const pos = networkLayout({ networks: [], servers: ["a", "b"] });
    expect(pos["server:a"]).toEqual({ x: 0, y: 0 });
    expect(pos["server:b"].y).toBe(0);
  });
});
