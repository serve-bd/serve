import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseServeConfig, planServeConfig, resolveServeConfig, serveConfigFrom, type ServeConfig } from "@/lib/serve-config";
import { serverBlocks } from "@/server/proxy/templates";
import { renderCaddySite } from "@/server/proxy/caddy";
import { renderTraefikSite } from "@/server/proxy/traefik";
import YAML from "yaml";
import { readServeConfigFile } from "@/server/services/serve-config";
import { defaultBuild, defaultRuntime } from "@/server/services/types";
import { SCHEMA_FILE, serveSchemaText } from "../scripts/serve-schema";

// Reading the file needs no database.
vi.mock("@/server/db", () => ({ db: {}, schema: {} }));

const ok = (text: string): ServeConfig => {
  const r = parseServeConfig(text);
  if ("errors" in r) throw new Error(r.errors.join("\n"));
  return r.config;
};
const errors = (value: unknown) => {
  const r = parseServeConfig(typeof value === "string" ? value : JSON.stringify(value));
  return "errors" in r ? r.errors : [];
};
const current = () => ({ build: defaultBuild(), runtime: defaultRuntime(null) });

describe("serve.json parsing", () => {
  it("accepts a full file", () => {
    const config = ok(
      JSON.stringify({
        $schema: "https://serve.bd/schema/serve.json",
        build: { builder: "dockerfile", dockerfile: "docker/Dockerfile", args: { NODE_ENV: "production" }, watchPaths: ["apps/web/**"] },
        deploy: { startCommand: "node server.js", replicas: 2, preDeployCommand: "npm run migrate", restartSchedule: "0 4 * * *" },
        healthcheck: { path: "/health", timeout: 30 },
        resources: { cpu: 0.5, memory: 512 },
        tasks: [{ name: "Clean", schedule: "0 3 * * *", command: "node clean.js", timeout: 600 }],
        volumes: [{ name: "uploads", path: "/app/uploads" }],
        files: [{ path: "/app/config.yml", content: "a: 1\n" }],
        variables: { required: ["DATABASE_URL"] },
      }),
    );
    expect(config.deploy?.replicas).toBe(2);
  });

  it("names the place of each problem", () => {
    expect(errors({ deploy: { replicas: 0 } })[0]).toMatch(/^deploy\.replicas: /);
    expect(errors({ tasks: [{ name: "x", schedule: "every day", command: "ls" }] })[0]).toMatch(/^tasks\[0\]\.schedule: Use a cron expression/);
  });

  it("refuses unknown keys instead of ignoring a typo", () => {
    expect(errors({ deploy: { replica: 2 } })[0]).toBe('deploy: unknown setting "replica"');
    expect(errors({ tsks: [] })[0]).toBe('unknown setting "tsks"');
  });

  it("refuses settings that reach past the app", () => {
    for (const bad of [{ deploy: { privileged: true } }, { ports: [] }, { volumes: [{ name: "/etc", path: "/x" }] }, { domains: ["a.com"] }])
      expect(errors(bad).length).toBeGreaterThan(0);
    expect(errors({ build: { dockerfile: "../../etc/passwd" } })[0]).toMatch(/inside the repository/);
    expect(errors({ build: { dockerfile: "/Dockerfile" } })[0]).toMatch(/inside the repository/);
  });

  it("catches duplicates and mounts on the same path", () => {
    expect(
      errors({
        tasks: [
          { name: "a", schedule: "* * * * *", command: "x" },
          { name: "a", schedule: "* * * * *", command: "y" },
        ],
      })[0],
    ).toMatch(/Two tasks are named "a"/);
    expect(errors({ volumes: [{ name: "v", path: "/data" }], files: [{ path: "/data/", content: "" }] })[0]).toMatch(/mounted twice/);
    expect(errors({ files: [{ path: "/", content: "" }] })[0]).toMatch(/not \/ itself/);
  });

  it("explains broken JSON, a wrong shape and a huge file", () => {
    expect(errors("{ deploy: }")[0]).toMatch(/not valid JSON/);
    expect(errors("[]")[0]).toMatch(/one JSON object/);
    expect(errors(`{"x":"${"a".repeat(300_000)}"}`)[0]).toMatch(/larger than/);
  });

  it("reads a file saved with a byte order mark", () => {
    expect(ok('﻿{"deploy":{"replicas":3}}').deploy?.replicas).toBe(3);
  });
});

