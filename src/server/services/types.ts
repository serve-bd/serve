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
};

export type VolumeMount = {
  /** Named volume (managed by Serve) or absolute host path. */
  source: string;
  mountPath: string;
  kind: "volume" | "bind";
};

export type PortMapping = {
  host: number;
  container: number;
  protocol: "tcp" | "udp";
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
