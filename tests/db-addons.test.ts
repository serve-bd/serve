import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { POOLER_SCRIPT, REPLICA_SCRIPT } from "@/server/databases/addon-scripts";

const parses = (script: string) => execFileSync("sh", ["-n", "-c", script], { encoding: "utf8" });

describe("pooler and replica start scripts", () => {
  it("are valid shell", () => {
    expect(() => parses(POOLER_SCRIPT)).not.toThrow();
    expect(() => parses(REPLICA_SCRIPT)).not.toThrow();
  });

  it("make public access TLS only, private networks still plain", () => {
    expect(POOLER_SCRIPT).toContain("hostssl all all 0.0.0.0/0 scram-sha-256");
    expect(POOLER_SCRIPT).toMatch(/hostnossl all all \$GW\/32 reject/);
    expect(POOLER_SCRIPT).toContain("exec /usr/bin/pgbouncer -u postgres");
    expect(REPLICA_SCRIPT).toContain("hba_file=/run/serve-tls/pg_hba.conf");
    expect(REPLICA_SCRIPT).toContain("hostnossl all all %d.%d.%d.%d/32 reject");
  });
});
