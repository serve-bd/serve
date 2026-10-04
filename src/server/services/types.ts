/** A webhook Serve registered on the repository through the provider API. */
export type RepoWebhook = {
  provider: "github" | "gitlab" | "gitea" | "bitbucket";
  /** Remote hook id (Bitbucket: uuid). Null when registration failed or was skipped. */
  id: string | null;
  url: string | null;
  createdAt: string;
  error?: string | null;
};

export type GitSource = {
  type: "git";
  /** https or ssh clone URL. */
  repository: string;
  branch: string;
  credentialId?: string | null;
  webhook?: RepoWebhook | null;
};

export type ImageSource = {
  type: "image";
  /** Full image reference, e.g. ghcr.io/org/app:latest */
  image: string;
  /** A saved registry of the organization whose login pulls the image (instead of the fields below). */
  registryId?: string | null;
  registryUsername?: string | null;
  /** Encrypted registry password / token. */
  registryPassword?: string | null;
};

/** A Dockerfile saved in Serve, built without a repository (its build context holds nothing else). */
export type DockerfileSource = {
  type: "dockerfile";
  content: string;
};

export type SourceConfig = GitSource | ImageSource | DockerfileSource;

export type SourceType = SourceConfig["type"];

/** Largest Dockerfile Serve stores for a Dockerfile source. */
export const DOCKERFILE_MAX_BYTES = 64 * 1024;

/** Sources Serve builds an image from (build servers, registries and the build cache apply). */
export function buildsImage(type: SourceType | null | undefined): boolean {
  return type === "git" || type === "dockerfile";
}

/**
 * Where an app is built and where it runs. Null (or all defaults) keeps the
 * classic behaviour: build and run on the service's own server.
 */
export type DistributionConfig = {
  /** Server that builds the image; null builds on the service's server. */
  buildServerId?: string | null;
  /** Registry the built image is pushed to; required to run a built image on another server. */
  registryId?: string | null;
  /** Repository inside the registry, e.g. "acme/web" (the registry host is added). */
  repository?: string | null;
  /** Tag pattern: {commit}, {short}, {deployment}, {branch}, {service}, {date}. */
  tag?: string | null;
  /** Also move the "latest" tag to each new image. */
  tagLatest?: boolean;
  /** More servers that run the same image, next to the service's server. */
  extraServerIds?: string[];
};

/** Per-server result of a deployment that runs on several servers. */
export type DeploymentTarget = {
  serverId: string;
  name: string;
  primary: boolean;
  status: "pending" | "deploying" | "success" | "failed" | "skipped";
  error?: string | null;
};

export type Builder = "auto" | "dockerfile" | "nixpacks" | "railpack" | "buildpacks" | "static";

export type BuildConfig = {
  builder: Builder;
  /** Directory inside the repository used as build context. */
  rootDir: string;
  /** Dockerfile path relative to rootDir. */
  dockerfile: string;
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  /** Output directory for static sites. */
  publishDir?: string | null;
  /** Docker build target stage. */
  target?: string | null;
  /** The builder image Cloud Native Buildpacks build with (default heroku/builder:24). */
  buildpacksBuilder?: string | null;
  /** Extra --build-arg values (not secret: use build-time variables for secrets). */
  buildArgs?: KeyValue[];
  /** Always build without the layer cache and pull fresh base images. */
  noCache?: boolean;
  /** Build the next deployment without cache once, then clear this flag. */
  noCacheOnce?: boolean;
  /** Abort builds that take longer (minutes). */
  buildTimeoutMinutes?: number | null;
  /** Clone Git submodules (default true). */
  submodules?: boolean;
  /** Only auto-deploy pushes that change a matching path (globs). Empty deploys every push. */
  watchPaths?: string[];
};

export type KeyValue = { key: string; value: string };

