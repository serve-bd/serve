import { describe, expect, it } from "vitest";
import { replicaEnv, shortReplicaPicks } from "@/lib/refs";

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
});