describe("applying serve.json", () => {
  it("sets only what the file names and lists those settings", () => {
    const now = current();
    now.runtime.memoryLimit = 256;
    const plan = planServeConfig(ok('{"deploy":{"replicas":3,"port":8080},"build":{"args":{"A":"1"}}}'), now);
    expect(plan.runtime.replicas).toBe(3);
    expect(plan.runtime.port).toBe(8080);
    // A port from the file is the port: no detecting another one from the image.
    expect(plan.runtime.detectPort).toBe(false);
    expect(plan.runtime.memoryLimit).toBe(256);
    expect(plan.build.buildArgs).toEqual([{ key: "A", value: "1" }]);
    expect(plan.settings.map((s) => s.field).sort()).toEqual(["build.buildArgs", "runtime.detectPort", "runtime.port", "runtime.replicas"]);
  });

  it("keeps the dashboard's mounts, replaces the file's own and drops the ones it no longer lists", () => {
    const now = current();
    now.runtime.volumes = [
      { kind: "volume", source: "mine", mountPath: "/mine" },
      { kind: "volume", source: "old", mountPath: "/data" },
      { kind: "volume", source: "gone", mountPath: "/gone" },
    ];
    const plan = planServeConfig(ok('{"volumes":[{"name":"new","path":"/data"}]}'), { ...now, previousMounts: ["/gone"] });
    expect(plan.runtime.volumes).toEqual([
      { kind: "volume", source: "mine", mountPath: "/mine" },
      { kind: "volume", source: "new", mountPath: "/data" },
    ]);
  });

  it("gives every file mount its own stored name", () => {
    const now = current();
    now.runtime.volumes = [{ kind: "file", source: "app-a.yml", mountPath: "/elsewhere", content: "" }];
    const plan = planServeConfig(ok('{"files":[{"path":"/app/a.yml","content":"1"},{"path":"/app-a.yml","content":"2"}]}'), now);
    const names = plan.runtime.volumes.filter((v) => v.kind === "file").map((v) => v.source);
    expect(new Set(names).size).toBe(names.length);
  });

  it("lists tasks with their defaults and the required variables", () => {
    const plan = planServeConfig(ok('{"tasks":[{"name":"a","schedule":"0 * * * *","command":"x"}],"variables":{"required":["KEY"]}}'), current());
    expect(plan.tasks).toEqual([{ name: "a", schedule: "0 * * * *", command: "x", timeoutSeconds: 3600, enabled: true, composeService: null }]);
    expect(plan.required).toEqual(["KEY"]);
  });

  it("is the same applied twice", () => {
    const config = ok('{"deploy":{"replicas":2},"files":[{"path":"/c.yml","content":"x"}]}');
    const once = planServeConfig(config, current());
    const twice = planServeConfig(config, { build: once.build, runtime: once.runtime, previousMounts: ["/c.yml"] });
    expect(twice.runtime).toEqual(once.runtime);
  });
});

describe("Download serve.json", () => {
  it("writes only what differs from the defaults and reads back to the same settings", () => {
    const svc = current();
    svc.runtime = { ...svc.runtime, replicas: 2, healthcheckPath: "/up", volumes: [{ kind: "volume", source: "data", mountPath: "/data" }] };
    svc.build = { ...svc.build, watchPaths: ["src/**"] };
    const tasks = [{ name: "t", schedule: "0 0 * * *", command: "x", timeoutSeconds: 3600, enabled: false }];
    const config = serveConfigFrom({ ...svc, tasks }, current());
    expect(config).toEqual({
      $schema: "https://serve.bd/schema/serve.json",
      build: { watchPaths: ["src/**"] },
      deploy: { replicas: 2 },
      healthcheck: { path: "/up" },
      volumes: [{ name: "data", path: "/data" }],
      tasks: [{ name: "t", schedule: "0 0 * * *", command: "x", enabled: false }],
    });
    const back = planServeConfig(ok(JSON.stringify(config)), current());
    expect(back.runtime.replicas).toBe(2);
    expect(back.runtime.volumes).toEqual(svc.runtime.volumes);
  });
});

