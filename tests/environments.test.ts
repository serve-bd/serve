import { describe, expect, it } from "vitest";
import { rewriteValue } from "@/server/services/clone-values";

describe("cloning variables", () => {
  const slugs = new Map([
    ["postgres-ab12cd", "postgres-zz99yy"],
    ["api-x1", "api-q7"],
  ]);
  const passwords = new Map([["OldPassword123456", "NewPassword654321"]]);

  it("points references and hostnames at the copies", () => {
    expect(rewriteValue("${{postgres-ab12cd.DATABASE_URL}}", slugs, passwords)).toBe("${{postgres-zz99yy.DATABASE_URL}}");
    expect(rewriteValue("postgres://app:OldPassword123456@postgres-ab12cd:5432/app", slugs, passwords)).toBe("postgres://app:NewPassword654321@postgres-zz99yy:5432/app");
    expect(rewriteValue("http://api-x1:3000,http://api-x1:3001", slugs, passwords)).toBe("http://api-q7:3000,http://api-q7:3001");
  });

  it("leaves longer slugs and unrelated text alone", () => {
    expect(rewriteValue("api-x12 and my-api-x1", slugs, passwords)).toBe("api-x12 and my-api-x1");
    expect(rewriteValue("${{postgresql.DATABASE_URL}}", slugs, passwords)).toBe("${{postgresql.DATABASE_URL}}");
    // Short passwords are too likely to appear by chance.
    expect(rewriteValue("abc", slugs, new Map([["abc", "xyz"]]))).toBe("abc");
  });
});
