export type GitSource = {
  type: "git";
  /** https or ssh clone URL. */
  repository: string;
  branch: string;
  credentialId?: string | null;
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
  /** Named volume (managed by Serve) or absolute host path. */
  source: string;
  mountPath: string;
  kind: "volume" | "bind";
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

export type DbEngine =
  | "postgres"
  | "mysql"
  | "mariadb"
  | "mongodb"
  | "redis"
  | "valkey"
  | "clickhouse";

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
  s3DestinationId?: string | null;
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
};

export type ComposePort = PortMapping & { service: string };

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
