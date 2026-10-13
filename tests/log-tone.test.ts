import { describe, expect, it } from "vitest";
import { lineTone } from "@/components/log-viewer";

describe("log line colors", () => {
  it("does not color counts of zero or empty error fields", () => {
    expect(lineTone('200 {"ok":true,"backups":{"failed":0},"abandoned":{"failed":0}}')).toBe("");
    expect(lineTone("done: errors=0 warnings=0")).toBe("");
    expect(lineTone('{"error":null,"warnings":[]}')).toBe("");
    expect(lineTone("failures: 0, exceptions: none")).toBe("");
  });
  it("does not color a build step's command", () => {
    expect(lineTone('#5 [2/4] RUN echo "Rendering error pages for /404"')).toBe("");
    expect(lineTone('#9 [builder 3/7] RUN pnpm build || echo "build failed"')).toBe("");
    expect(lineTone("#7 0.308 TypeError: Cannot read properties of undefined (reading 'map')")).toBe("err");
    expect(lineTone("#7 0.308 info: 0 errors, 0 warnings")).toBe("");
  });
  it("does not color a commit message", () => {
    expect(lineTone("Checked out 52ef6d1 — feat(site): app-style PWA home, new error pages, no gear on server cards")).toBe("");
  });
  it("does not color the words inside paths and names", () => {
    expect(lineTone("#15 93.43 ├ ƒ /admin/error-logs")).toBe("");
    expect(lineTone("GET /api/errors/list 200")).toBe("");
    expect(lineTone("loaded module fatal_handler and warn-banner")).toBe("");
  });
  it("trusts the level a line states", () => {
    // JSON loggers (pino numbers, winston/bunyan/zap strings, GCP severity)
    expect(lineTone('{"level":30,"time":1,"msg":"failed login retried"}')).toBe("");
    expect(lineTone('{"level":50,"msg":"db down"}')).toBe("err");
    expect(lineTone('{"level":40,"msg":"slow"}')).toBe("warn");
    expect(lineTone('{"level":"info","message":"error page rendered"}')).toBe("");
    expect(lineTone('{"severity":"ERROR","message":"boom"}')).toBe("err");
    // logfmt (Go slog, logrus)
    expect(lineTone('time=2026-10-13T10:00:00Z level=INFO msg="0 errors, cache warning cleared"')).toBe("");
    expect(lineTone("time=2026-10-13T10:00:00Z level=error msg=boom")).toBe("err");
    expect(lineTone('level=warn msg="disk at 80%"')).toBe("warn");
    // A level word in front, after a timestamp
    expect(lineTone("2026-10-13 10:00:00,123 INFO Rendering error page for /missing")).toBe("");
    expect(lineTone("2026-10-13T10:00:00.000Z ERROR Unhandled rejection")).toBe("err");
    expect(lineTone("[2026-10-13 10:00:00] [warn] slow handler")).toBe("warn");
    expect(lineTone("10:00:00 INFO  failed jobs: retrying 2")).toBe("");
    expect(lineTone("ERROR:root:could not connect")).toBe("err");
    expect(lineTone("info: server started, error tracking on")).toBe("");
    expect(lineTone("E, [2026-10-13T10:00:00.000 #1] ERROR -- : boom")).toBe("err");
    expect(lineTone("2026-10-12 22:11:46.599 UTC [3337] FATAL:  terminating connection")).toBe("err");
    expect(lineTone("2026-10-12 22:11:46.599 UTC [3337] LOG:  checkpoint complete: 0 errors")).toBe("");
    expect(lineTone('{"t":{"$date":"2026-10-13"},"s":"I","c":"NETWORK","msg":"Connection ended","attr":{"error":"closed"}}')).toBe("");
    expect(lineTone('{"t":{"$date":"2026-10-13"},"s":"E","c":"STORAGE","msg":"WiredTiger error"}')).toBe("err");
    expect(lineTone("I, [2026-10-13T10:00:00.000 #1]  INFO -- : Completed 500 Internal Server Error")).toBe("");
  });
  it("knows the tools' own error lines", () => {
    expect(lineTone("npm ERR! code ELIFECYCLE")).toBe("err");
    expect(lineTone("npm error code ERESOLVE")).toBe("err");
    expect(lineTone("npm warn deprecated inflight@1.0.6")).toBe("warn");
    expect(lineTone(" ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile")).toBe("err");
    expect(lineTone("#12 ERROR: failed to solve: process did not complete")).toBe("err");
    expect(lineTone("TypeError: Cannot read properties of undefined")).toBe("err");
    expect(lineTone("Uncaught ReferenceError: x is not defined")).toBe("err");
    expect(lineTone('Exception in thread "main" java.lang.NullPointerException')).toBe("err");
    expect(lineTone("Traceback (most recent call last):")).toBe("err");
    expect(lineTone("panic: runtime error: index out of range")).toBe("err");
  });
  it("reads Serve's own markers", () => {
    expect(lineTone("Warning: proxy update failed: timeout")).toBe("warn");
    expect(lineTone("Failed: Sweep could not be scheduled")).toBe("err");
    expect(lineTone("Hint: the build failed because the port is wrong")).toBe("");
    expect(lineTone("[eu-1] Warning: not running the new version on eu-1")).toBe("warn");
  });
  it("still colors real problems", () => {
    expect(lineTone("build failed.")).toBe("err");
    expect(lineTone("[error] something broke")).toBe("err");
    expect(lineTone("WARN: slow query")).toBe("warn");
    expect(lineTone('{"failed":2}')).toBe("err");
    expect(lineTone("Error: connect ECONNREFUSED")).toBe("err");
    expect(lineTone('{"error":"timeout"}')).toBe("err");
    expect(lineTone("request failed after 3 tries")).toBe("err");
    expect(lineTone("warning: disk almost full")).toBe("warn");
    expect(lineTone('ok, but "failed":0 and then a fatal crash')).toBe("err");
  });
});
