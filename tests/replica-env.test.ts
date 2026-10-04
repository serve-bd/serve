import { describe, expect, it } from "vitest";
import { parseReplicaPick, replicaEnv, replicaPick, shortReplicaPicks } from "@/lib/refs";

describe("replicaEnv", () => {
  it("fills replica references and sets the built-in variables", () => {
    const env = { SHARD_ID: "${{replica.index}}", SHARDS: "${{ replica.count }}", NAME: "bot-${{replica.number}}", TOKEN: "abc" };
    expect(replicaEnv(env, 2, 4)).toEqual({
      SERVE_REPLICA_INDEX: "2",
      SERVE_REPLICA_COUNT: "4",
      SHARD_ID: "2",
      SHARDS: "4",
      NAME: "bot-3",
      TOKEN: "abc",
    });
  });

  it("leaves literal values as written", () => {
    const env = { NAME: "worker-${{replica.index}}", ID: "${{replica.index}}" };
    expect(replicaEnv(env, 1, 2, ["NAME"])).toMatchObject({ NAME: "worker-${{replica.index}}", ID: "1" });
  });

  it("gives each replica its own values without changing the input", () => {
    const env = { SHARD_ID: "${{replica.index}}" };
    expect([0, 1, 2, 3].map((i) => replicaEnv(env, i, 4).SHARD_ID)).toEqual(["0", "1", "2", "3"]);
    expect(env.SHARD_ID).toBe("${{replica.index}}");
  });

  it("leaves other references alone", () => {
    expect(replicaEnv({ A: "${{replica.other}}", B: "${{db.URL}}" }, 0, 1)).toMatchObject({ A: "${{replica.other}}", B: "${{db.URL}}" });
  });

  it("picks each replica's own value from a list", () => {
    const env = { SHARD_ID: "${{replica.pick(7, 8,9 ,10)}}", REGION: "eu-${{ replica.pick(a,b) }}" };
    expect([0, 1, 2, 3].map((i) => replicaEnv(env, i, 4).SHARD_ID)).toEqual(["7", "8", "9", "10"]);
    expect(replicaEnv(env, 1, 4).REGION).toBe("eu-b");
    expect(replicaEnv(env, 3, 4).REGION).toBe("eu-");
  });

  it("finds lists shorter than the replica count", () => {
    const env = { A: "${{replica.pick(1,2,3,4)}}", B: "${{replica.pick(x,y)}}", C: "${{replica.index}}" };
    expect(shortReplicaPicks(env, 4)).toEqual(["B"]);
    expect(shortReplicaPicks(env, 2)).toEqual([]);
  });

  it("keeps any text through replicaPick and parseReplicaPick", () => {
    const values = ["token,with,commas", "a (b) c", "back\\slash", " padded ", "", "https://x.io/?a=1&b=2", '{"json": [1, 2]}'];
    const value = replicaPick(values);
    expect(parseReplicaPick(value)).toEqual(values);
    expect(values.map((_, i) => replicaEnv({ V: value }, i, values.length).V)).toEqual(values);
  });

  it("parses hand-written lists and ignores other values", () => {
    expect(parseReplicaPick("${{ replica.pick(eu, us , asia) }}")).toEqual(["eu", "us", "asia"]);
    expect(parseReplicaPick("x-${{replica.pick(a,b)}}")).toBeNull();
    expect(parseReplicaPick("plain")).toBeNull();
  });
});

describe("replica count and pick escapes", () => {
  it("caps replicas per server and counts extra servers", async () => {
    const { replicaCount } = await import("@/lib/refs");
    expect(replicaCount(0)).toBe(1);
    expect(replicaCount(4, 1)).toBe(8);
    expect(replicaCount(50)).toBe(20);
  });
  it("keeps values with commas, brackets and edge newlines whole", async () => {
    const { replicaPick, parseReplicaPick } = await import("@/lib/refs");
    const values = ["mongodb://h1,h2/db", "a)b", "\nx\n", "c\\d"];
    expect(parseReplicaPick(replicaPick(values))).toEqual(values);
  });
});
