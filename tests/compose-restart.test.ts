import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { transformCompose } from "@/server/deploy/compose";

const services = (content: string) => YAML.parse(transformCompose(content, "shop", "svc1"), { version: "1.1" }).services;

describe("compose restart policy", () => {
  it("brings services back after a reboot unless the file decides", () => {
    const out = services(`
services:
  web: { image: nginx, depends_on: { migrate: { condition: service_completed_successfully } } }
  db: { image: postgres, restart: always }
  worker: { image: busybox, deploy: { restart_policy: { condition: on-failure } } }
  migrate: { image: busybox }
`);
    expect(out.web.restart).toBe("unless-stopped");
    expect(out.db.restart).toBe("always");
    expect(out.worker.restart).toBeUndefined();
    // A job others wait to finish runs once.
    expect(out.migrate.restart).toBeUndefined();
  });
});
