import { describe, expect, it } from "vitest";
import { AGENT_CONTAINERS_FRESH_MS, freshAgentContainers, fromAgent } from "@/server/monitoring/containers";

const container = {
  id: "c1",
  name: "web-1",
  service: "s1",
  deployment: "d1",
  state: "running",
  restartCount: 3,
  startedAt: "2026-10-01T10:00:00Z",
  created: 1_790_000_000,
  exitCode: 0,
};

describe("agent container reports", () => {
  it("map to what the status and crash checks read", () => {
    const v = fromAgent(container);
    expect(v.Labels).toEqual({ "serve.service": "s1", "serve.deployment": "d1" });
    expect(v.info).toMatchObject({ name: "web-1", restartCount: 3, running: true, createdAt: 1_790_000_000_000, startedAt: Date.parse("2026-10-01T10:00:00Z") });
  });

  it("are used only while recent and while the agent works", () => {
    const now = Date.parse("2026-10-01T10:05:00Z");
    const at = (ms: number) => new Date(now - ms).toISOString();
    const agent = { image: "i", tokenHash: "h", installedAt: at(0), containers: [container] };
    expect(freshAgentContainers({ ...agent, containersAt: at(5_000) }, now)).toHaveLength(1);
    expect(freshAgentContainers({ ...agent, containersAt: at(AGENT_CONTAINERS_FRESH_MS + 1) }, now)).toBeNull();
    expect(freshAgentContainers({ ...agent, containersAt: at(5_000), error: "broken" }, now)).toBeNull();
    expect(freshAgentContainers(null, now)).toBeNull();
  });
});
