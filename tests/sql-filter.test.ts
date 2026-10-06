import { describe, expect, it } from "vitest";
import { accountsMergeSql, mysqlDatabaseOf, pgConnectTarget, planSql, type SqlEngine, sqlLineFilter } from "@/server/backups/sql-filter";
import { pgConnectLine } from "@/server/databases/engines";

async function clean(engine: SqlEngine, dump: string, target: string, opts: { keepNames?: boolean; user?: string; users?: boolean; protect?: string[] } = {}) {
  const lines = dump.split("\n");
  const plan = await planSql(engine, lines);
  const filter = sqlLineFilter(engine, plan, target, opts);
  return { out: lines.flatMap((l) => filter.push(l)).join("\n"), report: filter.report, plan };
}

const pgCluster = (dbs: Record<string, string>) =>
  [
    "--",
    "-- PostgreSQL database cluster dump",
    "--",
    "\\restrict abc",
    "SET default_transaction_read_only = off;",
    "CREATE ROLE postgres;",
    "ALTER ROLE postgres WITH SUPERUSER LOGIN PASSWORD 'SCRAM-SHA-256$x';",
    "CREATE ROLE extra;",
    "GRANT pg_read_all_data TO extra GRANTED BY postgres;",
    "\\unrestrict abc",
    "\\connect template1",
    "SET statement_timeout = 0;",
    "\\connect postgres",
    "SET statement_timeout = 0;",
    ...Object.entries(dbs).flatMap(([name, table]) => [
      `CREATE DATABASE ${name} WITH TEMPLATE = template0 ENCODING = 'UTF8';`,
      `ALTER DATABASE ${name} OWNER TO extra;`,
      `\\connect ${name}`,
      "\\restrict def",
      `CREATE TABLE public.${table} (n integer);`,
      `ALTER TABLE public.${table} OWNER TO extra;`,
      `COPY public.${table} (n) FROM stdin;`,
      "1",
      "GRANT inside copy data stays",
      "\\.",
      `GRANT SELECT ON TABLE public.${table} TO extra;`,
      "\\unrestrict def",
    ]),
  ].join("\n");