export type VolumeMount = {
  /**
   * volume: a named Docker volume managed by Serve (source is its short name).
   * bind: an existing file or directory on the server (source is an absolute path).
   * file: a file whose content Serve stores and writes to the server (source is its file name).
   */
  source: string;
  mountPath: string;
  kind: "volume" | "bind" | "file";
  readOnly?: boolean;
  /** file mounts: the file content. */
  content?: string;
  /** bind mounts: what the host path is, and whether Serve creates a missing directory. */
  hostType?: "file" | "directory";
  create?: boolean;
  /**
   * volume mounts: a volume made outside Serve (a container moved into a project keeps its data
   * there). The source is the volume's own name; Serve never deletes it.
   */
  external?: boolean;
};

/** A Docker network made outside Serve that the container also joins, and the names it answers to there. */
export type OutsideNetwork = { name: string; aliases: string[] };

/** "127.0.0.1" publishes only on the server itself (e.g. localhost:3000 on a dev machine). */
export type BindAddress = "0.0.0.0" | "127.0.0.1";

export type PortMapping = {
  host: number;
  container: number;
  protocol: "tcp" | "udp";
  /** Host interface to publish on; undefined means every interface. */
  bindAddress?: BindAddress;
};

export type RestartPolicy = "always" | "unless-stopped" | "on-failure" | "no";

export type RuntimeConfig = {
  /** Port the app listens on inside the container. */
  port: number | null;
  /** false: no port stays no port (a moved container that listens on none), not the image's EXPOSE. */
  detectPort?: boolean;
  replicas: number;
  command?: string | null;
  healthcheckPath?: string | null;
  healthcheckTimeout?: number | null;
  restartPolicy: RestartPolicy;
  /**
   * With "always" or "unless-stopped": a replica that crashes this many times in a row is stopped
   * until the next deploy or start. Null: never stopped. Unset: DEFAULT_CRASH_LIMIT.
   */
  crashLimit?: number | null;
  /** CPU cores limit, e.g. 0.5 */
  cpuLimit?: number | null;
  /** Memory limit in MB. */
  memoryLimit?: number | null;
  volumes: VolumeMount[];
  ports: PortMapping[];

  /* Deploy */
  /** One-off command run from the new image before traffic switches, e.g. migrations. */
  preDeployCommand?: string | null;
  /** Command run in the new version's first container once it is live, e.g. cache warm-up. */
  postDeployCommand?: string | null;
  /** rolling: start new, then stop old (zero downtime). recreate: stop old first. */
  deployStrategy?: "rolling" | "recreate";
  /** Seconds old containers keep serving in-flight requests after the switch. */
  drainSeconds?: number | null;
  /** Cron expression for scheduled restarts. */
  restartSchedule?: string | null;

  /* Health check (deploy-time, run by Serve) */
  /** Port to probe; defaults to the app port. */
  healthcheckPort?: number | null;
  /** Seconds between probes. */
  healthcheckInterval?: number | null;
  /** Seconds to wait before the first probe. */
  healthcheckStartPeriod?: number | null;
  /** Accepted HTTP status range, e.g. "200-399". */
  healthcheckStatus?: string | null;
  /** Consecutive successful probes needed. */
  healthcheckSuccesses?: number | null;

  /* Container */
  workingDir?: string | null;
  /** User to run as, e.g. "1000:1000" or "node". */
  user?: string | null;
  /** Seconds to wait after the stop signal before killing. */
  stopTimeout?: number | null;
  stopSignal?: "SIGTERM" | "SIGINT" | "SIGQUIT" | "SIGHUP" | "SIGUSR1" | "SIGUSR2" | null;
  /** Run a tiny init as PID 1 that reaps zombies and forwards signals (default true). */
  init?: boolean;
  /** /dev/shm size in MB. */
  shmSize?: number | null;
  /** "hostname:ip" entries added to /etc/hosts. */
  extraHosts?: string[];
  labels?: KeyValue[];
  /** Container log rotation. */
  logMaxSizeMb?: number | null;
  logMaxFiles?: number | null;
  /** Soft memory reservation in MB. */
  memoryReservation?: number | null;
  /** Root organization only. */
  privileged?: boolean;
  capAdd?: string[];
  /** Replaces the image's entrypoint; unset or null keeps it. */
  entrypoint?: string[] | null;
  /** NVIDIA GPUs: "all" or a count. Root organization only. */
  gpus?: "all" | number | null;
  /** Host devices passed into the container. Root organization only. */
  devices?: DeviceMapping[];
  ulimits?: Ulimit[];
  /** Namespaced kernel parameters (net.*, kernel.shm*, kernel.msg*, kernel.sem, fs.mqueue.*). */
  sysctls?: Record<string, string>;
  /** DNS servers (IP addresses), search domains and resolver options like ndots:2. */
  dns?: string[];
  dnsSearch?: string[];
  dnsOptions?: string[];
  /** Image platform to pull or build; unset uses the server's own. */
  platform?: Platform | null;
  /** Image sources: pull on every deploy (default) or only when the server lacks the image. */
  pullPolicy?: "always" | "missing";
  /**
   * Networks made outside Serve that the containers join as well: a container moved into a project
   * keeps the names other containers there reach it by.
   */
  networks?: OutsideNetwork[];
};

