import { describe, expect, it } from "vitest";
import { allWidgets, defaultLayout, layoutSchema, newInnerRow, newWidget, normalizeLayout } from "@/lib/dashboard";

describe("dashboard layout", () => {
  it("falls back to the default for unknown or older shapes", () => {
    expect(normalizeLayout(null)).toEqual(defaultLayout());
    expect(normalizeLayout({ version: 1, rows: [{ id: "a", cols: 2, widgets: [] }] })).toEqual(defaultLayout());
  });

  it("keeps a valid layout with an inner row", () => {
    const inner = newInnerRow(2);
    inner.columns[0].items.push(newWidget("note"));
    const layout = { version: 2 as const, rows: [{ id: "r1", title: "Mine", columns: [{ id: "c1", width: 2, items: [newWidget("deploys"), inner] }] }] };
    expect(normalizeLayout(layout)).toEqual(layout);
    expect(allWidgets(layout).map((w) => w.type)).toEqual(["deploys", "note"]);
  });

  it("refuses a row inside an inner row", () => {
    const inner = newInnerRow(1);
    (inner.columns[0].items as unknown[]).push(newInnerRow(1));
    expect(layoutSchema.safeParse({ version: 2, rows: [{ id: "r1", columns: [{ id: "c1", width: 1, items: [inner] }] }] }).success).toBe(false);
  });

  it("only accepts shortcut links inside Serve or on the web", () => {
    const withLink = (href: string) => {
      const w = newWidget("shortcuts");
      w.options.links = [{ label: "x", href }];
      return layoutSchema.safeParse({ version: 2, rows: [{ id: "r1", columns: [{ id: "c1", width: 1, items: [w] }] }] }).success;
    };
    expect(withLink("/servers")).toBe(true);
    expect(withLink("https://example.com/a")).toBe(true);
    expect(withLink("javascript:alert(1)")).toBe(false);
    expect(withLink("//evil.example")).toBe(false);
    expect(withLink("/\\evil.example")).toBe(false);
  });
});
