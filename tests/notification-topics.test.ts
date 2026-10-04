import { describe, expect, it } from "vitest";
import { topicFor } from "@/lib/notifications";

describe("Telegram topics by event", () => {
  it("picks the most specific topic for an event", () => {
    const map = "deploy=12, deploy.failed=13\nbackup=15";
    expect(topicFor(map, "deploy.success")).toBe(12);
    expect(topicFor(map, "deploy.failed")).toBe(13);
    expect(topicFor(map, "backup.failed")).toBe(15);
    expect(topicFor(map, "service.down")).toBeNull();
    // "deploy" is not the start of "deployx".
    expect(topicFor("deploy=1", "deployx.y")).toBeNull();
    expect(topicFor(undefined, "deploy.failed")).toBeNull();
  });
});