export type Platform = "linux/amd64" | "linux/arm64" | "linux/arm/v7";

export type DeviceMapping = {
  /** Path on the server, under /dev. */
  host: string;
  /** Path in the container; defaults to the host path. */
  container?: string;
  permissions?: "rwm" | "r" | "rw";
};

export type Ulimit = { name: string; soft: number; hard: number };

export type DbEngine = "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" | "valkey" | "clickhouse";

/** Automatic backups of one database container in a compose stack. */
export type ComposeBackupConfig = {
  /** Cron expression; null keeps only manual backups. */
  schedule: string | null;
  retention: number;
  retentionS3?: number | null;
  s3DestinationId?: string | null;
  /** With a bucket: false keeps copies in the bucket only (not on the server). Default true. */
  local?: boolean;
};

export type ReplicaInstance = { id: string; serverId: string };

/**
 * Public access to a database's pooler or read replicas: a host port (on the database's server for
 * the pooler, on each replica's server for replicas), who may reach it, and a domain. Over the
 * public port they speak TLS only. The pooler can take its domain through a Cloudflare Tunnel
 * instead (no port); replicas' domain leads to every replica server (one A record each).
 */
export type AddonAccess = {
  port: number | null;
  bind?: BindAddress;
  allow?: string[] | null;
  domain?: string | null;
  tunnelId?: string | null;
  /** Servers whose port did not answer from outside when last checked (a router or firewall in front): left out of the domain. */
  unreachable?: string[] | null;
};

/** Engines with read replicas: PostgreSQL, MySQL, MariaDB, MongoDB, Redis and Valkey. */
export const REPLICA_ENGINES: readonly DbEngine[] = ["postgres", "mysql", "mariadb", "mongodb", "redis", "valkey"];
export const replicasSupported = (engine: DbEngine | null | undefined) => !!engine && REPLICA_ENGINES.includes(engine);

/** The read replicas of a database service: none unless its engine has them and they are on. */
export function replicaInstances(s: { serverId: string; database?: DatabaseConfig | null }): ReplicaInstance[] {
  const r = s.database?.replica;
  if (!replicasSupported(s.database?.engine) || !r?.enabled) return [];
  return r.instances?.length ? r.instances : [{ id: "1", serverId: s.serverId }];
}

export const poolerEnabled = (s: { database?: DatabaseConfig | null }) => s.database?.engine === "postgres" && !!s.database.pooler?.enabled;

