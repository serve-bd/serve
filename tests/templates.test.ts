import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { composeVariables, templateCategories, templates } from "@/server/services/templates";
import { parseCompose, transformCompose } from "@/server/deploy/compose";
import { composeSecurityIssues } from "@/server/security";

describe("built-in templates", () => {
  it("have unique ids", () => {
    const ids = templates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("use a known category", () => {
    for (const t of templates) expect(templateCategories, t.id).toContain(t.category);
  });

  for (const t of templates) {
    describe(t.id, () => {
      it("parses and transforms", () => {
        const doc = parseCompose(t.compose);
        expect(Object.keys(doc.services ?? {}), "expose.service exists").toContain(t.expose.service);
        const out = YAML.parse(transformCompose(t.compose, `tpl-${t.id}`, "svc_test", "10.210.0.0/24", "serve"));
        expect(out.networks.serve.external).toBe(true);
        expect(t.expose.port).toBeGreaterThan(0);
      });

      it("declares every variable it uses", () => {
        const declared = new Set(t.vars.map((v) => v.key));
        for (const v of composeVariables(t.compose)) {
          if (!v.hasDefault) expect(declared.has(v.name), `\${${v.name}} is not declared`).toBe(true);
        }
      });

      it("uses every variable it declares", () => {
        const used = new Set(composeVariables(t.compose).map((v) => v.name));
        for (const v of t.vars) expect(used.has(v.key), `${v.key} is declared but unused`).toBe(true);
      });

      it("declares named volumes it mounts", () => {
        const doc = YAML.parse(t.compose) as { services: Record<string, { volumes?: string[] }>; volumes?: Record<string, unknown> };
        const named = Object.values(doc.services)
          .flatMap((s) => s.volumes ?? [])
          .map((v) => String(v).split(":")[0])
          .filter((src) => !src.startsWith("/") && !src.startsWith("."));
        for (const n of named) expect(Object.keys(doc.volumes ?? {}), `volume ${n}`).toContain(n);
      });

      it("flags host access honestly", () => {
        expect(composeSecurityIssues(t.compose).length > 0).toBe(!!t.hostAccess);
      });
    });
  }
});

describe("composeVariables", () => {
  it("finds plain and defaulted variables and skips escapes", () => {
    expect(composeVariables("a: ${A}\nb: ${B:-x}\nc: $${C}\nd: ${D-y}")).toEqual([
      { name: "A", hasDefault: false },
      { name: "B", hasDefault: true },
      { name: "D", hasDefault: true },
    ]);
  });
});
