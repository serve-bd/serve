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
  registryUsername?: string | null;
  /** Encrypted registry password / token. */
  registryPassword?: string | null;
};

export type SourceConfig = GitSource | ImageSource;

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

export type Builder = "auto" | "dockerfile" | "nixpacks" | "static";

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
};

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
  replicas: number;
  command?: string | null;
  healthcheckPath?: string | null;
  healthcheckTimeout?: number | null;
  restartPolicy: RestartPolicy;
  /** CPU cores limit, e.g. 0.5 */
  cpuLimit?: number | null;
  /** Memory limit in MB. */
  memoryLimit?: number | null;
  volumes: VolumeMount[];
  ports: PortMapping[];

  /* Deploy */
  /** One-off command run from the new image before traffic switches, e.g. migrations. */
  preDeployCommand?: string | null;
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
};

export type DbEngine = "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" | "valkey" | "clickhouse";

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
  /** Cron expression for automatic backups. */
  backupSchedule?: string | null;
  backupRetention: number;
  /** Backups kept in S3; defaults to backupRetention. */
  backupRetentionS3?: number | null;
  s3DestinationId?: string | null;

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
  /** TLS with a certificate authority Serve creates for this database. */
  tls?: { enabled: boolean; mode?: "prefer" | "require" } | null;
  /** Container health check timing (seconds). */
  healthcheck?: { interval?: number | null; timeout?: number | null; retries?: number | null; startPeriod?: number | null } | null;
};

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
};

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