describe("postgres dumps", () => {
  it("restores the one database of a cluster dump into the service's database, without users", async () => {
    const { out, report } = await clean("postgres", pgCluster({ shop: "orders" }), "app", { protect: ["postgres"] });
    expect(out).not.toMatch(/ALTER ROLE|PASSWORD|OWNER TO|GRANT SELECT|GRANT pg_|CREATE DATABASE|ALTER DATABASE|restrict/);
    // Roles still exist (without login) for policies that name them; Serve's own is untouched.
    expect(out).toContain(`DO $$BEGIN CREATE ROLE "extra"; EXCEPTION WHEN duplicate_object THEN NULL; END$$;`);
    expect(out).not.toContain(`CREATE ROLE "postgres"`);
    expect(out).toContain(`\\connect -reuse-previous=on "dbname='app'"`);
    expect(out).toContain("CREATE TABLE public.orders");
    expect(out).toContain("GRANT inside copy data stays");
    expect(out).not.toContain("template1");
    expect(report.into).toBe("shop");
    expect(report.created).toEqual([]);
  });

  it("keeps several databases apart, creating the missing ones", async () => {
    const { out, report } = await clean("postgres", pgCluster({ shop: "orders", blog: "posts" }), "app");
    expect(report.created).toEqual(["shop", "blog"]);
    expect(out).toContain(`SELECT 'CREATE DATABASE "shop"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'shop')\\gexec`);
    expect(out.indexOf(`\\connect -reuse-previous=on "dbname='blog'"`)).toBeGreaterThan(out.indexOf("public.orders"));
  });

  it("uses data in the postgres database when that is where it is", async () => {
    const dump = ["-- PostgreSQL database cluster dump", "CREATE ROLE postgres;", "\\connect postgres", "CREATE TABLE public.t (n int);"].join("\n");
    const { out, plan } = await clean("postgres", dump, "app");
    expect(plan.databases).toEqual(["postgres"]);
    expect(out).toContain(`\\connect -reuse-previous=on "dbname='app'"`);
    expect(out).toContain("CREATE TABLE public.t");
  });

  it("leaves a plain single-database dump in place, minus owners and grants", async () => {
    const dump = ["SET client_encoding = 'UTF8';", "CREATE TABLE public.t (n int);", "ALTER TABLE public.t OWNER TO someone;", "REVOKE ALL ON SCHEMA public FROM PUBLIC;"].join(
      "\n",
    );
    const { out } = await clean("postgres", dump, "app");
    expect(out).toBe(["SET client_encoding = 'UTF8';", "CREATE TABLE public.t (n int);"].join("\n"));
  });

  it("restores a backup of one chosen database into that database, not the service's", async () => {
    const dump = ['\\connect "other"', "CREATE TABLE public.t (n integer);"].join("\n");
    const { out } = await clean("postgres", dump, "app", { keepNames: true });
    expect(out).toContain(`\\connect -reuse-previous=on "dbname='other'"`);
    expect(out).not.toContain(`\\connect -reuse-previous=on "dbname='app'"`);
  });

  it("connects to a database named like connection options by its name only", async () => {
    const name = `host=evil a'b\\c "q"`;
    const dump = [pgConnectLine(name), "CREATE TABLE public.t (n integer);"].join("\n");
    const { out, plan } = await clean("postgres", dump, "app", { keepNames: true });
    expect(plan.databases).toEqual([name]);
    expect(out).toContain(`\\connect -reuse-previous=on "dbname='host=evil a\\'b\\\\c ""q""'"`);
  });

  it("reads every form of \\connect", () => {
    expect(pgConnectTarget("\\connect app")).toBe("app");
    expect(pgConnectTarget('\\connect "My DB"')).toBe("My DB");
    expect(pgConnectTarget(`\\connect -reuse-previous=on "dbname='it''s'"`)).toBe("it's");
    // pg_dumpall escapes with a backslash.
    expect(pgConnectTarget(`\\connect -reuse-previous=on "dbname='it\\'s a\\\\b'"`)).toBe("it's a\\b");
    for (const name of ["app", "a=b", `x'y\\z`, 'q"uote']) expect(pgConnectTarget(pgConnectLine(name))).toBe(name);
    expect(pgConnectTarget("SELECT 1;")).toBeNull();
  });
});

describe("restoring users", () => {
  it("postgres: keeps roles, passwords and rights, never Serve's own account", async () => {
    const { out } = await clean("postgres", pgCluster({ shop: "orders" }), "app", { users: true, protect: ["postgres"] });
    expect(out).toContain(`DO $$BEGIN CREATE ROLE "extra";`);
    expect(out).toContain("GRANT pg_read_all_data TO extra GRANTED BY postgres;");
    expect(out).toContain("ALTER TABLE public.orders OWNER TO extra;");
    expect(out).not.toMatch(/ALTER ROLE postgres|CREATE ROLE "postgres"|CREATE DATABASE|restrict/);
  });

  it("postgres: ALTER USER and DROP USER never touch Serve's own account", async () => {
    const dump = pgCluster({ shop: "orders" }).replace(
      "CREATE ROLE extra;",
      "CREATE ROLE extra;\nALTER USER postgres PASSWORD 'x';\nALTER GROUP postgres RENAME TO y;\nDROP USER postgres;\nALTER USER extra PASSWORD 'e';",
    );
    const { out } = await clean("postgres", dump, "app", { users: true, protect: ["postgres"] });
    expect(out).not.toMatch(/ALTER (USER|GROUP) postgres|DROP USER/);
    expect(out).toContain("ALTER USER extra PASSWORD 'e';");
  });
});

const myAll = [
  "-- Current Database: `mysql`",
  "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `mysql` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;",
  "USE `mysql`;",
  "INSERT INTO `user` VALUES ('localhost','root','x');",
  "-- Current Database: `shop`",
  "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `shop` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;",
  "USE `shop`;",
  "CREATE TABLE `orders` (`n` int);",
  "INSERT INTO `orders` VALUES (1),(2);",
  "/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`%`*/ /*!50003 TRIGGER t BEFORE INSERT ON orders FOR EACH ROW SET @x = 1 */;;",
  "CREATE USER 'extra'@'%' IDENTIFIED BY 'x';",
  "GRANT ALL PRIVILEGES ON *.* TO 'extra'@'%';",
  "FLUSH PRIVILEGES;",
].join("\n");

