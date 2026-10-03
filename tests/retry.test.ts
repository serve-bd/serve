import { describe, expect, it } from "vitest";
import { isTransient, withRetry } from "@/server/net/retry";

describe("retries", () => {
  it("treats network trouble as passing, and access problems as final", () => {
    expect(isTransient(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))).toBe(true);
    expect(
      isTransient(Object.assign(new Error("git clone exited with code 128"), { output: "fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com" })),
    ).toBe(true);
    expect(isTransient(Object.assign(new Error("git clone exited with code 128"), { output: "error: RPC failed; curl 56 GnuTLS recv error\nfatal: early EOF" }))).toBe(true);
    expect(isTransient(new Error("GitHub: HTTP 502"))).toBe(true);
    expect(
      isTransient(Object.assign(new Error("git clone exited with code 128"), { output: "remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found" })),
    ).toBe(false);
    expect(isTransient(Object.assign(new Error("git clone exited with code 128"), { output: "fatal: Remote branch nope not found in upstream origin" }))).toBe(false);
    expect(isTransient(new Error("GitHub: Bad credentials"))).toBe(false);
  });

  it("tries again with a limit, and stops at once on other errors", async () => {
    let calls = 0;
    const lines: string[] = [];
    const flaky = () => {
      calls++;
      return calls < 3 ? Promise.reject(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } })) : Promise.resolve("ok");
    };
    await expect(withRetry(flaky, { what: "Cloning", delays: [1, 1], log: (l) => lines.push(l) })).resolves.toBe("ok");
    expect(calls).toBe(3);
    expect(lines[0]).toMatch(/^Cloning failed \(fetch failed\)\. Trying again in .* \(attempt 2 of 3\)\.$/);

    calls = 0;
    const down = () => {
      calls++;
      return Promise.reject(new Error("GitHub: HTTP 503"));
    };
    await expect(withRetry(down, { what: "Asking GitHub", delays: [1, 1] })).rejects.toThrow("HTTP 503");
    expect(calls).toBe(3);

    calls = 0;
    const denied = () => {
      calls++;
      return Promise.reject(new Error("GitHub: Bad credentials"));
    };
    await expect(withRetry(denied, { what: "Asking GitHub", delays: [1, 1] })).rejects.toThrow("Bad credentials");
    expect(calls).toBe(1);
  });
});
