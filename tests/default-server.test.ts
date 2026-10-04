import { describe, expect, it } from "vitest";
import { pickDefault } from "@/lib/default-server";

const local = { id: "local", status: "ready", isLocal: true };
const fsn = { id: "fsn", status: "ready", isLocal: false };
const down = { id: "down", status: "unreachable", isLocal: false };

describe("pickDefault", () => {
  it("is the first usable server when none was chosen (the local server on a new install)", () => {
    expect(pickDefault([local, fsn], null)?.id).toBe("local");
  });

  it("is the chosen server while it is usable", () => {
    expect(pickDefault([local, fsn], "fsn")?.id).toBe("fsn");
  });

  it("falls back when the chosen server is not ready, was deleted, or is not allowed", () => {
    expect(pickDefault([local, down], "down")?.id).toBe("local");
    expect(pickDefault([local, fsn], "gone")?.id).toBe("local");
    expect(pickDefault([fsn], "local")?.id).toBe("fsn");
  });

  it("is a ready remote server when the organization may not use the local one", () => {
    expect(pickDefault([down, fsn], null)?.id).toBe("fsn");
  });

  it("is null when the organization can use no server", () => {
    expect(pickDefault([down], null)).toBeNull();
    expect(pickDefault([], "fsn")).toBeNull();
  });
});
