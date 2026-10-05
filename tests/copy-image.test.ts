import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { copyImage } from "@/server/docker/client";
import type Docker from "dockerode";

/** A source server whose `docker save` sends `chunks`, then hangs open when `hang` is set. */
function source(chunks: Buffer[], hang: boolean) {
  const stream = new Readable({ read() {} });
  for (const c of chunks) stream.push(c);
  if (!hang) stream.push(null);
  return { getImage: () => ({ get: async () => stream }) } as unknown as Docker;
}

/** A target server that reads the whole upload, then answers `answer`. */
function target(answer: string) {
  return {
    loadImage: async (input: NodeJS.ReadableStream) => {
      for await (const _ of input as AsyncIterable<Buffer>);
      const res = new PassThrough();
      res.end(answer);
      return res;
    },
  } as unknown as Docker;
}

describe("copyImage", () => {
  it("copies an image and reads the load's answer", async () => {
    await expect(copyImage("app:1", source([Buffer.from("layer")], false), target('{"stream":"Loaded image"}\n'))).resolves.toBeUndefined();
  });

  it("reports an error docker load puts in its answer", async () => {
    await expect(copyImage("app:1", source([Buffer.from("x")], false), target('{"error":"no space left on device"}\n'))).rejects.toThrow("no space left");
  });

  it("fails instead of waiting forever when the copy stops moving", async () => {
    const started = Date.now();
    await expect(copyImage("app:1", source([Buffer.from("half")], true), target(""), { stallMs: 1500 })).rejects.toThrow(/nothing moved/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);
});
