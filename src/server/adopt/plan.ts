import type Docker from "dockerode";
import { HOSTNAME_RE } from "@/lib/hostname";
import { engines } from "@/server/databases/engines";
import type { DbEngine, KeyValue, OutsideNetwork, PortMapping, RestartPolicy, VolumeMount } from "@/server/services/types";

/**
 * How a container made outside Serve becomes a service: everything that makes it run as it does
 * (image, variables, command, mounts, ports, networks and the names it answers to) is kept.
 */
export type AdoptPlan = {
  container: { id: string; name: string; running: boolean };
  /** The exact image: its tag while that still points at what the container runs, else its id. */
  image: string;
  imageLabel: string;
  /** Variables set for this container (not the image's own defaults). */
  env: KeyValue[];
  /** Entrypoint and command, when they differ from the image's. */
  entrypoint: string[] | null;
  workingDir: string | null;
  user: string | null;
  init: boolean;
  port: number | null;
  /** TCP ports the image declares. */
  exposed: number[];
  volumes: VolumeMount[];
  ports: PortMapping[];
  restartPolicy: RestartPolicy;
  networks: OutsideNetwork[];
  /** The private name the service answers to in its project: the container's name. */
  hostname: string | null;
  memoryLimit: number | null;
  cpuLimit: number | null;
  shmSize: number | null;
  privileged: boolean;
  capAdd: string[];
  extraHosts: string[];
  /** Settings Serve does not carry over, for the person to check. */
  notes: string[];
  /** Why it cannot be moved at all. */
  blockers: string[];
  /** It can become a database service of Serve (backups, Data tab, users) when this is set. */
  database: DatabasePlan | null;
  /** Why it moves as a plain container rather than a database, when it looks like one. */
  databaseProblems: string[];
};

export type DatabasePlan = {
  engine: DbEngine;
  version: string;
  username: string;
  password: string;
  database: string;
  /** Volume name or host path holding the data, and where it is mounted. */
  dataVolume: string;
  dataMountPath: string;
  pgdata: string | null;
  extraArgs: string | null;
  publicPort: number | null;
  publicBind: "0.0.0.0" | "127.0.0.1" | undefined;
  /** Mounts other than the data. */
  volumes: VolumeMount[];
  /** Variables a database service of Serve does not keep. */
  droppedEnv: string[];
};

const SHA = /^sha256:[a-f0-9]{64}$/;
const SHORT_ID = /^[a-f0-9]{12,64}$/;

