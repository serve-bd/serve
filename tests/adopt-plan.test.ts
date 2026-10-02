import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type Docker from "dockerode";
import { choosePort, listeningPorts, planAdoption } from "@/server/adopt/plan";

// A container made outside Serve becomes a service that runs it as it ran: same image, variables,
// command, data, ports and the names other containers reach it by.

const image = (over: Record<string, unknown> = {}) =>
  ({
    Id: "sha256:" + "a".repeat(64),
    Config: { Env: ["PATH=/usr/bin", "PGDATA=/var/lib/postgresql/data"], Entrypoint: ["docker-entrypoint.sh"], Cmd: ["postgres"], ...over },
  }) as unknown as Docker.ImageInspectInfo;

function container(
  over: { env?: string[]; cmd?: string[]; mounts?: unknown[]; ports?: Record<string, unknown>; networks?: Record<string, unknown>; image?: string; running?: boolean } = {},
) {
  return {
    Id: "b".repeat(64),
    Name: "/shop-db",
    Image: "sha256:" + "a".repeat(64),
    State: { Running: over.running ?? true },
    Config: {
      Image: over.image ?? "postgres:16-alpine",
      Env: over.env ?? ["PATH=/usr/bin", "PGDATA=/var/lib/postgresql/data", "POSTGRES_PASSWORD=secret-pass", "POSTGRES_DB=shop", "TZ=UTC"],
      Entrypoint: ["docker-entrypoint.sh"],
      Cmd: over.cmd ?? ["postgres"],
      ExposedPorts: { "5432/tcp": {} },
      Labels: {},
    },
    HostConfig: { NetworkMode: "shop_default", RestartPolicy: { Name: "unless-stopped" }, PortBindings: over.ports ?? {}, Init: false },
    Mounts: over.mounts ?? [{ Type: "volume", Name: "shop_pgdata", Source: "/var/lib/docker/volumes/shop_pgdata/_data", Destination: "/var/lib/postgresql/data", RW: true }],
    NetworkSettings: { Networks: over.networks ?? { shop_default: { Aliases: ["shop-db", "db"], DNSNames: ["shop-db", "db", "bbbbbbbbbbbb"] } } },
  } as unknown as Docker.ContainerInspectInfo;
}