describe("finding serve.json", () => {
  it("prefers the root directory's file, falls back to the repository's and refuses links outside", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "serve-json-"));
    try {
      expect(await readServeConfigFile(dir, "/")).toBeNull();
      await fs.writeFile(path.join(dir, "serve.json"), '{"deploy":{"replicas":1}}');
      expect((await readServeConfigFile(dir, "apps/web"))?.path).toBe("serve.json");
      await fs.mkdir(path.join(dir, "apps/web"), { recursive: true });
      await fs.writeFile(path.join(dir, "apps/web/serve.json"), '{"deploy":{"replicas":2}}');
      expect((await readServeConfigFile(dir, "/apps/web"))?.path).toBe("apps/web/serve.json");

      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "serve-json-out-"));
      await fs.writeFile(path.join(outside, "secret"), "{}");
      await fs.rm(path.join(dir, "serve.json"));
      await fs.symlink(path.join(outside, "secret"), path.join(dir, "serve.json"));
      await expect(readServeConfigFile(dir, "/")).rejects.toThrow(/outside the repository/);
      await fs.rm(outside, { recursive: true, force: true });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the JSON Schema for editors", () => {
  it("matches public/schema/serve.json (run pnpm serve-schema)", async () => {
    expect(await fs.readFile(SCHEMA_FILE, "utf8")).toBe(serveSchemaText());
  });
});

describe("environments and previews", () => {
  const config = ok(
    JSON.stringify({
      deploy: { replicas: 1, startCommand: "node a.js" },
      variables: { values: { MODE: "base", A: "1" } },
      environments: { production: { deploy: { replicas: 3 }, variables: { values: { MODE: "prod" } } } },
      previews: { deploy: { replicas: 1 }, tasks: [] },
    }),
  );
  const at = (environment: string, preview = false) => {
    const r = resolveServeConfig(config, { environment, preview });
    if ("errors" in r) throw new Error(r.errors.join("\n"));
    return r;
  };

  it("merges the environment's block over the file, objects key by key", () => {
    const r = at("production");
    expect(r.applied).toEqual(["environments.production"]);
    expect(r.settings.deploy).toEqual({ replicas: 3, startCommand: "node a.js" });
    expect(r.settings.variables?.values).toEqual({ MODE: "prod", A: "1" });
  });

  it("uses the file alone for an environment without a block, and adds previews last", () => {
    expect(at("staging").settings.deploy?.replicas).toBe(1);
    const preview = at("production", true);
    expect(preview.applied).toEqual(["environments.production", "previews"]);
    expect(preview.settings.deploy?.replicas).toBe(1);
  });

  it("checks the merged settings and says which block made the problem", () => {
    const twice = ok(
      JSON.stringify({
        tasks: [{ name: "a", schedule: "* * * * *", command: "x" }],
        environments: {
          staging: {
            tasks: [
              { name: "b", schedule: "* * * * *", command: "x" },
              { name: "b", schedule: "* * * * *", command: "y" },
            ],
          },
        },
      }),
    );
    const r = resolveServeConfig(twice, { environment: "staging", preview: false });
    expect("errors" in r && r.errors[0]).toMatch(/Two tasks are named "b".*\(with environments\.staging\)/);
  });

  it("refuses unknown keys inside a block too", () => {
    expect(errors({ environments: { staging: { deploy: { replica: 2 } } } })[0]).toBe('environments.staging.deploy: unknown setting "replica"');
  });
});

describe("variables, HTTP options and the uptime check", () => {
  it("keeps references and duplicates out of variables", () => {
    expect(errors({ variables: { values: { DB: "${{postgres.DATABASE_URL}}" } } })[0]).toMatch(/set in the dashboard/);
    expect(errors({ variables: { values: { K: "1" }, generate: { K: "secret" } } })[0]).toMatch(/has a value and is generated/);
    expect(errors({ variables: { generate: { K: "nope" } } }).length).toBe(1);
  });

  it("plans values, generated secrets, HTTP options, the check and backups", () => {
    const plan = planServeConfig(
      ok(
        JSON.stringify({
          variables: { values: { A: "1", B: { value: "2", build: true } }, generate: { S: "secret" } },
          http: { headers: { "X-Frame-Options": "DENY" }, cors: ["https://a.example.com"], redirects: [{ from: "/old", to: "/new" }] },
          monitor: { path: "/health", interval: 30, failures: 2 },
          deploy: { backupBefore: ["postgres"] },
        }),
      ),
      current(),
    );
    expect(plan.values).toEqual([
      { key: "A", value: "1", build: false, runtime: true },
      { key: "B", value: "2", build: true, runtime: true },
    ]);
    expect(plan.generate).toEqual([{ key: "S", kind: "secret" }]);
    expect(plan.http).toEqual({ headers: [{ name: "X-Frame-Options", value: "DENY" }], corsOrigins: ["https://a.example.com"], redirects: [{ from: "/old", to: "/new" }] });
    expect(plan.monitor).toEqual({ path: "/health", intervalSeconds: 30, failureThreshold: 2 });
    expect(plan.backupBefore).toEqual(["postgres"]);
  });

  it("refuses HTTP options that could break the proxy or reach past the app", () => {
    expect(errors({ http: { headers: { "X-A": 'a"; evil' } } }).length).toBe(1);
    expect(errors({ http: { redirects: [{ from: "/a b", to: "/b" }] } }).length).toBe(1);
    expect(errors({ http: { redirects: [{ from: "/a", to: "/b;return" }] } }).length).toBe(1);
    expect(errors({ http: { basicAuth: {} } })[0]).toMatch(/unknown setting "basicAuth"/);
    expect(errors({ http: { customDirectives: "x" } })[0]).toMatch(/unknown setting/);
    expect(errors({ monitor: { url: "http://10.0.0.1" } })[0]).toMatch(/unknown setting "url"/);
    expect(errors({ monitor: { interval: 45 } }).length).toBe(1);
  });
});

