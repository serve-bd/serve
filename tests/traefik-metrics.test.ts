import { describe, expect, it } from "vitest";
import { traefikBaseDynamic, traefikStaticArgs } from "@/server/proxy/traefik";

const opts = { email: null, staging: false, trusted: [], hasDnsToken: false };
const dashboard = { enabled: true, hostname: "traefik.example.com", username: "admin", passwordHash: "$2a$10$x" };
const defaults = { catchAll: false, unknownRedirect: "", unavailablePage: false } as never;

describe("Traefik metrics", () => {
  it("stay on loopback without the dashboard", () => {
    expect(traefikStaticArgs({ metrics: true }, opts)).toContain("--metrics.prometheus.entrypoint=traefik");
  });

  it("are served at the dashboard's /metrics, behind its login", () => {
    expect(traefikStaticArgs({ metrics: true, dashboard }, opts)).toContain("--metrics.prometheus.manualrouting=true");
    const dyn = traefikBaseDynamic({ pagesUrl: "http://pages", resolver: true, dashboard, metrics: true, defaults });
    expect(dyn).toContain("serve-traefik-metrics");
    expect(dyn).toContain("prometheus@internal");
    // http:// is sent to https://.
    expect(dyn).toContain("serve-traefik-dashboard-http");
    expect(dyn).toContain("Host(`traefik.example.com`) && Path(`/metrics`)");
    expect(traefikBaseDynamic({ pagesUrl: "http://pages", resolver: true, dashboard, metrics: false, defaults })).not.toContain("prometheus@internal");
  });
});
