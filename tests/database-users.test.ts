import { describe, expect, it } from "vitest";
import { isSystemUser, parseListing, USERNAME_PATTERN, userScripts, usersSupported } from "@/server/databases/users";

const main = { username: "app", password: "pa'ss$word", database: "app" };
const decoded = (script: string) => [...script.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/g)].map((m) => Buffer.from(m[1], "base64").toString("utf8")).join("\n");

describe("database users", () => {
  it("supports the engines with real logins", () => {
    for (const engine of ["postgres", "mysql", "mariadb", "mongodb", "clickhouse"]) expect(usersSupported({ engine } as never)).toBe(true);
    for (const engine of ["redis", "valkey"]) expect(usersSupported({ engine } as never)).toBe(false);
  });

  it("accepts only plain user names", () => {
    for (const ok of ["app_reader", "a", "x1"]) expect(USERNAME_PATTERN.test(ok)).toBe(true);
    for (const bad of ["", "1app", "App", "a-b", "a b", "a'b", 'a"b', "x".repeat(33)]) expect(USERNAME_PATTERN.test(bad)).toBe(false);
    // The scripts refuse a name that slipped past the checks before.
    expect(() => userScripts("postgres", main).remove('x"; DROP TABLE t; --')).toThrow();
    expect(() => userScripts("mongodb", main).remove("a'b")).toThrow();
  });

  it("marks the engine's own logins", () => {
    expect(isSystemUser("postgres", "pg_monitor")).toBe(true);
    expect(isSystemUser("mysql", "mysql.sys")).toBe(true);
    expect(isSystemUser("mariadb", "mariadb.sys")).toBe(true);
    expect(isSystemUser("mysql", "root")).toBe(true);
    expect(isSystemUser("postgres", "app_reader")).toBe(false);
  });

  it("parses the listing without the engine's databases", () => {
    const out = "SERVE_DB\tapp\nSERVE_DB\tmysql\nSERVE_DB\tsys\nSERVE_USER\troot\nSERVE_USER\treader\r\nnoise\n";
    expect(parseListing("mysql", out)).toEqual({ users: ["reader", "root"], databases: ["app"] });
    expect(parseListing("mongodb", "SERVE_DB\tadmin\nSERVE_DB\tshop\n").databases).toEqual(["shop"]);
  });

  it("keeps passwords and database names out of the shell", () => {
    const s = userScripts("postgres", main).create("reader", "secret_pass_123", "read", ["we'ird\"db$(x)"]);
    // Only base64 and quoted values reach the shell: no command substitution from a database name.
    expect(s).not.toContain('$(x)"');
    const sql = decoded(s);
    expect(sql).toContain(`CREATE ROLE "reader" LOGIN PASSWORD 'secret_pass_123';`);
    expect(sql).toContain(`GRANT CONNECT ON DATABASE "we'ird""db$(x)" TO "reader";`);
    expect(s).toContain(`PGPASSWORD='pa'\\''ss$word'`);
    const my = decoded(userScripts("mysql", main).create("reader", "secret_pass_123", "readwrite", ["sh`op"]));
    expect(my).toContain("GRANT SELECT, INSERT, UPDATE, DELETE");
    expect(my).toContain("ON `sh``op`.* TO 'reader'@'%'");
  });

  it("gives each access level its privileges", () => {
    const pg = (a: "read" | "readwrite" | "owner") => decoded(userScripts("postgres", main).create("u", "secret_pass_123", a, ["app"]));
    expect(pg("read")).toContain("GRANT SELECT ON ALL TABLES");
    expect(pg("read")).not.toContain("INSERT");
    expect(pg("readwrite")).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES");
    expect(pg("owner")).toContain("GRANT USAGE, CREATE ON SCHEMA");
    const mongo = userScripts("mongodb", main).create("u", "secret_pass_123", "owner", ["shop"]);
    expect(mongo).toContain('"role":"dbOwner","db":"shop"');
  });

  it("hands a removed Postgres login's objects to the main login", () => {
    const sql = decoded(userScripts("postgres", main).remove("u"));
    expect(sql).toContain('REASSIGN OWNED BY "u" TO "app"');
    expect(sql).toContain('DROP OWNED BY "u"');
    expect(sql).toContain('DROP ROLE IF EXISTS "u"');
  });

  it("manages ClickHouse logins with quoted names and the password off the command line", () => {
    const ch = userScripts("clickhouse", main);
    const create = ch.create("reader", "secret_pass_123", "read", ["we`ird\\db", "app"]);
    // The main password goes in the environment of clickhouse-client, never as an argument.
    expect(create).toContain(`CLICKHOUSE_PASSWORD='pa'\\''ss$word' clickhouse-client -u 'app' -d 'default' --multiquery`);
    expect(create).not.toContain("--password");
    expect(create).not.toContain("secret_pass_123");
    const sql = decoded(create);
    expect(sql).toContain("CREATE USER reader IDENTIFIED WITH sha256_password BY 'secret_pass_123';");
    expect(sql).toContain("GRANT SELECT, SHOW, dictGet ON `we\\`ird\\\\db`.* TO reader;");
    expect(sql).toContain("GRANT SELECT, SHOW, dictGet ON `app`.* TO reader;");
    expect(decoded(ch.create("u", "secret_pass_123", "owner", ["app"]))).toContain("GRANT ALL ON `app`.* TO u;");
    expect(decoded(ch.create("u", "secret_pass_123", "readwrite", ["app"]))).toContain("GRANT SELECT, INSERT, ALTER UPDATE, ALTER DELETE, SHOW, dictGet ON `app`.* TO u;");
    expect(decoded(ch.setPassword("u", "a'b\\c"))).toBe("ALTER USER u IDENTIFIED WITH sha256_password BY 'a\\'b\\\\c';");
    expect(decoded(ch.setAccess("u", "read", ["app"]))).toBe("REVOKE ALL ON *.* FROM u;\nGRANT SELECT, SHOW, dictGet ON `app`.* TO u;");
    expect(decoded(ch.remove("u"))).toBe("DROP USER IF EXISTS u;");
    for (const bad of ["u; DROP USER app", "a`b", "Default"]) expect(() => ch.remove(bad)).toThrow();
    expect(isSystemUser("clickhouse", "default")).toBe(true);
    expect(isSystemUser("clickhouse", "defaults")).toBe(false);
    expect(parseListing("clickhouse", "SERVE_DB\tsystem\nSERVE_DB\tINFORMATION_SCHEMA\nSERVE_DB\tapp\nSERVE_USER\tapp\n")).toEqual({ users: ["app"], databases: ["app"] });
  });
});
