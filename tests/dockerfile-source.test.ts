import { describe, expect, it } from "vitest";
import { dockerfileBase } from "@/lib/dockerfile";
import { needsRegistry } from "@/server/deploy/distribution";
import { dockerfileSourceSchema } from "@/server/services/source-schema";
import { buildsImage, DOCKERFILE_MAX_BYTES } from "@/server/services/types";

const problems = (content: string) => {
  const r = dockerfileSourceSchema.safeParse({ type: "dockerfile", content });
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("Dockerfile sources", () => {
  it("accepts a Dockerfile and refuses empty, oversized or FROM-less ones", () => {
    expect(problems("FROM alpine:3\nCMD echo hi\n")).toEqual([]);
    expect(problems("  \n")).toEqual(["Paste a Dockerfile."]);
    expect(problems("RUN echo hi")).toEqual(["A Dockerfile starts from an image: add a FROM line."]);
    expect(problems(`FROM alpine\n# ${"x".repeat(DOCKERFILE_MAX_BYTES)}`)).toEqual(["The Dockerfile is limited to 64 KB."]);
  });

  it("finds the base image of the final stage", () => {
    expect(dockerfileBase("FROM node:22 AS build\nRUN x\nfrom --platform=$BUILDPLATFORM nginx:alpine AS web\n")).toBe("nginx:alpine");
    expect(dockerfileBase("# no stages")).toBeNull();
  });

  it("is built like a git source: build servers and registries apply", () => {
    expect(buildsImage("dockerfile")).toBe(true);
    expect(buildsImage("git")).toBe(true);
    expect(buildsImage("image")).toBe(false);
    const dist = { buildServerId: "b", registryId: null, repository: null, tag: null, tagLatest: false, extraServerIds: [] };
    expect(needsRegistry(dist, "dockerfile")).toBe(true);
    expect(needsRegistry(dist, "image")).toBe(false);
  });
});
