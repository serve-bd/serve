import { describe, expect, it } from "vitest";
import { knownBuildpacksBuilder } from "@/server/deploy/builders";

describe("knownBuildpacksBuilder", () => {
  it("accepts Heroku and Paketo builders", () => {
    expect(knownBuildpacksBuilder("heroku/builder:24")).toBe(true);
    expect(knownBuildpacksBuilder("docker.io/heroku/builder:22")).toBe(true);
    expect(knownBuildpacksBuilder("paketobuildpacks/builder-jammy-base")).toBe(true);
    expect(knownBuildpacksBuilder("paketobuildpacks/ubuntu-noble-builder:latest")).toBe(true);
  });

  it("needs host rights for any other image", () => {
    expect(knownBuildpacksBuilder("evil/builder:24")).toBe(false);
    expect(knownBuildpacksBuilder("heroku/builderx")).toBe(false);
    expect(knownBuildpacksBuilder("ghcr.io/heroku/builder:24")).toBe(false);
    expect(knownBuildpacksBuilder("paketobuildpacks/run-jammy-base")).toBe(false);
  });
});