export type DatabaseConfig = {
  engine: DbEngine;
  version: string;
  username: string;
  /** Encrypted. */
  password: string;
  database: string;
  /** Publish the database on this host port when set. */
  publicPort?: number | null;
  /** Interface the public port binds to; undefined means every interface. */
  publicBind?: BindAddress;
  /**
   * Only these addresses or CIDR ranges may connect to the public port (the server's firewall
   * drops everyone else). Empty or missing: everyone.
   */
  publicAllow?: string[] | null;
  /**
   * A domain clients reach the database on (db.example.com): its public port, over TLS with a
   * certificate for the domain.
   */
  domain?: string | null;
  /**
   * Serve the domain through this Cloudflare Tunnel (TCP) instead of a public port: for servers
   * without a public IP. Clients run `cloudflared access tcp`. Works for every engine.
   */
  domainTunnelId?: string | null;
  /** What putting the database on its domain turned on, turned off again when the domain goes. */
  domainOpened?: { public?: boolean; publicBind?: BindAddress | null; tls?: boolean } | null;
  /** Cron expression for automatic backups. */
  backupSchedule?: string | null;
  /** Databases of the server each backup takes; null takes the main database only. */
  backupDatabases?: string[] | null;
  backupRetention: number;
  /** Clean-up SQL for branches made with "hide personal data": runs on the copy after each refill. */
  branchCleanupSql?: string | null;
  /** Backups kept in S3; defaults to backupRetention. */
  backupRetentionS3?: number | null;
  s3DestinationId?: string | null;
  /** With a bucket: false keeps backups in the bucket only (not on the server). Default true. */
  backupLocal?: boolean;

  /* Everything below is optional so older configs keep working. */
  description?: string | null;
  /** Full image reference that replaces engine image + version, e.g. pgvector/pgvector:pg17. */
  image?: string | null;
  /** Postgres: POSTGRES_INITDB_ARGS (first start only). */
  initdbArgs?: string | null;
  /** Postgres: POSTGRES_HOST_AUTH_METHOD (first start only). */
  hostAuthMethod?: "scram-sha-256" | "md5" | "trust" | null;
  /** MySQL / MariaDB server character set and collation. */
  charset?: string | null;
  collation?: string | null;
  /** Files run by the image on an empty data directory (/docker-entrypoint-initdb.d). */
  initScripts?: { name: string; content: string }[];
  /** Engine configuration: postgresql.conf lines, my.cnf, redis.conf, mongod.conf or ClickHouse XML. */
  customConfig?: string | null;
  /** Extra arguments appended to the server process. */
  extraArgs?: string | null;
  /** Where the data volume is mounted; defaults to the engine's data directory. */
  dataMountPath?: string | null;
  /**
   * The data lives in this volume (its own name) or host folder (an absolute path), made outside
   * Serve: a database moved into a project keeps its data. Unset: Serve's own volume.
   */
  dataVolume?: string | null;
  /** The data volume is Serve's (a database started from kept data): deleting with its volumes deletes it. */
  dataVolumeOwned?: boolean;
  /** PostgreSQL: the data directory (PGDATA) inside the mount, when it is not Serve's default. */
  pgdata?: string | null;
  /** TLS with a certificate authority Serve creates for this database. */
  tls?: { enabled: boolean; mode?: "prefer" | "require" } | null;
  /** Container health check timing (seconds). */
  healthcheck?: { interval?: number | null; timeout?: number | null; retries?: number | null; startPeriod?: number | null } | null;
  /** PostgreSQL: a PgBouncer in front, at <host>-pooler. `password` (encrypted) is its lookup login's. */
  pooler?: { enabled: boolean; mode: "transaction" | "session"; poolSize: number; maxClients: number; password?: string | null; public?: AddonAccess | null } | null;
  /**
   * Read-only copies that follow the database (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey),
   * each at <host>-replica-<id> on its server (the database's or one linked to it privately);
   * <host>-replica spreads reads over them all. `password` (encrypted) is the replication login's
   * (MongoDB: the replica set's key). No `instances`: one, on the database's server.
   */
  replica?: {
    enabled: boolean;
    password?: string | null;
    instances?: ReplicaInstance[];
    public?: AddonAccess | null;
    /**
     * MariaDB and MongoDB: the database runs ready for replicas (a binary log; a replica set), which
     * only a restart turns on. It stays on once set, so turning replicas off and on does not restart it.
     */
    primed?: boolean;
  } | null;
};

/** Whether a runtime has host-level access: host paths, host ports, privileges or hardware. */
export function hasHostAccess(r: RuntimeConfig) {
  return (
    r.volumes.some((v) => v.kind === "bind" || v.external) || !!r.networks?.length || r.ports.length > 0 || !!r.privileged || !!r.capAdd?.length || !!r.gpus || !!r.devices?.length
  );
}

