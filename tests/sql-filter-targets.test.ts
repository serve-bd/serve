import { describe, expect, it } from "vitest";
import { pgConnectTarget, planSql, type SqlEngine, sqlLineFilter } from "@/server/backups/sql-filter";

// `targets` are the databases a restore empties before it starts: never one the dump does not write to.

const pgDump = (dbs: string[], head: string[] = []) => [
  ...head,
  ...dbs.flatMap((d) => [`CREATE DATABASE ${d};`, `\\connect ${d}`, `CREATE TABLE public.t_${d} (n int);`, `INSERT INTO public.t_${d} VALUES (1);`]),
];
const myDump = (dbs: string[]) =>
  dbs
    .map((d) => d.replaceAll("`", "``"))
    .flatMap((d) => [`CREATE DATABASE /*!32312 IF NOT EXISTS*/ \`${d}\`;`, `USE \`${d}\`;`, `CREATE TABLE \`t_${d}\` (n int);`, `INSERT INTO \`t_${d}\` VALUES (1);`]);

async function run(engine: SqlEngine, lines: string[], target: string, opts: Parameters<typeof sqlLineFilter>[3] = {}) {
  const f = sqlLineFilter(engine, await planSql(engine, lines), target, opts);
  return { out: lines.flatMap((l) => f.push(l)), targets: [...f.targets].sort(), report: f.report };
}

describe("restore targets", () => {
  it("a one-database dump empties only the service's database", async () => {
    expect((await run("postgres", pgDump(["shop"]), "app")).targets).toEqual(["app"]);
    expect((await run("mysql", myDump(["shop"]), "app")).targets).toEqual(["app"]);
  });

  it("several databases each empty their own name", async () => {
    expect((await run("postgres", pgDump(["a", "b"]), "app")).targets).toEqual(["a", "b"]);
    expect((await run("mysql", myDump(["a", "b"]), "app")).targets).toEqual(["a", "b"]);
  });

  it("only the chosen databases are emptied; content before a switch only on a whole restore", async () => {
    const lines = pgDump(["a", "b"], ["CREATE TABLE public.loose (n int);"]);
    expect((await run("postgres", lines, "app")).targets).toEqual(["a", "app", "b"]);
    const one = await run("postgres", lines, "app", { only: ["b"] });
    expect(one.targets).toEqual(["app"]);
    // b's content goes into the service's database; a is not touched.
    expect(one.out.join("\n")).toContain("t_b");
    expect(one.out.join("\n")).not.toContain("t_a");
    expect(one.out.join("\n")).toContain("loose");
  });

  it("renamed databases are emptied under their new name, never the old one", async () => {
    const r = await run("postgres", pgDump(["a", "b"]), "app", { renames: { a: "a_copy" } });
    expect(r.targets).toEqual(["a_copy", "b"]);
    expect(r.out.map(pgConnectTarget).filter((x) => x !== null)).toEqual(["a_copy", "b"]);
    const m = await run("mysql", myDump(["a", "b"]), "app", { renames: { b: "b_copy" } });
    expect(m.targets).toEqual(["a", "b_copy"]);
    expect(m.out).toContain("USE `b_copy`;");
  });

  it("never empties system databases a dump switches to", async () => {
    const pg = await run("postgres", ["\\connect template1", "SET x = 1;", ...pgDump(["a"])], "app");
    expect(pg.targets).not.toContain("template1");
    const my = await run("mysql", ["USE `mysql`;", "INSERT INTO `user` VALUES (1);", ...myDump(["a"])], "app");
    expect(my.targets).not.toContain("mysql");
    expect(my.out.join("\n")).not.toContain("INSERT INTO `user`");
  });

  it("quotes database names it creates", async () => {
    const r = await run("mysql", myDump(["a", "we`ird"]), "app", { user: "o'brien" });
    const text = r.out.join("\n");
    expect(text).toContain("CREATE DATABASE IF NOT EXISTS `we``ird`;");
    expect(text).toContain("TO 'o''brien'@'%';");
  });
});