describe("planAdoption", () => {
  it("keeps the data volume, the names and only the container's own variables", () => {
    const p = planAdoption(container(), image());
    expect(p.image).toBe("postgres:16-alpine");
    expect(p.volumes).toEqual([{ kind: "volume", source: "shop_pgdata", mountPath: "/var/lib/postgresql/data", external: true }]);
    expect(p.networks).toEqual([{ name: "shop_default", aliases: ["shop-db", "db"] }]);
    expect(p.hostname).toBe("shop-db");
    expect(p.env.map((e) => e.key)).toEqual(["POSTGRES_PASSWORD", "POSTGRES_DB", "TZ"]);
    expect(p.entrypoint).toBeNull();
  });

  it("makes a database plan on the same data directory", () => {
    const d = planAdoption(container(), image()).database!;
    expect(d).toMatchObject({ engine: "postgres", version: "16-alpine", username: "postgres", password: "secret-pass", database: "shop" });
    expect(d).toMatchObject({ dataVolume: "shop_pgdata", dataMountPath: "/var/lib/postgresql/data", pgdata: "/var/lib/postgresql/data" });
    expect(d.droppedEnv).toEqual(["TZ"]);
  });

  it("keeps extra server flags as database arguments", () => {
    const d = planAdoption(container({ cmd: ["postgres", "-c", "max_connections=300"] }), image()).database!;
    expect(d.extraArgs).toBe("-c max_connections=300");
  });

  it("moves as a container when the data or the password is not where Serve can use it", () => {
    const noVolume = planAdoption(container({ mounts: [] }), image());
    expect(noVolume.database).toBeNull();
    expect(noVolume.databaseProblems.join(" ")).toMatch(/No volume holds its data/);
    const noPassword = planAdoption(container({ env: ["POSTGRES_PASSWORD_FILE=/run/secrets/pw"] }), image());
    expect(noPassword.database).toBeNull();
    const stopped = planAdoption(container({ running: false }), image());
    expect(stopped.databaseProblems.join(" ")).toMatch(/stopped/);
  });

  it("runs the exact image when its tag now names another build", () => {
    const p = planAdoption(container({ image: "shop/web:latest" }), { ...image(), Id: "sha256:" + "c".repeat(64) } as Docker.ImageInspectInfo);
    expect(p.image).toBe("sha256:" + "a".repeat(64));
    expect(p.notes.join(" ")).toMatch(/now points at another image/);
  });

  it("keeps a changed command as the full entrypoint, and published ports", () => {
    const p = planAdoption(
      container({ image: "node:22", cmd: ["node", "server.js"], ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3000" }] }, mounts: [] }),
      image({ Entrypoint: ["docker-entrypoint.sh"], Cmd: ["node"] }),
    );
    expect(p.entrypoint).toEqual(["docker-entrypoint.sh", "node", "server.js"]);
    expect(p.ports).toEqual([{ host: 3000, container: 3000, protocol: "tcp", bindAddress: "127.0.0.1" }]);
    expect(p.database).toBeNull();
  });

  it("refuses containers on the server's own network", () => {
    const c = container();
    c.HostConfig.NetworkMode = "host";
    expect(planAdoption(c, image()).blockers.length).toBe(1);
  });
});

describe("listening ports", () => {
  const proc = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 00000000:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000    70        0 1",
    "   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000    70        0 2",
    "   3: 0B00007F:A089 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4",
    "   2: 0B00A8C0:1538 0C00A8C0:D2F0 01 00000000:00000000 00:00000000 00000000    70        0 3",
  ].join("\n");
  it("reads ports in the listen state, not loopback ones or connections", () => {
    expect(listeningPorts(proc)).toEqual([5432]);
  });
  it("prefers the declared port, and drops a port nobody listens on", () => {
    expect(choosePort(5432, [5432, 9000], [5432])).toBe(5432);
    expect(choosePort(5432, [], [5432])).toBeNull();
    expect(choosePort(80, [8080], [80, 8080])).toBe(8080);
  });
});

describe("Redis and Valkey", () => {
  const redisImage = {
    Id: "sha256:" + "a".repeat(64),
    Config: { Env: ["PATH=/usr/bin"], Entrypoint: ["docker-entrypoint.sh"], Cmd: ["redis-server"] },
  } as unknown as Docker.ImageInspectInfo;
  const redis = (cmd: string[]) => {
    const c = container({ image: "redis:7-alpine", env: ["PATH=/usr/bin"], cmd, mounts: [{ Type: "volume", Name: "cache", Destination: "/data", RW: true }] });
    c.Config.ExposedPorts = { "6379/tcp": {} };
    return planAdoption(c, redisImage);
  };

  it("becomes a database when it runs with a password and the append-only file, extra flags kept", () => {
    const d = redis(["redis-server", "--requirepass", "pw-1", "--appendonly", "yes", "--maxmemory", "256mb"]).database!;
    expect(d).toMatchObject({ engine: "redis", password: "pw-1", username: "default", dataVolume: "cache", dataMountPath: "/data", extraArgs: "--maxmemory 256mb" });
  });

  it("stays a container without a password, without the append-only file, or with a config file", () => {
    expect(redis(["redis-server", "--appendonly", "yes"]).databaseProblems.join(" ")).toMatch(/no password/);
    expect(redis(["redis-server", "--requirepass", "pw"]).databaseProblems.join(" ")).toMatch(/append-only/);
    expect(redis(["redis-server", "/etc/redis.conf"]).databaseProblems.join(" ")).toMatch(/file/);
  });
});

describe("repository labels", () => {
  it("never keeps a login in the URL, and reads ssh addresses as web ones", async () => {
    const { repoUrlWithoutLogin } = await import("@/lib/repo-url");
    expect(repoUrlWithoutLogin("https://x-access-token:ghp_secret@github.com/acme/web.git")).toBe("https://github.com/acme/web");
    expect(repoUrlWithoutLogin("git@github.com:acme/web.git")).toBe("https://github.com/acme/web");
    expect(repoUrlWithoutLogin("ssh://git@git.example.com:2222/acme/web.git")).toBe("https://git.example.com/acme/web");
    expect(repoUrlWithoutLogin("/srv/repo")).toBeNull();
  });
});
