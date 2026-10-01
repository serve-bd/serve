import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import fs from "node:fs";
import { composeVariables } from "@/lib/compose-vars";
import { CATALOG_SCHEMA, parseCatalog } from "@/lib/template-catalog";
import { parseCompose, transformCompose } from "@/server/deploy/compose";
import { composeSecurityIssues } from "@/server/security";
import { buildCatalog, INDEX_FILE, serializeCatalog } from "../scripts/templates";

// The same list as the organization template editor offers (services/templates.ts is server-only).
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({ db: {}, schema: {} }));

const templateCategories = ["Automation", "Analytics", "CMS", "Productivity", "Developer tools", "Monitoring", "Storage", "AI", "Communication", "Security", "Media", "Databases"];

const { catalog, problems } = buildCatalog();
const templates = catalog.templates;

describe("template catalog", () => {
  it("builds without problems", () => {
    expect(problems).toEqual([]);
  });

  it("matches templates/index.json (run pnpm templates:build)", () => {
    expect(fs.readFileSync(INDEX_FILE, "utf8")).toBe(serializeCatalog(catalog));
  });

  it("reads back what it writes", () => {
    expect(parseCatalog(serializeCatalog(catalog), "0.1.7")?.templates.length).toBe(templates.length);
  });
});

describe("parseCatalog", () => {
  const good = templates[0];
  const doc = (list: unknown[], schema = CATALOG_SCHEMA) => JSON.stringify({ schema, templates: list });

  it("leaves out broken, duplicate and too-new templates but keeps the rest", () => {
    const out = parseCatalog(
      doc([good, { ...good, id: "broken", expose: null }, good, { ...good, id: "future", minVersion: "9.0.0" }, { ...good, id: "newvar", vars: [{ key: "A", magic: true }] }]),
      "0.1.7",
    );
    expect(out?.templates.map((t) => t.id)).toEqual([good.id]);
    expect(out?.skipped).toEqual(["broken", good.id, "future", "newvar"]);
  });

  it("rejects a file it cannot read", () => {
    expect(parseCatalog("not json", "0.1.7")).toBeNull();
    expect(parseCatalog(doc([good], CATALOG_SCHEMA + 1), "0.1.7")).toBeNull();
    expect(parseCatalog(JSON.stringify({ templates: [] }), "0.1.7")).toBeNull();
  });

  it("refuses logos that could run code", () => {
    for (const logo of ["<svg><script>alert(1)</script></svg>", '<svg onload="x()"></svg>', "<html></html>", '<svg><a href="javascript:x"></a></svg>']) {
      expect(parseCatalog(doc([{ ...good, logo }]), "0.1.7")?.templates, logo).toEqual([]);
    }
  });
});

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
        const out = YAML.parse(transformCompose(t.compose, `tpl-${t.id}`, "svc_test", "10.210.0.0/24"));
        expect(out.services[t.expose.service].labels["serve.service"]).toBe("svc_test");
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

describe("guessVarKind", () => {
  it("never generates credentials from other services", async () => {
    const { guessVarKind } = await import("@/lib/compose-vars");
    for (const k of [
      "AWS_SECRET_ACCESS_KEY",
      "R2_SECRET_ACCESS_KEY",
      "GITHUB_CLIENT_SECRET",
      "R2_ACCESS_KEY_ID",
      "OPENAI_API_KEY",
      "SMTP_PASSWORD",
      "STRIPE_SECRET_KEY",
      "GITHUB_CLIENT_ID",
    ]) {
      expect(guessVarKind(k), k).toBe("value");
    }
  });
  it("generates values the stack owns", async () => {
    const { guessVarKind } = await import("@/lib/compose-vars");
    expect(guessVarKind("POSTGRES_PASSWORD")).toBe("password");
    expect(guessVarKind("BETTER_AUTH_SECRET")).toBe("secret");
    expect(guessVarKind("N8N_ENCRYPTION_KEY")).toBe("secret");
    expect(guessVarKind("INBOUND_WEBHOOK_SECRET")).toBe("secret");
    expect(guessVarKind("APP_URL")).toBe("publicUrl");
    expect(guessVarKind("SOME_TOKEN")).toBe("value");
  });
});

describe("templateVarValue", () => {
  it("makes keys of the promised length", async () => {
    const { templateVarValue } = await import("@/server/services/custom-templates");
    expect(templateVarValue({ key: "K", generate: "hex16" }, false)).toMatch(/^[0-9a-f]{32}$/);
    expect(templateVarValue({ key: "K", generate: "hex32" }, false)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts hex16 in the catalog", () => {
    const t = { ...templates[0], vars: [{ key: "A", generate: "hex16" }] };
    expect(parseCatalog(JSON.stringify({ schema: CATALOG_SCHEMA, templates: [t] }), "0.1.9")?.templates).toHaveLength(1);
  });
});
