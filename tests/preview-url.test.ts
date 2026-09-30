import { describe, expect, it } from "vitest";
import { normalizePreviewTemplate, previewHostname, previewTemplateProblem } from "@/lib/preview-url";

describe("preview URL templates", () => {
  it("accepts {pr} in the first label", () => {
    for (const t of ["pr-{pr}.example.com", "{pr}.app.example.com", "app-{pr}-preview.example.com"]) expect(previewTemplateProblem(t)).toBeNull();
    expect(previewHostname("pr-{pr}.example.com", 12)).toBe("pr-12.example.com");
  });
  it("understands other spellings and a plain wildcard", () => {
    expect(normalizePreviewTemplate(" {{pr_id}}.Example.com ")).toBe("{pr}.example.com");
    expect(normalizePreviewTemplate("https://{{ pr }}.example.com/")).toBe("{pr}.example.com");
    expect(normalizePreviewTemplate("*.preview.example.com")).toBe("pr-{pr}.preview.example.com");
    expect(normalizePreviewTemplate("")).toBe("");
  });
  it("refuses templates one wildcard record cannot cover", () => {
    expect(previewTemplateProblem("app.{pr}.example.com")).not.toBeNull();
    expect(previewTemplateProblem("example.com")).not.toBeNull();
    expect(previewTemplateProblem("{pr}-{pr}.example.com")).not.toBeNull();
    expect(previewTemplateProblem("{pr}.exa mple.com")).not.toBeNull();
    expect(previewTemplateProblem("{pr}")).not.toBeNull();
  });
});
