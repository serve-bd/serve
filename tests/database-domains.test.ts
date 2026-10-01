import { describe, expect, it } from "vitest";
import { DOMAIN_ROUTES, domainEngines, domainUrl, hostnamePattern } from "@/lib/database-domains";

describe("database domains", () => {
  it("routes the engines that send a name in TLS, not MySQL", () => {
    expect([...domainEngines].sort()).toEqual(["clickhouse", "mongodb", "postgres", "redis", "valkey"]);
    expect(DOMAIN_ROUTES.mysql).toBeUndefined();
    // PostgreSQL 17+ clients ask for the "postgresql" TLS protocol; the router must answer with it.
    expect(DOMAIN_ROUTES.postgres?.[0].alpn).toEqual(["postgresql"]);
  });

  it("builds TLS connection URLs on the domain", () => {
    const creds = { username: "postgres", password: "p@ss", database: "app" };
    expect(domainUrl("postgres", creds, "db.example.com")).toBe("postgresql://postgres:p%40ss@db.example.com/app?sslmode=require");
    expect(domainUrl("mongodb", creds, "db.example.com")).toContain("tls=true");
    expect(domainUrl("redis", creds, "cache.example.com")).toBe("rediss://default:p%40ss@cache.example.com:6379");
    expect(domainUrl("mysql", creds, "db.example.com")).toBeNull();
  });

  it("accepts plain domain names only", () => {
    expect(hostnamePattern.test("db.shahriyar.dev")).toBe(true);
    for (const bad of ["db", "-db.example.com", "db..example.com", "DB.example.com", "*.example.com"]) expect(hostnamePattern.test(bad)).toBe(false);
  });
});
