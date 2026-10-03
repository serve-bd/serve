import { describe, expect, it } from "vitest";
import { servicesCsv, vectorConfig } from "@/server/log-drains/config";

const rows = [{ serviceId: "s1", organizationId: "o1", projectId: "p1", project: 'Shop, "main"', environment: "production", service: "api", type: "app" }];

describe("servicesCsv", () => {
  it("quotes cells with commas and quotes", () => {
    expect(servicesCsv(rows)).toBe('service_id,organization_id,project_id,project,environment,service,type\ns1,o1,p1,"Shop, ""main""",production,api,app\n');
  });
});

describe("vectorConfig", () => {
  const csv = servicesCsv(rows);
  const config = JSON.parse(
    vectorConfig(
      "web-1",
      [
        { id: "d1", organizationId: "o1", kind: "http", url: "https://in.example.com", header: { name: "Authorization", value: "Bearer x" }, projectIds: null },
        { id: "d2", organizationId: "o2", kind: "loki", url: "https://loki.example.com/loki/api/v1/push", username: "u", password: "p", projectIds: ["p9"] },
      ],
      csv,
    ),
  );

  it("sends each drain only its own organization's lines, and its projects", () => {
    expect(config.transforms.drain_d1.condition).toBe('.organization_id == "o1"');
    expect(config.transforms.drain_d2.condition).toBe('.organization_id == "o2" && includes(["p9"], .project_id)');
  });

  it("sends picked projects and picked services together", () => {
    const one = JSON.parse(vectorConfig("web-1", [{ id: "d3", organizationId: "o1", kind: "http", url: "https://x.example.com", projectIds: ["p1"], serviceIds: ["s9"] }], csv));
    expect(one.transforms.drain_d3.condition).toBe('.organization_id == "o1" && (includes(["p1"], .project_id) || includes(["s9"], .service_id))');
    const only = JSON.parse(vectorConfig("web-1", [{ id: "d4", organizationId: "o1", kind: "http", url: "https://x.example.com", projectIds: null, serviceIds: ["s9"] }], csv));
    expect(only.transforms.drain_d4.condition).toBe('.organization_id == "o1" && includes(["s9"], .service_id)');
  });

  it("writes an HTTP sink with the header and a Loki sink with basic auth", () => {
    expect(config.sinks.drain_d1_out.type).toBe("http");
    expect(config.sinks.drain_d1_out.request.headers).toEqual({ Authorization: "Bearer x" });
    expect(config.sinks.drain_d2_out.type).toBe("loki");
    expect(config.sinks.drain_d2_out.endpoint).toBe("https://loki.example.com");
    expect(config.sinks.drain_d2_out.auth).toEqual({ strategy: "basic", user: "u", password: "p" });
  });

  it("changes when the services table changes, so Vector reloads it", () => {
    const other = vectorConfig("web-1", [], servicesCsv([...rows, { ...rows[0], serviceId: "s2" }]));
    expect(other).not.toBe(vectorConfig("web-1", [], csv));
  });

  it("names the server in each line", () => {
    expect(config.transforms.serve_enrich.source).toContain('"server": "web-1"');
  });
});
