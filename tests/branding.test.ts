import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
vi.mock("@/server/settings", () => ({ BRAND_ASSET_PREFIX: "brandAsset:", defaultSettings: { instanceName: "Serve" } }));

import { accentCss, accentTokens, checkBrandImage, cleanProductName, contrast, detectImageType, MAX_BRAND_IMAGE_BYTES, normalizeHex, unsafeSvgReason } from "@/lib/branding";
import { brandFromConfig } from "@/server/branding";

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);
const text = (s: string) => new TextEncoder().encode(s);

describe("detectImageType", () => {
  it("reads the type from the first bytes", () => {
    expect(detectImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(detectImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(detectImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe("image/webp");
    expect(detectImageType(bytes(0x00, 0x00, 0x01, 0x00, 0x01, 0x00))).toBe("image/x-icon");
  });

  it("recognises SVG after an XML declaration, a BOM or comments", () => {
    expect(detectImageType(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe("image/svg+xml");
    expect(detectImageType(text('﻿<?xml version="1.0"?>\n<!-- logo -->\n<svg viewBox="0 0 1 1"/>'))).toBe("image/svg+xml");
  });

  it("refuses anything else, whatever it is called", () => {
    expect(detectImageType(text("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(detectImageType(text("GIF89a"))).toBeNull();
    expect(detectImageType(new Uint8Array())).toBeNull();
  });
});

describe("unsafeSvgReason", () => {
  it("allows a plain drawing with inline styles", () => {
    expect(unsafeSvgReason('<svg viewBox="0 0 10 10"><style>.a{fill:#000}</style><rect class="a" width="10" height="10"/></svg>')).toBeNull();
  });

  it.each([
    ["<svg><script>alert(1)</script></svg>", /scripts/],
    ['<svg onload="alert(1)"></svg>', /event handlers/],
    ['<svg><a href="javascript:alert(1)"><text>x</text></a></svg>', /javascript/],
    ["<svg><foreignObject><div/></foreignObject></svg>", /HTML/],
    ['<!DOCTYPE svg [<!ENTITY x "y">]><svg/>', /DOCTYPE/],
    ['<svg><image href="https://evil.example/x.png"/></svg>', /load other files/],
    ["<svg><style>@import url(//evil.example/a.css);</style></svg>", /load other files/],
  ])("refuses %s", (svg, reason) => {
    expect(unsafeSvgReason(svg)).toMatch(reason);
  });
});

describe("checkBrandImage", () => {
  it("takes .ico only as a favicon", () => {
    const ico = bytes(0x00, 0x00, 0x01, 0x00, 0x01, 0x00);
    expect(checkBrandImage("favicon", ico).mime).toBe("image/x-icon");
    expect(checkBrandImage("logo", ico).error).toMatch(/PNG, JPEG, WebP or SVG/);
  });

  it("refuses large files, empty files and unsafe SVG", () => {
    const big = new Uint8Array(MAX_BRAND_IMAGE_BYTES + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(checkBrandImage("logo", big).error).toMatch(/512 KB/);
    expect(checkBrandImage("logo", new Uint8Array()).error).toMatch(/empty/);
    expect(checkBrandImage("logo", text("<svg><script/></svg>")).error).toMatch(/scripts/);
  });
});

describe("accent colour", () => {
  it("normalizes hex values and refuses the rest", () => {
    expect(normalizeHex("#0A84FF")).toBe("#0a84ff");
    expect(normalizeHex("0af")).toBe("#00aaff");
    expect(normalizeHex("red")).toBeNull();
    expect(normalizeHex("#0a84ff;}body{")).toBeNull();
  });

  it("keeps the accent visible on both backgrounds", () => {
    const pale = accentTokens("#fff4a8");
    expect(pale).not.toBeNull();
    expect(contrast(pale!.light.accent, "#f5f5f7")).toBeGreaterThanOrEqual(3);
    const dark = accentTokens("#101030");
    expect(contrast(dark!.dark.accent, "#0b0b0d")).toBeGreaterThanOrEqual(3);
  });

  it("picks readable button text", () => {
    expect(accentTokens("#0a84ff")!.light.fg).toBe("#ffffff");
    expect(accentTokens("#ffd60a")!.dark.fg).toBe("#000000");
  });

  it("builds CSS only from a valid colour", () => {
    expect(accentCss("#0a84ff")).toContain("--accent:");
    expect(accentCss("#0a84ff")).toContain('[data-theme="dark"]');
    expect(accentCss("javascript:alert(1)")).toBeNull();
    expect(accentCss(null)).toBeNull();
  });
});

describe("brandFromConfig", () => {
  it("uses the defaults without a config", () => {
    expect(brandFromConfig(null, null)).toMatchObject({ name: "Serve", logoUrl: null, faviconUrl: null, showName: true, accentCss: null });
  });

  it("versions image URLs and falls back from favicon to logo", () => {
    const b = brandFromConfig("Acme Cloud", { showName: false, accent: "#ff375f", logo: { hash: "abc", mime: "image/png" }, logoDark: null, favicon: null });
    expect(b.name).toBe("Acme Cloud");
    expect(b.logoUrl).toBe("/api/branding/logo?v=abc");
    expect(b.faviconUrl).toBe("/api/branding/favicon?v=abc");
    expect(b.showName).toBe(false);
    const withIcon = brandFromConfig("Acme", {
      showName: true,
      accent: null,
      logo: { hash: "abc", mime: "image/png" },
      logoDark: null,
      favicon: { hash: "ico1", mime: "image/x-icon" },
    });
    expect(withIcon.faviconUrl).toBe("/api/branding/favicon?v=ico1");
  });

  it("always shows the name with the default mark", () => {
    expect(brandFromConfig("Acme", { showName: false, accent: null, logo: null, logoDark: null, favicon: null }).showName).toBe(true);
  });

  it("cleans the product name", () => {
    expect(cleanProductName("  Acme\n<b>Cloud</b>  ")).toBe("Acme b Cloud /b");
  });
});

describe("proxy error pages", () => {
  it("carry the product name, escaped", async () => {
    const { errorPages } = await import("@/server/proxy/templates");
    const pages = errorPages("Acme <Cloud>");
    expect(pages["unavailable.html"]).toContain("Served by Acme &lt;Cloud&gt;");
    expect(pages["not-found.html"]).toContain("points to a Acme &lt;Cloud&gt; server");
    expect(errorPages()["unavailable.html"]).toContain("Served by Serve");
  });

  it("carry the branding icon when there is one", async () => {
    const { errorPages } = await import("@/server/proxy/templates");
    const pages = errorPages("Acme", { icon: "data:image/png;base64,AAA" });
    for (const html of Object.values(pages)) expect(html).toContain('<link rel="icon" href="data:image/png;base64,AAA">');
    expect(errorPages("Acme")["unavailable.html"]).not.toContain('rel="icon"');
  });
});