const envMap = (list: string[] | undefined | null) => {
  const out = new Map<string, string>();
  for (const e of list ?? []) {
    const i = e.indexOf("=");
    if (i > 0) out.set(e.slice(0, i), e.slice(i + 1));
  }
  return out;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const restartOf = (name: string | undefined): RestartPolicy =>
  name === "always" || name === "unless-stopped" || name === "on-failure" ? name : name === "no" || name === "" || !name ? "no" : "unless-stopped";

/** Engines Serve can run as a database service from data made elsewhere. */
const ADOPTABLE: DbEngine[] = ["postgres", "mysql", "mariadb", "mongodb"];

export function detectEngine(image: string): DbEngine | null {
  for (const e of Object.values(engines)) if (e.imagePattern.test(image)) return e.engine;
  return null;
}

export function planAdoption(info: Docker.ContainerInspectInfo, image: Docker.ImageInspectInfo | null): AdoptPlan {
  const name = info.Name.replace(/^\//, "");
  const cfg = info.Config;
  const host = info.HostConfig;
  const notes: string[] = [];
  const blockers: string[] = [];

  const tag = cfg.Image && !SHA.test(cfg.Image) && !SHORT_ID.test(cfg.Image) ? cfg.Image : null;
  // A tag rebuilt since the container started now names other code: the container's own image is used.
  const tagCurrent = !!tag && !!image && image.Id === info.Image;
  const imageRef = tagCurrent ? tag! : info.Image;
  if (tag && !tagCurrent) notes.push(`The tag ${tag} now points at another image. Serve runs the exact image the container runs (${info.Image.slice(7, 19)}).`);

  const own = envMap(cfg.Env);
  const base = envMap(image?.Config?.Env);
  const env: KeyValue[] = [...own].filter(([k, v]) => base.get(k) !== v).map(([key, value]) => ({ key, value }));

  const argv = [...(cfg.Entrypoint ?? []), ...(cfg.Cmd ?? [])];
  const imageArgv = [...(image?.Config?.Entrypoint ?? []), ...(image?.Config?.Cmd ?? [])];
  // Set as the entrypoint, the full command runs as is (no shell around it), with the image's command off.
  const entrypoint = argv.length && (!image || !same(argv, imageArgv)) ? argv : null;

  const mode = host.NetworkMode ?? "";
  if (mode === "host" || mode.startsWith("container:"))
    blockers.push(`It uses ${mode === "host" ? "the server's own network" : "another container's network"}. Serve gives each service its own place on its project network.`);

  const volumes: VolumeMount[] = [];
  for (const m of info.Mounts ?? []) {
    const readOnly = m.RW === false ? true : undefined;
    if (m.Type === "volume" && m.Name) volumes.push({ kind: "volume", source: m.Name, mountPath: m.Destination, external: true, readOnly });
    else if (m.Type === "bind") volumes.push({ kind: "bind", source: m.Source, mountPath: m.Destination, readOnly });
    else notes.push(`${m.Type} mount at ${m.Destination} is left out.`);
  }
  for (const t of Object.keys(host.Tmpfs ?? {})) notes.push(`tmpfs at ${t} is left out.`);

  const ports: PortMapping[] = [];
  for (const [key, binds] of Object.entries(host.PortBindings ?? {})) {
    const [p, proto] = key.split("/");
    for (const b of (binds as { HostIp?: string; HostPort?: string }[] | null) ?? []) {
      const hostPort = Number(b.HostPort);
      if (!hostPort) {
        notes.push(`Port ${key} is published on a random host port; Serve leaves it out.`);
        continue;
      }
      const ip = b.HostIp ?? "";
      const bindAddress = ip === "127.0.0.1" ? "127.0.0.1" : ip === "" || ip === "0.0.0.0" || ip === "::" ? undefined : null;
      if (bindAddress === null) notes.push(`Port ${hostPort} was published on ${ip} only; Serve publishes it on every interface.`);
      if (!ports.some((x) => x.host === hostPort && x.protocol === proto))
        ports.push({ host: hostPort, container: Number(p), protocol: proto === "udp" ? "udp" : "tcp", ...(bindAddress ? { bindAddress } : {}) });
    }
  }

  const exposed = Object.keys(cfg.ExposedPorts ?? {})
    .filter((k) => k.endsWith("/tcp"))
    .map((k) => Number(k.split("/")[0]))
    .sort((a, b) => a - b);

  const networks: OutsideNetwork[] = [];
  for (const [net, ep] of Object.entries(info.NetworkSettings?.Networks ?? {})) {
    if (["bridge", "host", "none"].includes(net)) continue;
    const names = [...(ep.Aliases ?? []), ...(((ep as { DNSNames?: string[] }).DNSNames ?? []) as string[]), name];
    const aliases = [...new Set(names.filter((a) => a && !SHORT_ID.test(a) && a !== info.Id.slice(0, 12)))];
    networks.push({ name: net, aliases });
  }
  if (!networks.length && mode !== "host") notes.push("It is on Docker's default network only: containers there reached it by IP address, which changes.");

  const hostname = HOSTNAME_RE.test(name.toLowerCase()) ? name.toLowerCase() : null;
  if (!hostname) notes.push(`${name} is not a valid private name; the service answers to its own name only.`);

  if (cfg.Healthcheck?.Test?.length && !same(cfg.Healthcheck, image?.Config?.Healthcheck))
    notes.push("Its own health check is left out; the image's health check, if any, still runs.");
  if (host.Devices?.length) notes.push("Host devices are left out.");
  if (host.Sysctls && Object.keys(host.Sysctls).length) notes.push("Kernel settings (sysctls) are left out.");
  if (host.SecurityOpt?.length) notes.push("Security options are left out.");
  const labels = Object.keys(cfg.Labels ?? {}).filter((l) => /traefik|caddy/i.test(l));
  if (labels.length) notes.push("Proxy labels are left out: add its domains in Serve after the move.");

  const plan: AdoptPlan = {
    container: { id: info.Id, name, running: !!info.State?.Running },
    image: imageRef,
    imageLabel: tag ?? info.Image.slice(7, 19),
    env,
    entrypoint,
    workingDir: cfg.WorkingDir && cfg.WorkingDir !== (image?.Config?.WorkingDir ?? "") ? cfg.WorkingDir : null,
    user: cfg.User && cfg.User !== (image?.Config?.User ?? "") ? cfg.User : null,
    init: !!host.Init,
    port: exposed[0] ?? null,
    exposed,
    volumes,
    ports,
    restartPolicy: restartOf(host.RestartPolicy?.Name),
    networks,
    hostname,
    memoryLimit: host.Memory ? Math.max(16, Math.round(host.Memory / 1024 / 1024)) : null,
    cpuLimit: host.NanoCpus ? host.NanoCpus / 1e9 : null,
    shmSize: host.ShmSize && host.ShmSize !== 64 * 1024 * 1024 ? Math.round(host.ShmSize / 1024 / 1024) : null,
    privileged: !!host.Privileged,
    capAdd: host.CapAdd ?? [],
    extraHosts: ((host.ExtraHosts ?? []) as string[]).filter((h) => !h.startsWith("host.docker.internal:")),
    notes,
    blockers,
    database: null,
    databaseProblems: [],
  };
  const engine = detectEngine(tag ?? cfg.Image ?? "");
  if (engine) Object.assign(plan, databasePlanFor(plan, engine, own, image));
  return plan;
}

function databasePlanFor(plan: AdoptPlan, engine: DbEngine, env: Map<string, string>, image: Docker.ImageInspectInfo | null): Pick<AdoptPlan, "database" | "databaseProblems"> {
  const info = engines[engine];
  const problems: string[] = [];
  if (!ADOPTABLE.includes(engine)) return { database: null, databaseProblems: [`Serve keeps the start command and password of ${info.label} as they are.`] };
  if (!plan.container.running) problems.push("It is stopped: Serve signs in to a running database to check its password.");

  const get = (...keys: string[]) => keys.map((k) => env.get(k)).find((v) => v !== undefined && v !== "");
  const fileVar = [...env.keys()].find((k) => /_PASSWORD_FILE$/.test(k));
  if (fileVar) problems.push(`Its password is read from a file (${fileVar}).`);

  let username = "";
  let password = "";
  let database = "";
  let pgdata: string | null = null;
  if (engine === "postgres") {
    username = get("POSTGRES_USER") ?? "postgres";
    password = get("POSTGRES_PASSWORD") ?? "";
    database = get("POSTGRES_DB") ?? username;
    pgdata = get("PGDATA") ?? "/var/lib/postgresql/data";
  } else if (engine === "mysql" || engine === "mariadb") {
    // Serve signs in as root for backups and the Data tab.
    password = get("MARIADB_ROOT_PASSWORD", "MYSQL_ROOT_PASSWORD") ?? "";
    const appUser = get("MARIADB_USER", "MYSQL_USER");
    const appPassword = get("MARIADB_PASSWORD", "MYSQL_PASSWORD");
    username = appUser && appPassword === password ? appUser : "root";
    database = get("MARIADB_DATABASE", "MYSQL_DATABASE") ?? "";
    if (!database) problems.push("No database name is set (MYSQL_DATABASE).");
  } else if (engine === "mongodb") {
    username = get("MONGO_INITDB_ROOT_USERNAME") ?? "";
    password = get("MONGO_INITDB_ROOT_PASSWORD") ?? "";
    database = get("MONGO_INITDB_DATABASE") ?? "admin";
    if (!username) problems.push("It has no root user (MONGO_INITDB_ROOT_USERNAME).");
  }
  if (!password && !fileVar) problems.push("No password is set in its variables.");

  // The data mount: the one holding the data directory.
  const dataDir = pgdata ?? info.dataPath;
  const under = (dir: string, mount: string) => dir === mount || dir.startsWith(mount.replace(/\/+$/, "") + "/");
  const data = plan.volumes.filter((v) => v.kind !== "file" && under(dataDir, v.mountPath)).sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
  if (!data) problems.push(`No volume holds its data directory (${dataDir}); its data would not move.`);

  // The image's own server command with extra flags is kept as extra arguments; anything else is not.
  let extraArgs: string | null = null;
  const imageArgv = [...(image?.Config?.Entrypoint ?? []), ...(image?.Config?.Cmd ?? [])];
  if (plan.entrypoint) {
    const server = info.server?.[0];
    const cmd = plan.entrypoint;
    const i = server ? cmd.indexOf(server) : -1;
    const prefix = cmd.slice(0, Math.max(i, 0));
    const imagePrefix = imageArgv.slice(0, Math.max(imageArgv.indexOf(server ?? ""), 0));
    if (i >= 0 && same(prefix, imagePrefix))
      extraArgs =
        cmd
          .slice(i + 1)
          .map(shellQuote)
          .join(" ") || null;
    else problems.push(`It starts with its own command (${cmd.join(" ").slice(0, 80)}).`);
  }

  const enginePorts = plan.ports.filter((p) => p.container === info.port && p.protocol === "tcp");
  if (plan.ports.length > enginePorts.length || enginePorts.length > 1) problems.push("It publishes ports other than its database port.");

  const known = new Set([
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "PGDATA",
    "POSTGRES_INITDB_ARGS",
    "POSTGRES_HOST_AUTH_METHOD",
    "MYSQL_ROOT_PASSWORD",
    "MYSQL_USER",
    "MYSQL_PASSWORD",
    "MYSQL_DATABASE",
    "MARIADB_ROOT_PASSWORD",
    "MARIADB_USER",
    "MARIADB_PASSWORD",
    "MARIADB_DATABASE",
    "MONGO_INITDB_ROOT_USERNAME",
    "MONGO_INITDB_ROOT_PASSWORD",
    "MONGO_INITDB_DATABASE",
  ]);
  const droppedEnv = plan.env.map((e) => e.key).filter((k) => !known.has(k));
  if (problems.length || !data) return { database: null, databaseProblems: problems };

  const tag = plan.imageLabel.includes(":") ? plan.imageLabel.slice(plan.imageLabel.lastIndexOf(":") + 1) : "latest";
  return {
    database: {
      engine,
      version: tag,
      username,
      password,
      database,
      dataVolume: data.source,
      dataMountPath: data.mountPath,
      pgdata,
      extraArgs,
      publicPort: enginePorts[0]?.host ?? null,
      publicBind: enginePorts[0]?.bindAddress,
      volumes: plan.volumes.filter((v) => v !== data),
      droppedEnv,
    },
    databaseProblems: [],
  };
}

/** TCP ports a container listens on, from /proc/net/tcp and tcp6 (state 0A), loopback-only ones left out. */
export function listeningPorts(procNetTcp: string): number[] {
  const out = new Set<number>();
  for (const line of procNetTcp.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[3] !== "0A" || !f[1]?.includes(":")) continue;
    const [addr, port] = f[1].split(":");
    // Loopback (127.x, ::1, ::ffff:127.x) cannot be reached from other containers; Docker's own DNS
    // listens on 127.0.0.11 in every container on a user network.
    const v4 = addr.length === 8 ? addr : addr.length === 32 && addr.startsWith("0000000000000000FFFF0000") ? addr.slice(24) : null;
    if (v4?.endsWith("7F") || addr === "00000000000000000000000001000000") continue;
    out.add(Number.parseInt(port, 16));
  }
  return [...out].sort((a, b) => a - b);
}

/** The port the app serves on: one it listens on, preferring those its image declares. */
export function choosePort(exposed: number | null, listening: number[], declared: number[]): number | null {
  if (exposed && listening.includes(exposed)) return exposed;
  return declared.find((p) => listening.includes(p)) ?? listening[0] ?? null;
}

const shellQuote = (a: string) => (/^[\w./:=,@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'"'"'`)}'`);
