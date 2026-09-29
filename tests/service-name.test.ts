import { describe, expect, it } from "vitest";
import { SERVICE_NAME_RE, toServiceName, typedServiceName } from "@/lib/service-name";

describe("service names", () => {
  it("drops spaces and symbols while typing, keeps hyphens", () => {
    expect(typedServiceName("my app!")).toBe("myapp");
    expect(typedServiceName("web-2")).toBe("web-2");
  });

  it("turns titles into valid names", () => {
    expect(toServiceName("Uptime Kuma")).toBe("Uptime-Kuma");
    expect(toServiceName("  --n8n (queue)-- ")).toBe("n8n-queue");
    expect(toServiceName("!!!")).toBe("service");
    expect(SERVICE_NAME_RE.test(toServiceName("Uptime Kuma"))).toBe(true);
    expect(SERVICE_NAME_RE.test("bad name")).toBe(false);
  });
});
