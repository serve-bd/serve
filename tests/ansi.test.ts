import { describe, expect, it } from "vitest";
import { parseAnsi, stripAnsi } from "@/lib/ansi";

describe("ansi", () => {
  it("strips colour codes", () => {
    expect(stripAnsi("\x1b[36m2026\x1b[0m [\x1b[32mSERVER\x1b[0m] ok")).toBe("2026 [SERVER] ok");
  });

  it("parses colours and resets", () => {
    expect(parseAnsi("a\x1b[1;31mred\x1b[0mb")).toEqual([{ text: "a" }, { text: "red", bold: true, color: "#ff6961" }, { text: "b" }]);
  });

  it("skips 256 and true colour codes", () => {
    expect(parseAnsi("\x1b[38;5;208mx\x1b[38;2;1;2;3my").map((p) => p.text)).toEqual(["x", "y"]);
  });

  it("drops private modes, colon colours and window titles", () => {
    expect(stripAnsi("\x1b[?25la\x1b]0;title\x07b\x1b[38:5:208mc\x1b]2;t\x1b\\d")).toBe("abcd");
    expect(parseAnsi("\x1b[?25lx\x1b[38:5:208my").map((p) => p.text)).toEqual(["x", "y"]);
  });
});
