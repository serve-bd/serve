import { describe, expect, it } from "vitest";
import { readBodyLimited } from "@/server/http-body";

const chunked = (parts: string[]) =>
  new Request("http://x/", {
    method: "POST",
    body: new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    }),
    duplex: "half",
  } as RequestInit);

describe("readBodyLimited", () => {
  it("reads a body within the limit", async () => {
    expect(await readBodyLimited(new Request("http://x/", { method: "POST", body: "héllo" }), 100)).toBe("héllo");
    expect(await readBodyLimited(chunked(["ab", "cd"]), 4)).toBe("abcd");
  });
  it("refuses a larger body, also without content-length", async () => {
    expect(await readBodyLimited(new Request("http://x/", { method: "POST", body: "x".repeat(11) }), 10)).toBeNull();
    expect(await readBodyLimited(chunked(["x".repeat(6), "x".repeat(6)]), 10)).toBeNull();
  });
  it("reads an empty body", async () => {
    expect(await readBodyLimited(new Request("http://x/"), 10)).toBe("");
  });
});