describe("mysql dumps", () => {
  it("leaves out the mysql database and users, and restores the one database into the service's", async () => {
    const { out, report } = await clean("mysql", myAll, "app");
    expect(out).not.toMatch(/`mysql`|INSERT INTO `user`|CREATE USER|GRANT|FLUSH|DEFINER=/);
    expect(out).toContain("CREATE DATABASE IF NOT EXISTS `app`;");
    expect(out).toContain("USE `app`;");
    expect(out).toContain("INSERT INTO `orders` VALUES (1),(2);");
    expect(report.into).toBe("shop");
  });

  it("keeps several databases under their names", async () => {
    const dump = `${myAll}\n-- Current Database: \`blog\`\nUSE \`blog\`;\nCREATE TABLE \`posts\` (\`n\` int);`;
    const { out, report } = await clean("mysql", dump, "app");
    expect(out).toContain("USE `shop`;");
    expect(out).toContain("USE `blog`;");
    expect(report.created).toEqual(["shop", "blog"]);
  });

  it("keeps the name of the one database of a backup of chosen databases", async () => {
    const { out, report } = await clean("mysql", myAll, "app", { keepNames: true });
    expect(out).toContain("USE `shop`;");
    expect(out).not.toContain("`app`");
    expect(report.into).toBeNull();
  });

  it("restores a whole-server import under the dump's names, empty databases too, open to the app's account", async () => {
    const dump = `${myAll}\n-- Current Database: \`shop_test\`\nCREATE DATABASE /*!32312 IF NOT EXISTS*/ \`shop_test\`;\nUSE \`shop_test\`;`;
    const { out, report, plan } = await clean("mysql", dump, "app", { keepNames: true, user: "app" });
    expect(plan.databases).toEqual(["shop", "shop_test"]);
    expect(report.created).toEqual(["shop", "shop_test"]);
    expect(out).toContain("INSERT INTO `orders` VALUES (1),(2);");
    expect(out).toContain("GRANT ALL PRIVILEGES ON `shop_test`.* TO 'app'@'%';");
    expect(out).not.toContain("`app`");
    // Grants of the dump itself stay out.
    expect(out).not.toContain("'extra'");
  });

  it("puts MySQL's accounts aside to merge them, keeps other users' grants, never root or the app's", async () => {
    const dump = `${myAll}\nGRANT SELECT ON \`shop\`.* TO 'app'@'%';\nALTER USER 'root'@'localhost' IDENTIFIED BY 'x';`;
    const { out } = await clean("mysql", dump, "app", { users: true, keepNames: true, user: "app", protect: ["app"] });
    expect(out).toContain("USE `serve_restore_accounts`;");
    expect(out).toContain("INSERT INTO `user` VALUES ('localhost','root','x');");
    expect(out).toContain("CREATE USER 'extra'@'%' IDENTIFIED BY 'x';");
    expect(out).toContain("GRANT ALL PRIVILEGES ON *.* TO 'extra'@'%';");
    expect(out).not.toContain("TO 'app'@'%';\nALTER");
    expect(out).not.toContain("GRANT SELECT ON `shop`.* TO 'app'");
    expect(out).not.toContain("ALTER USER 'root'");
    expect(accountsMergeSql(["app"])).toContain("NOT IN (''root'',''mysql.sys'',''mysql.session'',''mysql.infoschema'',''mariadb.sys'',''app'')");
    // A database restored under another name: its rights follow it.
    expect(accountsMergeSql(["app"], { ecommerce: "app" })).toContain("SET Db = ''app'' WHERE Db = ''ecommerce''");
    expect(accountsMergeSql(["app"])).not.toContain("SET Db =");
  });

  it("reads database names", () => {
    expect(mysqlDatabaseOf("USE `a``b`;")).toBe("a`b");
    expect(mysqlDatabaseOf("CREATE DATABASE /*!32312 IF NOT EXISTS*/ `x` /*!40100 */;")).toBe("x");
    expect(mysqlDatabaseOf("INSERT INTO `x` VALUES (1);")).toBeNull();
  });
});
