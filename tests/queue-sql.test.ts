import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The job queue is SQL run by Postgres; there is no database in the tests. These check the
// statements the queue sends and the values bound into them: which jobs a claim may take, and what
// a finished, failed or stale job becomes. Real claiming order and locking need a database.

const sent = vi.hoisted(() => ({ queries: [] as unknown[], rows: [] as unknown[] }));
vi.mock("@/server/db", () => ({
  db: {
    execute: async (q: unknown) => {
      sent.queries.push(q);
      return sent.rows;
    },
  },
  schema: {},
  sql: { notify: async () => {} },
}));

const { claimJob, failJob, finishJob, recoverStaleJobs } = await import("@/server/queue");

const dialect = new PgDialect();
const last = () => {
  const q = dialect.sqlToQuery(sent.queries.at(-1) as SQL);
  return { text: q.sql.replace(/\s+/g, " "), params: q.params };
};

beforeEach(() => {
  sent.queries = [];
  sent.rows = [];
});

describe("claimJob", () => {
  it("returns the claimed job, or null when none is runnable", async () => {
    sent.rows = [{ id: "j1", type: "deploy" }];
    expect(await claimJob()).toEqual({ id: "j1", type: "deploy" });
    sent.rows = [];
    expect(await claimJob()).toBeNull();
  });

  it("takes one due pending job, skipping rows another worker holds, and marks it running", async () => {
    await claimJob();
    const { text } = last();
    expect(text).toMatch(/UPDATE job SET status = 'running', locked_at = now\(\), attempts = attempts \+ 1/);
    expect(text).toMatch(/j\.status = 'pending' AND j\.run_at <= now\(\)/);
    expect(text).toMatch(/ORDER BY j\.run_at, j\.created_at FOR UPDATE SKIP LOCKED LIMIT 1/);
  });

  it("binds the filters as JSON arrays; no type list means every type", async () => {
    await claimJob(["svc:a", "svc:b"], { excludeTypes: ["backup.run"], fullBuildServers: ["local"] });
    const { params } = last();
    expect(params).toContain(JSON.stringify(["backup.run"]));
    expect(params).toContain(JSON.stringify(["local"]));
    expect(params).toContain(JSON.stringify(["svc:a", "svc:b"]));
    // onlyTypes left out: bound as NULL, which the statement reads as "any type".
    expect(params.filter((p) => p === null)).toHaveLength(2);
    expect(last().text).toMatch(/\(\$\d+::jsonb IS NULL OR \$\d+::jsonb \? j\.type\)/);

    await claimJob([], { onlyTypes: ["deploy"] });
    expect(last().params).toContain(JSON.stringify(["deploy"]));
    expect(last().params).not.toContain(null);
  });

  it("binds names as values, never as SQL (a quote in a key or type cannot change the statement)", async () => {
    await claimJob(["x'; DELETE FROM job; --"], { excludeTypes: ["a'b"], fullBuildServers: ["s'1"] });
    const { text, params } = last();
    expect(text).not.toContain("DELETE FROM job");
    expect(text).not.toContain("a'b");
    expect(params).toContain(JSON.stringify(["x'; DELETE FROM job; --"]));
  });

  it("holds a key while a job with it runs or the caller excludes it; force skips only the build-slot wait", async () => {
    await claimJob();
    const { text } = last();
    expect(text).toMatch(
      /j\.concurrency_key IS NULL OR \( NOT EXISTS \( SELECT 1 FROM job r WHERE r\.status = 'running' AND r\.concurrency_key = j\.concurrency_key \) AND NOT \(\$\d+::jsonb \? j\.concurrency_key\) \)/,
    );
    expect(text).toMatch(/j\.type = 'deploy' AND COALESCE\(j\.payload->>'force', ''\) <> 'true' AND \$\d+::jsonb \?/);
    // The build server is the distribution's build server, else the service's own; rollbacks and image apps take no slot.
    expect(text).toContain("COALESCE(NULLIF(s.distribution->>'buildServerId', ''), s.server_id)");
    expect(text).toContain("d.rollback_of IS NULL");
  });
});

describe("finishing jobs", () => {
  it("success: done, error cleared, run time kept", async () => {
    await finishJob("j1");
    const { text, params } = last();
    expect(params).toEqual([null, null, null, "j1"]);
    expect(text).toMatch(/WHEN \$1::text IS NULL THEN 'done'/);
    expect(text).toMatch(/ELSE run_at END/);
  });

  it("failure: retried later while attempts remain, failed after the last", async () => {
    await finishJob("j1", "boom");
    const { text, params } = last();
    expect(params).toEqual(["boom", "boom", "boom", "j1"]);
    expect(text).toMatch(/WHEN attempts < max_attempts THEN 'pending' ELSE 'failed' END/);
    // Backoff grows with each attempt.
    expect(text).toMatch(/now\(\) \+ \(attempts \* interval '30 seconds'\)/);
  });

  it("an empty error string still counts as a failure", async () => {
    await finishJob("j1", "");
    expect(last().params[0]).toBe("");
  });

  it("failJob ends only a job that still runs, for good", async () => {
    await failJob("j2", "timed out");
    const { text, params } = last();
    expect(text).toMatch(/SET status = 'failed', error = \$1, finished_at = now\(\) WHERE id = \$2 AND status = 'running'/);
    expect(params).toEqual(["timed out", "j2"]);
    expect(text).not.toMatch(/pending/);
  });

  it("recoverStaleJobs fails every running job and returns them for follow-up", async () => {
    sent.rows = [{ id: "j3", type: "deploy", payload: {} }];
    expect(await recoverStaleJobs()).toEqual(sent.rows);
    const { text } = last();
    expect(text).toMatch(/SET status = 'failed'.* WHERE status = 'running' RETURNING id, type, payload/);
  });
});