/**
 * A runtime for a copy (another environment, a preview): volumes and networks made outside Serve
 * stay with the original. Two containers on one data directory corrupt it.
 */
export function withoutOutsideResources(r: RuntimeConfig): RuntimeConfig {
  return { ...r, volumes: r.volumes.filter((v) => !v.external), networks: [] };
}

/** A runtime without host-level access, for copies made by someone who may not grant it. */
export function withoutHostAccess(r: RuntimeConfig): RuntimeConfig {
  return { ...withoutOutsideResources(r), ports: [], volumes: r.volumes.filter((v) => v.kind !== "bind" && !v.external), privileged: false, capAdd: [], gpus: null, devices: [] };
}

/** Whether a service keeps data or names outside Serve (it was moved in): such a service stays on its server. */
export function usesOutsideResources(s: { runtime: RuntimeConfig; database?: DatabaseConfig | null }) {
  return !!s.database?.dataVolume || s.runtime.volumes.some((v) => v.external) || !!s.runtime.networks?.length;
}

export type ComposeConfig = {
  /** Inline YAML, or the path of the compose file inside the git repository. */
  mode: "inline" | "git";
  content: string;
  path: string;
  /** Template id when created from a one-click template. */
  template?: string | null;
  /** Private /24 subnet Serve assigned to the stack's default network. */
  subnet?: string | null;
  /** Host ports Serve publishes for services of the stack, on top of the compose file's own. */
  ports?: ComposePort[];
  /**
   * Keep the stack to itself: its services reach only each other, not the other services
   * of the environment. The proxy still reaches it through the stack's own network.
   */
  isolated?: boolean;
  /**
   * Set up (file, repository or branch) by an admin of the Root organization: its host-level
   * options may deploy. Any change by someone else clears it.
   */
  hostAccess?: boolean;
  /** The host-level options a Root admin approved by deploying them, so a push cannot add more. */
  hostAccessIssues?: string[];
};

export type ComposePort = PortMapping & { service: string };

/** Maintenance mode: the proxy answers every domain of the service with a 503 page. */
export type MaintenanceConfig = {
  enabled: boolean;
  title: string;
  message: string;
  /** IPs or CIDR ranges that still reach the app. */
  allow: string[];
  /** Retry-After header, in minutes. */
  retryAfterMinutes: number;
  /** When maintenance was last turned on (ISO). */
  since?: string | null;
};

/** Pull request previews get their own copy of a database of the environment. */
export type PreviewDatabaseConfig = {
  /** Database service copied for each preview. */
  sourceServiceId: string;
  /** Variable of the preview that receives the copy's connection URL. */
  variable: string;
  /** SQL run on the copy after the restore, e.g. to replace personal data. */
  scrubSql?: string | null;
  /**
   * "service" (default): a temporary database service per preview. "branch": a branch inside the
   * source database's own container (PostgreSQL only).
   */
  mode?: "service" | "branch";
};

/** Crashes in a row after which a replica is stopped, unless the app sets its own limit. */
export const DEFAULT_CRASH_LIMIT = 10;

/** The crash limit an app runs with, or null when its replicas are never stopped for crashing. */
export function crashLimitOf(runtime: Pick<RuntimeConfig, "restartPolicy" | "crashLimit">): number | null {
  // Docker gives up by itself with "on-failure" (5 tries) and never restarts with "no".
  if (runtime.restartPolicy !== "always" && runtime.restartPolicy !== "unless-stopped") return null;
  return runtime.crashLimit === undefined ? DEFAULT_CRASH_LIMIT : runtime.crashLimit;
}

export const defaultRuntime = (port: number | null = null): RuntimeConfig => ({
  port,
  replicas: 1,
  command: null,
  healthcheckPath: null,
  restartPolicy: "unless-stopped",
  cpuLimit: null,
  memoryLimit: null,
  volumes: [],
  ports: [],
});

export const defaultBuild = (): BuildConfig => ({
  builder: "auto",
  rootDir: "/",
  dockerfile: "Dockerfile",
  installCommand: null,
  buildCommand: null,
  startCommand: null,
  publishDir: null,
  target: null,
});