describe("redirects in every proxy", () => {
  const redirects = [
    { from: "/old", to: "/new" },
    { from: "/docs.html", to: "https://docs.example.com/start", permanent: false },
  ];
  const site = {
    name: "svc-abc",
    title: "app",
    serviceId: "abc",
    stopped: false,
    upstreams: [{ key: "u", targets: ["app-1:3000"] }],
    hosts: [{ hostname: "app.test", upstream: "u", redirectTo: null, https: false, forceHttps: false, tunnel: false, tls: null }],
    options: { redirects },
  };

  it("nginx: an exact location that returns the redirect", () => {
    const out = serverBlocks({ hostname: "app.test", upstream: "up", forceHttps: false, options: { redirects } });
    expect(out).toContain("location = /old {\n        return 308 /new;");
    expect(out).toContain("location = /docs.html {\n        return 307 https://docs.example.com/start;");
  });

  it("nginx: during maintenance only allowed visitors are redirected", () => {
    const out = serverBlocks({
      hostname: "app.test",
      upstream: "up",
      forceHttps: false,
      options: { redirects },
      maintenance: { page: "m.html", retryAfter: 60, allow: ["10.0.0.1"], geoVar: "serve_m_x" } as never,
    });
    expect(out).toMatch(/location = \/old \{\n\s+if \(\$serve_m_x = 0\) \{\n\s+return 503;\n\s+\}\n\s+return 308 \/new;/);
  });

  it("Caddy: with no app running, allowed visitors get the maintenance page too", () => {
    const out = renderCaddySite({ ...site, upstreams: [{ key: "u", targets: [] }], stopped: true, maintenance: { page: "m.html", retryAfter: 60, allow: ["10.0.0.1"] } } as never);
    expect(out).toContain("@serve_maintenance path *");
    const running = renderCaddySite({ ...site, maintenance: { page: "m.html", retryAfter: 60, allow: ["10.0.0.1"] } } as never);
    expect(running).toContain("@serve_maintenance not client_ip 10.0.0.1");
  });

  it("Caddy: redir with the status", () => {
    const out = renderCaddySite(site as never);
    expect(out).toContain("redir /old /new 308");
    expect(out).toContain("redir /docs.html https://docs.example.com/start 307");
  });

  it("Caddy: no redirects while the app has no containers, like nginx and Traefik", () => {
    const out = renderCaddySite({ ...site, upstreams: [{ key: "u", targets: [] }], stopped: true } as never);
    expect(out).not.toContain("redir /old");
  });

  it("Traefik: a redirect middleware first in the chain, the dot escaped", () => {
    const doc = YAML.parse(renderTraefikSite(site as never, { resolver: false, trusted: [] }));
    const mw = doc.http.middlewares;
    expect(mw["svc-abc-redirect-0"].redirectRegex).toEqual({ regex: "^(https?://[^/]+)/old(\\?.*)?$", replacement: "${1}/new", permanent: true });
    expect(mw["svc-abc-redirect-1"].redirectRegex.regex).toBe("^(https?://[^/]+)/docs\\.html(\\?.*)?$");
    const router = Object.values(doc.http.routers as Record<string, { middlewares?: string[] }>)[0];
    expect(router.middlewares?.slice(0, 2)).toEqual(["svc-abc-redirect-1", "svc-abc-redirect-0"]);
  });
});
