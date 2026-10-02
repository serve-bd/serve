import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { type MongoInput, mongoScript } from "@/server/databases/explorer";

const creds = { username: "app", password: "pw", database: "app" };

/**
 * Runs the mongosh script in a VM with stand-ins for mongosh's globals: one collection held as plain
 * objects, EJSON as JSON. `between` runs after the script reads a document and before it writes.
 */
function run(input: MongoInput, docs: Record<string, unknown>[], between?: () => void) {
  const lines = mongoScript(creds, input);
  const env = /SERVE_INPUT='([^']*)'/.exec(lines[0])![1];
  const quoted = lines[1].slice(lines[1].indexOf("--eval ") + "--eval ".length);
  const code = quoted.slice(1, -1).replaceAll("'\\''", "'");
  const printed: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const coll = {
    find: () => {
      const cursor = { maxTimeMS: () => cursor, skip: () => cursor, limit: () => cursor, sort: () => cursor, toArray: () => docs.map((d) => structuredClone(d)) };
      return cursor;
    },
    countDocuments: () => docs.length,
    findOne: (f: { _id: unknown }) => {
      const d = docs.find((x) => same(x._id, f._id));
      const copy = d && structuredClone(d);
      between?.();
      return copy ?? null;
    },
    replaceOne: (f: { _id: unknown; $expr?: { $eq: [string, { $literal: unknown }] } }, doc: Record<string, unknown>) => {
      const i = docs.findIndex((x) => same(x._id, f._id) && (!f.$expr || same(x, f.$expr.$eq[1].$literal)));
      if (i >= 0) docs[i] = { _id: docs[i]._id, ...doc };
      return { matchedCount: i >= 0 ? 1 : 0 };
    },
  };
  const db = { getSiblingDB: () => ({ getCollection: () => coll }) };
  const EJSON = { parse: (s: string) => JSON.parse(s), stringify: (v: unknown) => JSON.stringify(v) };
  vm.runInNewContext(code, { db, EJSON, Buffer, process: { env: { SERVE_INPUT: env } }, print: (s: string) => printed.push(s) });
  return JSON.parse(printed[0].slice("SERVE_JSON".length));
}

describe("editing a MongoDB document", () => {
  const seed = () => [
    { _id: 1, name: "a", n: { $numberLong: "5" } },
    { _id: 2, name: "b", list: [1, [2, 3]] },
  ];
  const versionsOf = (docs: Record<string, unknown>[]) => run({ op: "documents", db: "d", collection: "c" }, docs).versions as string[];
  const replace = (docs: Record<string, unknown>[], version: string, query: string, between?: () => void) =>
    run({ op: "replace", db: "d", collection: "c", id: "1", version, query, readOnly: false }, docs, between);

  it("gives each document a version that follows its exact content", () => {
    const docs = seed();
    const [v1, v2] = versionsOf(docs);
    expect(v1).not.toBe(v2);
    expect(versionsOf(seed())[0]).toBe(v1);
    // Same number, other type: another version.
    expect(versionsOf([{ _id: 1, name: "a", n: 5 }])[0]).not.toBe(v1);
  });

  it("saves over the version it was made from", () => {
    const docs = seed();
    const [v1] = versionsOf(docs);
    expect(replace(docs, v1, '{"name": "edited"}')).toMatchObject({ affected: 1 });
    expect(docs[0]).toEqual({ _id: 1, name: "edited" });
  });

  it("refuses a document changed since it was shown", () => {
    const docs = seed();
    const [v1] = versionsOf(docs);
    docs[0].name = "changed elsewhere";
    expect(replace(docs, v1, '{"name": "edited"}')).toMatchObject({ affected: 0, stale: true });
    expect(docs[0].name).toBe("changed elsewhere");
  });

  it("refuses a change made between the read and the write", () => {
    const docs = seed();
    const [v1] = versionsOf(docs);
    expect(
      replace(docs, v1, '{"name": "edited"}', () => {
        docs[0].name = "raced";
      }),
    ).toMatchObject({ affected: 0, stale: true });
    expect(docs[0].name).toBe("raced");
  });

  it("saves without a check when no version is given (the API, as before)", () => {
    const docs = seed();
    expect(replace(docs, "", '{"name": "x"}')).toMatchObject({ affected: 1 });
    expect(docs[0]).toEqual({ _id: 1, name: "x" });
    expect(replace([], "abc", '{"name": "x"}')).toEqual({ affected: 0 });
  });

  it("does not save over a document that was shown cut short", () => {
    const docs = [{ _id: 1, big: "x".repeat(200_001) }];
    const [v] = versionsOf(docs);
    expect(replace(docs, v, '{"name": "x"}')).toMatchObject({ error: expect.stringMatching(/too large/) });
    expect((docs[0] as { big: string }).big.length).toBe(200_001);
  });
});
