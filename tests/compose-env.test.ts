import { describe, expect, it } from "vitest";
import { envFile } from "@/server/deploy/compose";

describe("compose env file", () => {
  it("keeps values without quotes literal in single quotes", () => {
    expect(envFile({ A: "plain $HOME \\n", B: "" })).toBe("A='plain $HOME \\n'\nB=''\n");
  });

  it("escapes values holding a single quote so compose never interpolates them", () => {
    expect(envFile({ A: "it's $HOME ${X}" })).toBe(`A="it's \\$HOME \\\${X}"\n`);
    expect(envFile({ A: `it's "q" \\ end\\` })).toBe(`A="it's \\"q\\" \\\\ end\\\\"\n`);
    expect(envFile({ A: "it's\nnext\r" })).toBe(`A="it's\\nnext\\r"\n`);
  });
});
