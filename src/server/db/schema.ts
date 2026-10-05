import { type AnyPgColumn, bigint, bigserial, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type {
  BuildConfig,
  ComposeBackupConfig,
  ComposeConfig,
  DatabaseConfig,
  DbEngine,
  DeploymentTarget,
  BalanceState,
  RequestLogConfig,
  DistributionConfig,
  MaintenanceConfig,
  PreviewDatabaseConfig,
  RuntimeConfig,
  SourceConfig,
} from "@/server/services/types";
import type { ServiceProxyConfig } from "@/server/services/proxy-config";
import type { ProxyKind, RunningKind, ProxySwitchState, ServerProxyConfig } from "@/server/proxy/config";
import type { ChannelScope, MessageTemplate, NotificationKind, QuietHours, Severity } from "@/lib/notifications";
import type { OrgLimits } from "@/lib/limits";
import type { TrustedProxies } from "@/lib/trusted-proxies";
import type { DashboardLayout } from "@/lib/dashboard";
import type { IncidentImpact, IncidentState, NoticeKind, StatusDesign, StatusImage, StatusVisibility } from "@/lib/status-page";
import type { SecretProviderAccess, SecretProviderConfig, SecretProviderKind } from "@/lib/secret-providers";

const id = () => text("id").primaryKey();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/* -------------------------------------------------------------------------- */
/*                                    Auth                                    */
/* -------------------------------------------------------------------------- */

export const user = pgTable("user", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** WebAuthn passkeys a user signs in with (better-auth passkey plugin). */
export const passkey = pgTable(
  "passkey",
  {
    id: id(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    aaguid: text("aaguid"),
    createdAt: timestamp("created_at", { withTimezone: true }),
  },
  (t) => [index("passkey_user_idx").on(t.userId), uniqueIndex("passkey_credential_idx").on(t.credentialID)],
);

export const twoFactor = pgTable(
  "two_factor",
  {
    id: id(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [index("two_factor_user_idx").on(t.userId), index("two_factor_secret_idx").on(t.secret)],
);

export const session = pgTable(
  "session",
  {
    id: id(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    activeOrganizationId: text("active_organization_id"),
    activeTeamId: text("active_team_id"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: id(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: id(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* -------------------------------------------------------------------------- */
/*                               Organizations                                */
/* -------------------------------------------------------------------------- */

export type MemberRole = "owner" | "admin" | "member";

export const organization = pgTable("organization", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: createdAt(),
});

export const member = pgTable(
  "member",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").$type<MemberRole>().notNull(),
    /** Role that decides permissions: "developer", "viewer" or a custom org_role id. Null derives it from `role`. */
    roleId: text("role_id"),
    /** Projects the member can reach. Null means every project. */
    projectIds: text("project_ids").array(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("member_org_user_idx").on(t.organizationId, t.userId), index("member_user_idx").on(t.userId)],
);

export const invitation = pgTable(
  "invitation",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").$type<MemberRole>(),
    /** Role given on acceptance ("developer", "viewer" or a custom role id). */
    roleId: text("role_id"),
    teamId: text("team_id"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [index("invitation_org_idx").on(t.organizationId)],
);

const orgRef = () =>
  text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });

/**
 * Roles of an organization. A row with `builtin` set overrides that built-in role's
 * permissions (only Developer is adjustable); the others are custom roles.
 */
export const orgRole = pgTable(
  "org_role",
  {
    id: id(),
    organizationId: orgRef(),
    builtin: text("builtin"),
    name: text("name").notNull(),
    description: text("description"),
    permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("org_role_org_idx").on(t.organizationId), uniqueIndex("org_role_builtin_idx").on(t.organizationId, t.builtin)],
);

/* -------------------------------------------------------------------------- */
/*                                  Settings                                  */
/* -------------------------------------------------------------------------- */

/** Key/value store for instance-wide settings. */
/* -------------------------------------------------------------------------- */
/*                                   Servers                                  */
/* -------------------------------------------------------------------------- */

/** SSH keys Serve uses to reach remote servers. Instance keys (no organization) are managed by Root admins. */
export const privateKey = pgTable("private_key", {
  id: id(),
  /** Organization that owns the key; its admins manage it and only its servers use it. Null: the instance's (also after the organization is deleted, with its servers). */
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  /** OpenSSH public key line. */
  publicKey: text("public_key").notNull(),
  /** Encrypted OpenSSH private key. */
  privateKey: text("private_key").notNull(),
  fingerprint: text("fingerprint").notNull(),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type ServerStatus = "pending" | "validating" | "ready" | "unreachable" | "error";

/**
 * A server without a public address that connects out: it keeps an SSH reverse tunnel open to
 * Serve's tunnel listener, and Serve reaches its sshd through a local relay port.
 */
export type ServerTunnel = {
  /** Port of the relay (on the worker) that leads to the server's sshd while it is connected. */
  relayPort: number;
  /** Public key the server's tunnel client signs in with; null until it has joined. */
  clientKey: string | null;
  /** sha256 of the one-time join token, and when it stops working. */
  tokenHash: string | null;
  tokenExpiresAt: string | null;
  /** Address and port of the tunnel listener the server connects to. */
  address: string;
  port: number;
  /** While connected: since when, and from where. */
  connectedAt: string | null;
  remote: string | null;
};

/**
 * A server in a Tailscale tailnet (Integrations → Tailscale). While it uses the tailnet, Serve
 * reaches its SSH at the Tailscale address instead of its host or its tunnel.
 */
export type ServerTailscale = {
  /** The connected tailnet; null once that integration was removed. */
  tailnetId: string | null;
  /** Host name it gets in the tailnet (serve-<name>, with a number when that one is taken). */
  hostname: string;
  /** Added through Tailscale: it has no other address Serve could fall back to. */
  only: boolean;
  /** sha256 of the one-time join token, and when it stops working (until it joined). */
  tokenHash: string | null;
  tokenExpiresAt: string | null;
  /** The auth key last made for it (its id only); removed once the server joined. */
  authKeyId: string | null;
  /** Its device in the tailnet, once it joined. */
  deviceId: string | null;
  nodeKey: string | null;
  /** Its Tailscale IPv4 address (100.x.y.z): where Serve connects. */
  address: string | null;
  /** MagicDNS name, like serve-web.tail1234.ts.net. */
  dnsName: string | null;
  joinedAt: string | null;
  /** The device as the Tailscale API last showed it. */
  online: boolean | null;
  lastSeen: string | null;
  checkedAt: string | null;
  /** Why the last look failed (the device was removed, the API refused). */
  error: string | null;
};

/** A server's membership in the private network (WireGuard between servers). */
export type ServerMesh = {
  enabled: boolean;
  /** Address the other servers reach this one at (IP or host name), without the port. */
  endpoint: string | null;
  /** UDP port WireGuard listens on. */
  port: number;
  publicKey: string;
  /** Encrypted WireGuard private key. */
  privateKey: string;
  /** Hash of the configuration last written to the server. */
  configHash?: string | null;
  /** Agent image the server runs. */
  agent?: string | null;
  state: "starting" | "ready" | "error" | "off";
  message?: string | null;
  syncedAt?: string | null;
};

/** Latest machine figures a server's metrics agent sent. */
export type AgentSnapshot = {
  at: string;
  cpu: number;
  cores: number;
  memory: { total: number; used: number };
  disk: { total: number; used: number };
  load: number[];
  uptime: number;
};

/** A container of a Serve service as the server's agent last saw it. */
export type AgentContainer = {
  id: string;
  name: string;
  service: string;
  deployment?: string;
  /** Docker's state: running, restarting, exited, created, paused, dead. */
  state: string;
  restartCount: number;
  startedAt?: string;
  /** Unix seconds. */
  created: number;
  oomKilled?: boolean;
  exitCode: number;
};

/** The metrics agent on a remote server (see agent/main.go). */
export type ServerAgent = {
  /** Image the agent container runs (serve-agent:<binary hash>). */
  image: string;
  /** Dashboard addresses the agent pushes to, comma-separated. */
  urls?: string;
  /** SHA-256 of the token the agent sends with its samples. */
  tokenHash: string;
  installedAt: string;
  /** Run of the agent the stored samples came from (a new one each time it starts), and its last stored sample. */
  boot?: string | null;
  seq?: number;
  /** Last time samples arrived, by push or collected over SSH. */
  seenAt?: string | null;
  via?: "push" | "ssh" | null;
  version?: string | null;
  snapshot?: AgentSnapshot | null;
  /** The server's service containers as last checked (every few seconds), and when. */
  containers?: AgentContainer[];
  containersAt?: string | null;
  /** Why the agent could not be installed. */
  error?: string | null;
};

export type PackageManager = "apt" | "dnf" | "yum" | "zypper" | "pacman" | "apk";
export type OsPackage = { name: string; current: string | null; next: string | null; docker: boolean };
/** Operating system updates of a server: the last check, and the last install with its log. */
export type OsUpdates = {
  checkedAt: string | null;
  manager: PackageManager | null;
  packages: OsPackage[];
  rebootRequired: boolean;
  error: string | null;
  run: { state: "running" | "success" | "failed"; startedAt: string; finishedAt: string | null; what: "all" | string[]; error: string | null; log: string } | null;
  /** Last time the organization was told about updates. */
  notifiedAt?: string | null;
};

export type ServerInfo = {
  os?: string;
  kernel?: string;
  arch?: string;
  cpus?: number;
  memory?: number;
  docker?: string | null;
  compose?: string | null;
};

/** The id of the machine Serve itself runs on. */
export const LOCAL_SERVER_ID = "local";

export const server = pgTable("server", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  /** The machine Serve runs on; reached through the Docker socket, not SSH. */
  isLocal: boolean("is_local").notNull().default(false),
  host: text("host").notNull(),
  port: integer("port").notNull().default(22),
  username: text("username").notNull().default("root"),
  privateKeyId: text("private_key_id").references(() => privateKey.id, { onDelete: "restrict" }),
  /** SHA256 fingerprint of the SSH host key, pinned on first connection. */
  hostKey: text("host_key"),
  status: text("status").$type<ServerStatus>().notNull().default("pending"),
  statusMessage: text("status_message"),
  /** Output of the last validation / setup run. */
  setupLog: text("setup_log").notNull().default(""),
  info: jsonb("info").$type<ServerInfo>().notNull().default({}),
  /** Data directory on the server. */
  dataDir: text("data_dir").notNull().default("/data/serve"),
  proxyHttpPort: integer("proxy_http_port").notNull().default(80),
  proxyHttpsPort: integer("proxy_https_port").notNull().default(443),
  /** Public IPv4 used for DNS records and sslip.io domains. */
  publicIp: text("public_ip"),
  /** Wildcard base domain for generated app domains on this server. */
  wildcardDomain: text("wildcard_domain"),
  sslipFallback: boolean("sslip_fallback").notNull().default(true),
  /** Builds this server runs at once (deploys it builds count against it). */
  buildConcurrency: integer("build_concurrency").notNull().default(2),
  /** Minutes a deployment on this server may run before it is stopped; null for Serve's default. */
  deployTimeoutMinutes: integer("deploy_timeout_minutes"),
  /** Deployments that may wait in the queue for this server; null for no limit. */
  deployQueueLimit: integer("deploy_queue_limit"),
  osUpdates: jsonb("os_updates").$type<OsUpdates>(),
  /** Images kept per service on this server, for instant rollbacks. */
  imageRetention: integer("image_retention").notNull().default(5),
  /** Hours of CPU, memory and request metrics kept for this server and its services. */
  metricsRetentionHours: integer("metrics_retention_hours").notNull().default(48),
  /** Sample CPU, memory and disk of this server and its services. Off: no agent, no samples, no charts. */
  metricsEnabled: boolean("metrics_enabled").notNull().default(true),
  /** Metrics agent of a remote server; null until it is installed (and on the local server). */
  agent: jsonb("agent").$type<ServerAgent>(),
  /** Reverse proxy running on this server. */
  proxyKind: text("proxy_kind").$type<ProxyKind>().notNull().default("nginx"),
  /** Global settings of each proxy kind (kept for all kinds so switching back restores them). */
  proxyConfig: jsonb("proxy_config").$type<ServerProxyConfig>().notNull().default({}),
  /** Progress of the last proxy switch. */
  proxySwitch: jsonb("proxy_switch").$type<ProxySwitchState | null>(),
  /** Stopped by an admin: Serve must not start the proxy again on its own. */
  proxyStopped: boolean("proxy_stopped").notNull().default(false),
  /** Ports were saved in Serve (the local server otherwise uses SERVE_PROXY_HTTP(S)_PORT). */
  proxyPortsCustomized: boolean("proxy_ports_customized").notNull().default(false),
  /** A CDN or load balancer in front of the proxy whose visitor IP header is believed. Null: only Cloudflare Tunnel traffic. */
  trustedProxies: jsonb("trusted_proxies").$type<TrustedProxies | null>(),
  /**
   * Organization that brought this server: its admins manage it. Null: the instance's server,
   * managed by Root admins. Servers of a deleted organization go back to the instance.
   */
  ownerOrganizationId: text("owner_organization_id").references(() => organization.id, { onDelete: "set null" }),
  /** Organizations allowed to deploy here besides the owner (set by Root admins); null means every organization. */
  organizationIds: text("organization_ids").array(),
  /** Slot in the private network: the server owns 10.240.<index>.0/24 and 10.241.<index>.0/24. */
  meshIndex: integer("mesh_index").unique(),
  mesh: jsonb("mesh").$type<ServerMesh>(),
  /** Set for servers without a public address that connect out (see ServerTunnel). */
  tunnel: jsonb("tunnel").$type<ServerTunnel>(),
  /** Set for servers in a Tailscale tailnet (see ServerTailscale). */
  tailscale: jsonb("tailscale").$type<ServerTailscale>(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const setting = pgTable("setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

/* -------------------------------------------------------------------------- */
/*                            Projects & services                             */
/* -------------------------------------------------------------------------- */

export const project = pgTable("project", {
  id: id(),
  organizationId: orgRef(),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color").notNull().default("blue"),
  /** Show the project's services in groups (applications, databases, stacks). */
  groupServices: boolean("group_services").notNull().default(true),
  /** Environments whose deploys wait for approval, and times deploys are frozen. */
  deployRules: jsonb("deploy_rules").$type<import("@/lib/deploy-rules").DeployRules>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const environment = pgTable(
  "environment",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Where services sit on the canvas, by service id; missing ones are placed automatically. */
    canvas: jsonb("canvas").$type<{ positions: Record<string, { x: number; y: number }> }>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("environment_project_name_idx").on(t.projectId, t.name)],
);

export type ServiceType = "app" | "database" | "compose";
export type ServiceStatus = "idle" | "building" | "deploying" | "running" | "stopped" | "failed" | "crashed" | "restarting";

export const service = pgTable(
  "service",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environment.id, { onDelete: "cascade" }),
    /** Its own deploy approval: "always" waits, "never" does not; null follows the project's rules. */
    deployApproval: text("deploy_approval").$type<"always" | "never">(),
    /** Server the service runs on. */
    serverId: text("server_id")
      .notNull()
      .default(LOCAL_SERVER_ID)
      .references(() => server.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    /** Docker-safe unique identifier used for containers, networks and hosts. */
    slug: text("slug").notNull().unique(),
    /** Extra private hostname chosen by the user; the slug stays reachable too. */
    hostname: text("hostname"),
    type: text("type").$type<ServiceType>().notNull(),
    icon: text("icon"),
    status: text("status").$type<ServiceStatus>().notNull().default("idle"),
    source: jsonb("source").$type<SourceConfig>(),
    build: jsonb("build").$type<BuildConfig>(),
    runtime: jsonb("runtime").$type<RuntimeConfig>().notNull(),
    database: jsonb("database").$type<DatabaseConfig>(),
    /** Backups of databases inside a compose stack, by compose service name. */
    composeBackups: jsonb("compose_backups").$type<Record<string, ComposeBackupConfig>>(),
    /** Variables of single replicas, by replica number (from 1): key → encrypted value. They win over the service's variables. */
    replicaVars: jsonb("replica_vars").$type<Record<string, Record<string, string>>>(),
    /** Variables only pull request previews get (encrypted), replacing the service's variables with the same name. */
    previewVars: jsonb("preview_vars").$type<Record<string, string>>(),
    compose: jsonb("compose").$type<ComposeConfig>(),
    /** Build server, registry and extra servers of an app (build once, run on many servers). */
    distribution: jsonb("distribution").$type<DistributionConfig>(),
    /** Health of the app's copies on its extra servers, for the load balancing on its own server. */
    balance: jsonb("balance").$type<BalanceState>(),
    /** Request log settings; null: never set up (off). */
    requestLog: jsonb("request_log").$type<RequestLogConfig>(),
    /** Per-service HTTP options for the nginx site (limits, auth, headers…). */
    proxy: jsonb("proxy").$type<ServiceProxyConfig>(),
    /** Full site configuration written instead of the generated one, per proxy kind. Root admins only. */
    proxyCustom: jsonb("proxy_custom").$type<Partial<Record<RunningKind, string>>>(),
    autoDeploy: boolean("auto_deploy").notNull().default(true),
    /** Deploy pull requests as temporary preview services. */
    previewsEnabled: boolean("previews_enabled").notNull().default(false),
    /** Preview URL template like pr-{pr}.example.com ({pr}: the pull request number); null: a generated address. */
    previewDomain: text("preview_domain"),
    /** Set on preview services: the service they were created from. */
    parentServiceId: text("parent_service_id").references((): AnyPgColumn => service.id, { onDelete: "cascade" }),
    previewPr: integer("preview_pr"),
    /** Previews of this service get their own copy of a database. */
    previewDatabase: jsonb("preview_database").$type<PreviewDatabaseConfig>(),
    /** Maintenance page on every domain of the service. */
    maintenance: jsonb("maintenance").$type<MaintenanceConfig>(),
    webhookSecret: text("webhook_secret").notNull(),
    currentDeploymentId: text("current_deployment_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("service_project_idx").on(t.projectId), index("service_env_idx").on(t.environmentId), index("service_server_idx").on(t.serverId)],
);

export const envVar = pgTable(
  "env_var",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** Encrypted value. */
    value: text("value").notNull(),
    buildTime: boolean("build_time").notNull().default(false),
    runtime: boolean("runtime").notNull().default(true),
    /** Kept exactly as written: ${{…}} in it is not filled in. */
    literal: boolean("literal").notNull().default(false),
    /** Edited in a multi-line field (keys, certificates). */
    multiline: boolean("multiline").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("env_var_service_key_idx").on(t.serviceId, t.key)],
);

/**
 * Variables of one server for one organization's services on it, used as ${{server.KEY}}. Per
 * organization: a server shared by several organizations gives each its own values.
 */
export const serverVar = pgTable(
  "server_var",
  {
    id: id(),
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** Encrypted value. */
    value: text("value").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("server_var_key_idx").on(t.serverId, t.organizationId, t.key)],
);

/** Variables shared by all services of a project environment. */
export const sharedVar = pgTable(
  "shared_var",
  {
    id: id(),
    /** Exactly one scope is set: organization (${{org.KEY}}), project (${{project.KEY}}) or environment. */
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => project.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").references(() => environment.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("shared_var_env_key_idx").on(t.environmentId, t.key),
    uniqueIndex("shared_var_project_key_idx").on(t.projectId, t.key),
    uniqueIndex("shared_var_org_key_idx").on(t.organizationId, t.key),
    check("shared_var_one_scope", sql`num_nonnulls(${t.organizationId}, ${t.projectId}, ${t.environmentId}) = 1`),
  ],
);

/** Labels an organization puts on services, to find them and to redeploy them together. */
export const tag = pgTable(
  "tag",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("gray"),
    /** Secret of the tag's deploy hook (/api/deploy-hooks/tags/<id>), like a service's webhook secret. */
    deploySecret: text("deploy_secret").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("tag_org_name_idx").on(t.organizationId, sql`lower(${t.name})`)],
);

export const serviceTag = pgTable(
  "service_tag",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tag.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.tagId] }), index("service_tag_tag_idx").on(t.tagId)],
);

/** Compose templates an organization saved for its own one-click catalog. */
export type CustomTemplateVar = {
  key: string;
  generate?: "password" | "strongPassword" | "secret" | "hex32" | "hex16" | "base64key";
  value?: string;
  publicUrl?: boolean;
  publicHost?: boolean;
  label?: string;
};

export const customTemplate = pgTable(
  "custom_template",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default("Custom"),
    iconUrl: text("icon_url"),
    compose: text("compose").notNull(),
    vars: jsonb("vars").$type<CustomTemplateVar[]>().notNull().default([]),
    exposeService: text("expose_service"),
    exposePort: integer("expose_port"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("custom_template_org_idx").on(t.organizationId)],
);

/** "waiting": held for approval (deploy rules), not queued yet. */
export type DeploymentStatus = "waiting" | "queued" | "building" | "deploying" | "success" | "failed" | "cancelled" | "superseded";

export type DeploymentTrigger = "manual" | "webhook" | "rollback" | "redeploy" | "create" | "deploy-hook" | "api" | "cli";

/** The project folder a deployment was built from, uploaded by the CLI (a .tar.gz kept in the data directory). */
export type DeploymentUpload = {
  /** The archive, relative to the uploads directory: "<serviceId>/<id>.tar.gz". */
  archive: string;
  /** Size of the archive in bytes. */
  size: number;
  files: number;
  /** The folder had changes that were not committed. */
  dirty: boolean;
};

export const deployment = pgTable(
  "deployment",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
    status: text("status").$type<DeploymentStatus>().notNull().default("queued"),
    trigger: text("trigger").$type<DeploymentTrigger>().notNull(),
    /** Image tag produced (or reused) by this deployment. */
    image: text("image"),
    commitSha: text("commit_sha"),
    commitMessage: text("commit_message"),
    commitAuthor: text("commit_author"),
    branch: text("branch"),
    /** When rolling back, deploy the image of this deployment without building. */
    rollbackOf: text("rollback_of"),
    /** Registry reference (pinned by digest when known) of the pushed image; other servers pull this. */
    registryImage: text("registry_image"),
    /** Per-server status when the service runs on more than one server. */
    targets: jsonb("targets").$type<DeploymentTarget[]>(),
    /**
     * A container made outside Serve that this deployment takes over (move: stopped once the service
     * runs in its place) or copies (copy: it keeps running; its data is copied into the service).
     */
    adopt: jsonb("adopt").$type<{
      containerId: string;
      name: string;
      mode?: "move" | "copy";
      volumes?: { from: string; to: string }[];
      git?: { repository: string; branch: string; credentialId: string | null };
    }>(),
    /** Files uploaded from the CLI that this deployment builds instead of cloning (a redeploy reuses them). */
    upload: jsonb("upload").$type<DeploymentUpload>(),
    /** Fingerprint of the settings this deployment ran with: a different one now means a redeploy would apply changes. */
    configHash: text("config_hash"),
    /** Who let a deployment that waited for approval go ahead, and when. */
    approvedBy: text("approved_by").references(() => user.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    logs: text("logs").notNull().default(""),
    error: text("error"),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("deployment_service_idx").on(t.serviceId, t.createdAt), index("deployment_status_idx").on(t.status)],
);

/* -------------------------------------------------------------------------- */
/*                           Domains & certificates                           */
/* -------------------------------------------------------------------------- */

export const domain = pgTable(
  "domain",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull().unique(),
    /** Container port to route to. Falls back to the service port. */
    port: integer("port"),
    /** For compose services: which compose service receives traffic. */
    composeService: text("compose_service"),
    pathPrefix: text("path_prefix").notNull().default("/"),
    https: boolean("https").notNull().default(true),
    forceHttps: boolean("force_https").notNull().default(true),
    /** Redirect this hostname to another URL instead of proxying. */
    redirectTo: text("redirect_to"),
    certificateId: text("certificate_id").references(() => certificate.id, {
      onDelete: "set null",
    }),
    cloudflareAccountId: text("cloudflare_account_id").references(() => cloudflareAccount.id, { onDelete: "set null" }),
    cloudflareZoneId: text("cloudflare_zone_id"),
    cloudflareRecordId: text("cloudflare_record_id"),
    /** Routed through a Cloudflare Tunnel instead of the server's public IP. HTTPS terminates at Cloudflare. */
    tunnelId: text("tunnel_id").references((): AnyPgColumn => cloudflareTunnel.id, { onDelete: "set null" }),
    /** Auto-generated domain (sslip.io or wildcard). */
    generated: boolean("generated").notNull().default(false),
    /** Chosen as the service's main domain (SERVE_PUBLIC_URL). At most one per service. */
    primary: boolean("is_primary").notNull().default(false),
    /**
     * Meant to go through a Cloudflare Tunnel. Kept when the tunnel disappears (tunnel_id is
     * cleared), so Serve can reconnect the domain once a tunnel runs on its server again.
     */
    wantsTunnel: boolean("wants_tunnel").notNull().default(false),
    /** Why the last automatic reconnect to a tunnel failed. */
    tunnelError: text("tunnel_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("domain_service_idx").on(t.serviceId)],
);

/**
 * Domains an organization proved it controls (a TXT record, or the zone in its Cloudflare
 * account). Covers the name and every subdomain. Other organizations than Root need one before
 * adding a custom domain.
 */
export const verifiedDomain = pgTable(
  "verified_domain",
  {
    id: id(),
    organizationId: orgRef(),
    name: text("name").notNull(),
    /** "txt" or "cloudflare". */
    method: text("method").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("verified_domain_org_name_idx").on(t.organizationId, t.name)],
);

export type CertificateProvider = "letsencrypt-http" | "letsencrypt-cloudflare" | "cloudflare-origin" | "custom";

/**
 * The data of a database deleted with its volume kept: enough to start a new database on it, with
 * the account it was made with. Gone once a database uses it again.
 */
export const keptDatabase = pgTable(
  "kept_database",
  {
    id: id(),
    organizationId: orgRef(),
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    /** The deleted service's name. */
    name: text("name").notNull(),
    engine: text("engine").$type<DbEngine>().notNull(),
    version: text("version").notNull(),
    image: text("image"),
    username: text("username").notNull(),
    /** Encrypted. */
    password: text("password").notNull(),
    database: text("database").notNull(),
    /** Docker volume name, or an absolute host path. */
    volume: text("volume").notNull(),
    /** Made by Serve: deleting the database that uses it again may delete it. */
    owned: boolean("owned").notNull().default(true),
    dataMountPath: text("data_mount_path"),
    pgdata: text("pgdata"),
    createdAt: createdAt(),
  },
  (t) => [index("kept_database_org_idx").on(t.organizationId)],
);

export type CertificateStatus = "pending" | "issuing" | "active" | "failed" | "expired";

export const certificate = pgTable("certificate", {
  id: id(),
  organizationId: orgRef(),
  name: text("name").notNull(),
  domains: text("domains").array().notNull(),
  /** Server whose proxy serves (and stores) this certificate. */
  serverId: text("server_id")
    .notNull()
    .default(LOCAL_SERVER_ID)
    .references(() => server.id, { onDelete: "cascade" }),
  provider: text("provider").$type<CertificateProvider>().notNull(),
  status: text("status").$type<CertificateStatus>().notNull().default("pending"),
  /** Absolute paths to PEM files inside the data dir. */
  certPath: text("cert_path"),
  keyPath: text("key_path"),
  issuer: text("issuer"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  autoRenew: boolean("auto_renew").notNull().default(true),
  cloudflareAccountId: text("cloudflare_account_id").references(() => cloudflareAccount.id, { onDelete: "set null" }),
  lastError: text("last_error"),
  logs: text("logs").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* -------------------------------------------------------------------------- */
/*                                Integrations                                */
/* -------------------------------------------------------------------------- */

/**
 * How Serve signs in to Cloudflare: a pasted API token, or a "Sign in with Cloudflare" grant. One
 * login can reach several Cloudflare accounts; each is a cloudflare_account row that points here,
 * so renewing the login once keeps all of them working.
 */
export const cloudflareCredential = pgTable("cloudflare_credential", {
  id: id(),
  organizationId: orgRef(),
  /** "token" (pasted API token, never expires) or "oauth" (renewed with the refresh token). */
  authType: text("auth_type").$type<"token" | "oauth">().notNull().default("token"),
  /** Encrypted API token, or the OAuth access token. */
  secret: text("secret").notNull(),
  /** Encrypted OAuth refresh token. */
  refreshToken: text("refresh_token"),
  /** When the OAuth access token stops working. */
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  /** Optional encrypted Origin CA key (for origin certificates with legacy keys). */
  originCaKey: text("origin_ca_key"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const cloudflareAccount = pgTable("cloudflare_account", {
  id: id(),
  organizationId: orgRef(),
  name: text("name").notNull(),
  /** The login this account is reached with (shared with the other accounts of the same login). */
  credentialId: text("credential_id")
    .notNull()
    .references(() => cloudflareCredential.id, { onDelete: "cascade" }),
  cfAccountId: text("cf_account_id"),
  email: text("email"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * A Tailscale tailnet Serve may add servers to. Instance-wide like the servers it holds, so only
 * Root admins manage it. Signs in with an OAuth client (preferred, it does not expire) or an API key.
 */
export const tailscaleTailnet = pgTable("tailscale_tailnet", {
  id: id(),
  name: text("name").notNull(),
  /** The tailnet as the API names it: "-" for the default tailnet of the credentials. */
  tailnet: text("tailnet").notNull(),
  authType: text("auth_type").$type<"oauth" | "apikey">().notNull(),
  /** OAuth client id (not secret). */
  clientId: text("client_id"),
  /** Encrypted OAuth client secret, or the API access key. */
  secret: text("secret").notNull(),
  /** Encrypted OAuth access token (one hour), renewed with the client when it runs out. */
  accessToken: text("access_token"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  /** Tag every device Serve adds gets; its owner is set in the tailnet policy. */
  tag: text("tag").notNull().default("tag:serve"),
  /** MagicDNS suffix of the tailnet (tail1234.ts.net), learned from its devices. */
  dnsSuffix: text("dns_suffix"),
  /** Why the last call to the API failed; null when it worked. */
  error: text("error"),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type TunnelStatus = "pending" | "healthy" | "degraded" | "down" | "error";

/**
 * A Cloudflare Tunnel from one server to one Cloudflare account. Domains in
 * that account's zones can route through it, so servers without a public IP
 * (or with closed ports) can serve traffic. Runs as a cloudflared container.
 */
export const cloudflareTunnel = pgTable(
  "cloudflare_tunnel",
  {
    id: id(),
    organizationId: orgRef(),
    cloudflareAccountId: text("cloudflare_account_id")
      .notNull()
      .references(() => cloudflareAccount.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    /** Tunnel id on Cloudflare. */
    cfTunnelId: text("cf_tunnel_id").notNull(),
    name: text("name").notNull(),
    /** Encrypted connector token. */
    token: text("token").notNull(),
    status: text("status").$type<TunnelStatus>().notNull().default("pending"),
    statusMessage: text("status_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("cloudflare_tunnel_server_account_idx").on(t.serverId, t.cloudflareAccountId)],
);

export type GitProviderType = "github-app" | "github" | "gitlab" | "bitbucket" | "gitea" | "ssh";

/** An OAuth application the org registered on GitLab, Gitea/Forgejo or Bitbucket. */
export const gitOAuthApp = pgTable("git_oauth_app", {
  id: id(),
  organizationId: orgRef(),
  provider: text("provider").$type<"gitlab" | "gitea" | "bitbucket">().notNull(),
  name: text("name").notNull(),
  /** Self-hosted server URL; null for gitlab.com / bitbucket.org. */
  baseUrl: text("base_url"),
  clientId: text("client_id").notNull(),
  /** Encrypted. */
  clientSecret: text("client_secret").notNull(),
  /** GitLab only: limit repositories to this group (path). */
  groupPath: text("group_path"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const gitCredential = pgTable("git_credential", {
  id: id(),
  organizationId: orgRef(),
  /** Set for credentials connected through an OAuth app; secret then holds encrypted OAuth tokens (JSON). */
  oauthAppId: text("oauth_app_id").references(() => gitOAuthApp.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  provider: text("provider").$type<GitProviderType>().notNull(),
  /** Encrypted token or private SSH key. */
  secret: text("secret").notNull(),
  /** Public SSH key (for ssh credentials) or account login. */
  publicInfo: text("public_info"),
  /** Base URL for self-hosted providers. */
  baseUrl: text("base_url"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type { NotificationKind } from "@/lib/notifications";

export type LogDrainKind = "http" | "loki" | "elasticsearch" | "splunk" | "syslog";

/** Where an organization's container logs are sent, by Vector on each server. */
export const logDrain = pgTable("log_drain", {
  id: id(),
  organizationId: orgRef(),
  name: text("name").notNull(),
  kind: text("kind").$type<LogDrainKind>().notNull(),
  url: text("url").notNull(),
  /** Encrypted JSON: { header?: { name, value }, username?, password? }. */
  secrets: text("secrets"),
  /** Projects whose logs are sent (new services included); with no services picked either, null means everything. */
  projectIds: text("project_ids").array(),
  /** Single services whose logs are sent, next to whole projects. */
  serviceIds: text("service_ids").array(),
  /** Settings that are not secret: the Elasticsearch or Splunk index, the Splunk source type. */
  options: jsonb("options").$type<{ index?: string | null; sourcetype?: string | null; insecure?: boolean }>(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const notificationChannel = pgTable("notification_channel", {
  id: id(),
  organizationId: orgRef(),
  name: text("name").notNull(),
  kind: text("kind").$type<NotificationKind>().notNull(),
  /** Encrypted JSON config (webhook url, bot token, chat id...). */
  config: text("config").notNull(),
  events: text("events").array().notNull().default(sql`'{}'::text[]`),
  enabled: boolean("enabled").notNull().default(true),
  /** Projects, environments or services it covers; null means everything. */
  scope: jsonb("scope").$type<ChannelScope>(),
  /** Lowest severity that is sent. */
  minSeverity: text("min_severity").$type<Severity>().notNull().default("info"),
  quietHours: jsonb("quiet_hours").$type<QuietHours>(),
  /** Repeats of the same event within this many minutes are grouped into the next message. */
  throttleMinutes: integer("throttle_minutes").notNull().default(0),
  /** Custom title and body with {placeholders}; null uses the default text. */
  template: jsonb("template").$type<MessageTemplate>(),
  lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
  lastDeliveryStatus: text("last_delivery_status").$type<DeliveryStatus>(),
  lastDeliveryError: text("last_delivery_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * sent/failed: delivered or not (failed ones retry until attempts run out).
 * held: waiting for quiet hours to end. suppressed: dropped by quiet hours or a provider.
 * grouped: a repeat inside the throttle window, counted in the next message.
 */
export type DeliveryStatus = "pending" | "sent" | "failed" | "held" | "suppressed" | "grouped";

export const notificationDelivery = pgTable(
  "notification_delivery",
  {
    id: id(),
    organizationId: orgRef(),
    channelId: text("channel_id")
      .notNull()
      .references(() => notificationChannel.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    severity: text("severity").$type<Severity>().notNull(),
    title: text("title").notNull(),
    status: text("status").$type<DeliveryStatus>().notNull(),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    /** event + service/server: repeats share it. */
    groupKey: text("group_key").notNull(),
    /** The resolved message, kept for retries and digests. */
    message: jsonb("message").$type<Record<string, unknown>>().notNull(),
    /** Test sends are shown in history but never grouped or held. */
    test: boolean("test").notNull().default(false),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("notification_delivery_channel_idx").on(t.channelId, t.createdAt), index("notification_delivery_org_idx").on(t.organizationId, t.createdAt)],
);

export const apiToken = pgTable("api_token", {
  id: id(),
  organizationId: orgRef(),
  name: text("name").notNull(),
  /** SHA-256 hash of the token. */
  tokenHash: text("token_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Granted scopes (see src/lib/api-scopes.ts). */
  scopes: text("scopes").array().notNull().default(sql`'{read,deploy}'::text[]`),
  /** Projects the token may touch. Null means every project. */
  projectIds: text("project_ids").array(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  lastUsedIp: text("last_used_ip"),
  createdAt: createdAt(),
});

/**
 * A sign-in of the CLI (`serve login`): the CLI polls with the device code while someone signed
 * in to the dashboard approves the short user code. Approving makes an API token, handed out once.
 */
export const cliLogin = pgTable(
  "cli_login",
  {
    id: id(),
    /** SHA-256 hash of the device code the CLI polls with. */
    deviceCodeHash: text("device_code_hash").notNull().unique(),
    /** The code people compare and approve, like ABCD-1234. */
    userCode: text("user_code").notNull().unique(),
    /** The computer the CLI runs on, as it says. */
    client: text("client").notNull(),
    version: text("version"),
    ip: text("ip"),
    status: text("status").$type<"pending" | "approved" | "denied" | "spent">().notNull().default("pending"),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    /** The new token, encrypted, until the CLI collects it. */
    token: text("token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("cli_login_expires_idx").on(t.expiresAt)],
);

/* -------------------------------------------------------------------------- */
/*                                  Backups                                   */
/* -------------------------------------------------------------------------- */

export type BackupStatus = "running" | "success" | "failed";

export const backup = pgTable(
  "backup",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
    status: text("status").$type<BackupStatus>().notNull().default("running"),
    filename: text("filename"),
    size: bigint("size", { mode: "number" }),
    destination: text("destination").notNull().default("local"),
    error: text("error"),
    trigger: text("trigger").notNull().default("manual"),
    /** Upload to S3: uploaded, failed, or null when no S3 destination was set. */
    /** Compose service the dump came from; null for a database service. */
    target: text("target"),
    /** The databases this backup holds; null for the main database only (or a compose stack's dump). */
    databases: jsonb("databases").$type<string[] | null>(),
    s3Status: text("s3_status").$type<"uploaded" | "failed" | "deleted">(),
    /** Last restore of this backup. */
    restoreStatus: text("restore_status").$type<"running" | "success" | "failed">(),
    restoredAt: timestamp("restored_at", { withTimezone: true }),
    /** Containers a running storage restore stopped, so a worker restart starts exactly those again. */
    restoreStopped: text("restore_stopped").array(),
    /** Progress and output of the backup, import and restore steps. */
    log: text("log"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("backup_service_idx").on(t.serviceId, t.createdAt)],
);

export const s3Destination = pgTable("s3_destination", {
  id: id(),
  organizationId: orgRef(),
  name: text("name").notNull(),
  endpoint: text("endpoint").notNull(),
  region: text("region").notNull().default("auto"),
  bucket: text("bucket").notNull(),
  accessKeyId: text("access_key_id").notNull(),
  /** Encrypted. */
  secretAccessKey: text("secret_access_key").notNull(),
  pathPrefix: text("path_prefix").notNull().default(""),
  createdAt: createdAt(),
});

export type RegistryKind = "dockerhub" | "ghcr" | "gitlab" | "generic";

/** Container registry an organization pushes built images to (and servers pull from). */
export const containerRegistry = pgTable("container_registry", {
  id: id(),
  organizationId: orgRef(),
  name: text("name").notNull(),
  kind: text("kind").$type<RegistryKind>().notNull(),
  /** Registry host, e.g. docker.io, ghcr.io or registry.example.com:5000. */
  host: text("host").notNull(),
  username: text("username").notNull(),
  /** Encrypted password or access token. */
  password: text("password").notNull(),
  /** Default namespace for new repositories (user or organization). */
  namespace: text("namespace"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* -------------------------------------------------------------------------- */
/*                              Scheduled tasks                               */
/* -------------------------------------------------------------------------- */

export const scheduledTask = pgTable(
  "scheduled_task",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    schedule: text("schedule").notNull(),
    command: text("command").notNull(),
    /** For compose services: which container runs the command. */
    composeService: text("compose_service"),
    enabled: boolean("enabled").notNull().default(true),
    timeoutSeconds: integer("timeout_seconds").notNull().default(3600),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: text("last_status"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("scheduled_task_service_idx").on(t.serviceId)],
);

export type TaskRunStatus = "running" | "success" | "failed";

export const taskRun = pgTable(
  "task_run",
  {
    id: id(),
    taskId: text("task_id").references(() => scheduledTask.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
    command: text("command").notNull(),
    trigger: text("trigger").notNull().default("schedule"),
    status: text("status").$type<TaskRunStatus>().notNull().default("running"),
    exitCode: integer("exit_code"),
    output: text("output").notNull().default(""),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("task_run_task_idx").on(t.taskId, t.startedAt), index("task_run_service_idx").on(t.serviceId, t.startedAt)],
);

/* -------------------------------------------------------------------------- */
/*                              Jobs & telemetry                              */
/* -------------------------------------------------------------------------- */

export type JobStatus = "pending" | "running" | "done" | "failed";

export const job = pgTable(
  "job",
  {
    id: id(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").$type<JobStatus>().notNull().default("pending"),
    /** Jobs sharing a key run one at a time (e.g. per service). */
    concurrencyKey: text("concurrency_key"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(1),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    error: text("error"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("job_pending_idx").on(t.status, t.runAt)],
);

/** The worker's repeating schedulers (backups, cleanup, certificates…): how their last run went. */
export const schedulerRun = pgTable("scheduler_run", {
  name: text("name").primaryKey(),
  intervalMs: integer("interval_ms").notNull(),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
  lastDurationMs: integer("last_duration_ms"),
  /** The last run's error; null when it went well. */
  lastError: text("last_error"),
  lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
  runs: integer("runs").notNull().default(0),
  failures: integer("failures").notNull().default(0),
  /** Ticks left out because the previous run was still going. */
  skipped: integer("skipped").notNull().default(0),
  lastSkippedAt: timestamp("last_skipped_at", { withTimezone: true }),
});

export const activity = pgTable(
  "activity",
  {
    id: id(),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    projectId: text("project_id"),
    message: text("message").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("activity_org_idx").on(t.organizationId, t.createdAt)],
);

/** Periodic resource samples, used for charts. */
export const metric = pgTable(
  "metric",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** "server" or a service id. */
    scope: text("scope").notNull(),
    cpu: integer("cpu").notNull(), // percent * 100
    memory: bigint("memory", { mode: "number" }).notNull(), // bytes
    memoryLimit: bigint("memory_limit", { mode: "number" }),
    netRx: bigint("net_rx", { mode: "number" }),
    netTx: bigint("net_tx", { mode: "number" }),
    disk: bigint("disk", { mode: "number" }),
    diskTotal: bigint("disk_total", { mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [index("metric_scope_idx").on(t.scope, t.createdAt)],
);

/**
 * Five-minute averages of `metric`, for history longer than a day: charts over days read far
 * fewer rows, and raw samples are kept only for the last two days.
 */
export const metricRollup = pgTable(
  "metric_rollup",
  {
    scope: text("scope").notNull(),
    bucket: timestamp("bucket", { withTimezone: true }).notNull(),
    cpu: integer("cpu").notNull(),
    memory: bigint("memory", { mode: "number" }).notNull(),
    memoryLimit: bigint("memory_limit", { mode: "number" }),
    netRx: bigint("net_rx", { mode: "number" }),
    netTx: bigint("net_tx", { mode: "number" }),
    disk: bigint("disk", { mode: "number" }),
    diskTotal: bigint("disk_total", { mode: "number" }),
  },
  (t) => [primaryKey({ columns: [t.scope, t.bucket] })],
);

/** Requests per hostname per minute, aggregated from the proxy access log. */
export const requestMetric = pgTable(
  "request_metric",
  {
    hostname: text("hostname").notNull(),
    minute: timestamp("minute", { withTimezone: true }).notNull(),
    requests: integer("requests").notNull().default(0),
    s2xx: integer("s2xx").notNull().default(0),
    s3xx: integer("s3xx").notNull().default(0),
    s4xx: integer("s4xx").notNull().default(0),
    s5xx: integer("s5xx").notNull().default(0),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    /** Sum of response times in milliseconds. */
    durationMs: bigint("duration_ms", { mode: "number" }).notNull().default(0),
    maxMs: integer("max_ms").notNull().default(0),
  },
  (t) => [uniqueIndex("request_metric_pk").on(t.hostname, t.minute)],
);

/** Single requests through the proxy, for services with the request log on (see analytics). */
export const requestLog = pgTable(
  "request_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
    time: timestamp("time", { withTimezone: true }).notNull(),
    hostname: text("hostname").notNull(),
    method: text("method"),
    /** Path without the query string (it can hold tokens). */
    path: text("path").notNull(),
    /** The request had a query string (not kept). */
    query: boolean("query").notNull().default(false),
    status: integer("status").notNull(),
    durationMs: integer("duration_ms").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    ip: text("ip"),
    userAgent: text("user_agent"),
    referer: text("referer"),
    /** Where the proxy sent it ("host:port"), when the proxy logs it. */
    upstream: text("upstream"),
    /** The server whose proxy logged it. */
    serverId: text("server_id"),
  },
  (t) => [index("request_log_service_time_idx").on(t.serviceId, t.time), index("request_log_service_status_time_idx").on(t.serviceId, t.status, t.time)],
);

/* -------------------------------------------------------------------------- */
/*                                 Monitoring                                 */
/* -------------------------------------------------------------------------- */

export type MonitorKind = "http" | "container";
export type MonitorStatus = "pending" | "up" | "down" | "paused";

/** Uptime check of one service: HTTP against a URL, or the health of its containers. */
export const monitor = pgTable("monitor", {
  id: id(),
  serviceId: text("service_id")
    .notNull()
    .unique()
    .references(() => service.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  kind: text("kind").$type<MonitorKind>().notNull().default("http"),
  /** Full URL to check; null checks the service's primary domain. */
  url: text("url"),
  path: text("path").notNull().default("/"),
  /** Accepted status codes, like "200-399" or "200,204". */
  expectedStatus: text("expected_status").notNull().default("200-399"),
  /** Text the response body must contain. */
  keyword: text("keyword"),
  intervalSeconds: integer("interval_seconds").notNull().default(60),
  timeoutMs: integer("timeout_ms").notNull().default(10_000),
  /** Consecutive failed checks before the service counts as down. */
  failureThreshold: integer("failure_threshold").notNull().default(3),
  status: text("status").$type<MonitorStatus>().notNull().default("pending"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastLatencyMs: integer("last_latency_ms"),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Raw check results, kept for two days (daily rollups keep the long history). */
export const monitorCheck = pgTable(
  "monitor_check",
  {
    id: id(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitor.id, { onDelete: "cascade" }),
    ok: boolean("ok").notNull(),
    latencyMs: integer("latency_ms"),
    statusCode: integer("status_code"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("monitor_check_monitor_idx").on(t.monitorId, t.createdAt)],
);

/** One row per monitor and UTC day: counts for uptime bars and average latency. */
export const monitorDaily = pgTable(
  "monitor_daily",
  {
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitor.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD (UTC). */
    day: text("day").notNull(),
    checks: integer("checks").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    latencySum: bigint("latency_sum", { mode: "number" }).notNull().default(0),
    latencyCount: integer("latency_count").notNull().default(0),
  },
  (t) => [uniqueIndex("monitor_daily_idx").on(t.monitorId, t.day)],
);

export type IncidentKind = "down" | "crashloop" | "resource";

/** Something that went wrong and when it was resolved. At most one open incident per key. */
export const incident = pgTable(
  "incident",
  {
    id: id(),
    organizationId: orgRef(),
    serviceId: text("service_id").references(() => service.id, { onDelete: "cascade" }),
    serverId: text("server_id").references(() => server.id, { onDelete: "cascade" }),
    kind: text("kind").$type<IncidentKind>().notNull(),
    /** Dedupe key, like "down:<serviceId>" or "resource:<serverId>:disk". */
    key: text("key").notNull(),
    severity: text("severity").$type<"warning" | "critical">().notNull().default("critical"),
    title: text("title").notNull(),
    detail: text("detail"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("incident_org_idx").on(t.organizationId, t.startedAt), index("incident_key_idx").on(t.key, t.resolvedAt)],
);

/* -------------------------------------------------------------------------- */
/*                                Status pages                                */
/* -------------------------------------------------------------------------- */

/** A public page that shows how an organization's services are doing. */
export const statusPage = pgTable("status_page", {
  id: id(),
  organizationId: orgRef(),
  name: text("name").notNull(),
  /** The page is at /status/<slug> on the dashboard's domain. */
  slug: text("slug").notNull().unique(),
  /** Its own domain, like status.example.com, served by the dashboard's proxy. */
  domain: text("domain").unique(),
  https: boolean("https").notNull().default(true),
  certificateId: text("certificate_id").references(() => certificate.id, { onDelete: "set null" }),
  /** Reached through this Cloudflare Tunnel instead of the server's public IP (Cloudflare serves HTTPS). */
  tunnelId: text("tunnel_id").references((): AnyPgColumn => cloudflareTunnel.id, { onDelete: "set null" }),
  visibility: text("visibility").$type<StatusVisibility>().notNull().default("draft"),
  /** bcrypt hash, for visibility "password". */
  passwordHash: text("password_hash"),
  design: jsonb("design").$type<Partial<StatusDesign>>().notNull().default({}),
  /** Uploaded logos (light, dark) and favicon, as base64 with their type. */
  images: jsonb("images")
    .$type<{ logo?: StatusImage & { data: string }; logoDark?: StatusImage & { data: string }; favicon?: StatusImage & { data: string } }>()
    .notNull()
    .default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** One line on a status page: a service with an uptime check, or a manual entry. */
export const statusComponent = pgTable(
  "status_component",
  {
    id: id(),
    pageId: text("page_id")
      .notNull()
      .references(() => statusPage.id, { onDelete: "cascade" }),
    /** Null for a component without a check (only posted notices change it). */
    serviceId: text("service_id").references(() => service.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** Section heading it shows under; null shows it on its own. */
    group: text("group_name"),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("status_component_page_idx").on(t.pageId, t.position)],
);

/** An incident or a maintenance window posted on a status page. */
export const statusNotice = pgTable(
  "status_notice",
  {
    id: id(),
    pageId: text("page_id")
      .notNull()
      .references(() => statusPage.id, { onDelete: "cascade" }),
    kind: text("kind").$type<NoticeKind>().notNull(),
    title: text("title").notNull(),
    impact: text("impact").$type<IncidentImpact>().notNull().default("major"),
    /** Incidents only; maintenance goes by its times. */
    state: text("state").$type<IncidentState>().notNull().default("investigating"),
    componentIds: jsonb("component_ids").$type<string[]>().notNull().default([]),
    /** Maintenance window; for incidents the time it started. */
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("status_notice_page_idx").on(t.pageId, t.createdAt)],
);

/** One message on a notice, newest last. */
export const statusNoticeUpdate = pgTable(
  "status_notice_update",
  {
    id: id(),
    noticeId: text("notice_id")
      .notNull()
      .references(() => statusNotice.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("status_notice_update_notice_idx").on(t.noticeId, t.createdAt)],
);

/** Per-server thresholds for resource alerts. */
export type ServerAlertConfig = {
  enabled: boolean;
  /** Disk use (percent) for a warning and for a critical alert. */
  diskWarn: number;
  diskCritical: number;
  /** Memory use (percent). */
  memory: number;
  /** CPU use (percent), sustained for cpuMinutes. */
  cpu: number;
  cpuMinutes: number;
};

/**
 * Private network addresses a server hands out: one per service it exposes to other servers
 * ("svc:<serviceId>" or "svc:<serviceId>:<compose service>") and one per environment whose
 * containers reach other servers ("env:<environmentId>"). Kept while the service stays on the
 * server, so the names other servers map to it never change.
 */
export const meshAddress = pgTable(
  "mesh_address",
  {
    id: id(),
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    serviceId: text("service_id").references(() => service.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").references(() => environment.id, { onDelete: "cascade" }),
    ip: text("ip").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mesh_address_key_idx").on(t.serverId, t.key), uniqueIndex("mesh_address_ip_idx").on(t.ip)],
);

/** A private network: servers in the same one reach each other's services; others do not. */
export const privateNetwork = pgTable(
  "private_network",
  {
    id: id(),
    /** Organization whose admins manage it; only its servers join. Null: the instance's, managed by Root admins. */
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  // Names are unique per owner, so no organization learns another's network names.
  (t) => [uniqueIndex("private_network_name_idx").on(sql`coalesce(${t.organizationId}, '')`, sql`lower(${t.name})`)],
);

/** A server can be in several private networks; it only takes part while it has joined (server.mesh). */
export const privateNetworkMember = pgTable(
  "private_network_member",
  {
    networkId: text("network_id")
      .notNull()
      .references(() => privateNetwork.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.networkId, t.serverId] }), index("private_network_member_server_idx").on(t.serverId)],
);

export const serverAlerts = pgTable("server_alerts", {
  serverId: text("server_id")
    .primaryKey()
    .references(() => server.id, { onDelete: "cascade" }),
  config: jsonb("config").$type<ServerAlertConfig>().notNull(),
  updatedAt: updatedAt(),
});

/* -------------------------------------------------------------------------- */
/*                                 Relations                                  */
/* -------------------------------------------------------------------------- */

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
  projects: many(project),
}));

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, { fields: [member.organizationId], references: [organization.id] }),
  user: one(user, { fields: [member.userId], references: [user.id] }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, { fields: [invitation.organizationId], references: [organization.id] }),
  inviter: one(user, { fields: [invitation.inviterId], references: [user.id] }),
}));

export const userRelations = relations(user, ({ many }) => ({
  members: many(member),
}));

export const projectRelations = relations(project, ({ many, one }) => ({
  organization: one(organization, { fields: [project.organizationId], references: [organization.id] }),
  environments: many(environment),
  services: many(service),
}));

export const environmentRelations = relations(environment, ({ one, many }) => ({
  project: one(project, { fields: [environment.projectId], references: [project.id] }),
  services: many(service),
  sharedVars: many(sharedVar),
}));

export const serviceRelations = relations(service, ({ one, many }) => ({
  project: one(project, { fields: [service.projectId], references: [project.id] }),
  environment: one(environment, {
    fields: [service.environmentId],
    references: [environment.id],
  }),
  server: one(server, { fields: [service.serverId], references: [server.id] }),
  domains: many(domain),
  deployments: many(deployment),
  envVars: many(envVar),
  backups: many(backup),
}));

export const serverRelations = relations(server, ({ one, many }) => ({
  privateKey: one(privateKey, { fields: [server.privateKeyId], references: [privateKey.id] }),
  services: many(service),
}));

export const deploymentRelations = relations(deployment, ({ one }) => ({
  service: one(service, { fields: [deployment.serviceId], references: [service.id] }),
  user: one(user, { fields: [deployment.createdBy], references: [user.id] }),
}));

export const domainRelations = relations(domain, ({ one }) => ({
  service: one(service, { fields: [domain.serviceId], references: [service.id] }),
  certificate: one(certificate, {
    fields: [domain.certificateId],
    references: [certificate.id],
  }),
  cloudflareAccount: one(cloudflareAccount, {
    fields: [domain.cloudflareAccountId],
    references: [cloudflareAccount.id],
  }),
}));

export const certificateRelations = relations(certificate, ({ many, one }) => ({
  domains: many(domain),
  cloudflareAccount: one(cloudflareAccount, {
    fields: [certificate.cloudflareAccountId],
    references: [cloudflareAccount.id],
  }),
}));

export const envVarRelations = relations(envVar, ({ one }) => ({
  service: one(service, { fields: [envVar.serviceId], references: [service.id] }),
}));

export const sharedVarRelations = relations(sharedVar, ({ one }) => ({
  environment: one(environment, {
    fields: [sharedVar.environmentId],
    references: [environment.id],
  }),
}));

export const backupRelations = relations(backup, ({ one }) => ({
  service: one(service, { fields: [backup.serviceId], references: [service.id] }),
}));

export const scheduledTaskRelations = relations(scheduledTask, ({ one, many }) => ({
  service: one(service, { fields: [scheduledTask.serviceId], references: [service.id] }),
  runs: many(taskRun),
}));

export const taskRunRelations = relations(taskRun, ({ one }) => ({
  task: one(scheduledTask, { fields: [taskRun.taskId], references: [scheduledTask.id] }),
  service: one(service, { fields: [taskRun.serviceId], references: [service.id] }),
}));

export const activityRelations = relations(activity, ({ one }) => ({
  user: one(user, { fields: [activity.userId], references: [user.id] }),
}));

/** Limits set by Root admins for one organization, and its measured usage. */
export const organizationLimit = pgTable("organization_limit", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /** False while the organization follows the instance defaults; the row then only keeps measurements. */
  custom: boolean("custom").notNull().default(false),
  limits: jsonb("limits").$type<OrgLimits>().notNull().default({}),
  /** Limits already announced as reached, so each one notifies once until usage drops again. */
  notified: text("notified").array().notNull().default(sql`'{}'::text[]`),
  /** Last measured size of the organization's volumes, in bytes. */
  diskBytes: bigint("disk_bytes", { mode: "number" }),
  diskMeasuredAt: timestamp("disk_measured_at", { withTimezone: true }),
  updatedAt: updatedAt(),
});

/** Each member's own overview layout: which widgets, where and how. No row means the default layout. */
export const dashboardLayout = pgTable(
  "dashboard_layout",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    layout: jsonb("layout").$type<DashboardLayout>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.organizationId] })],
);

/**
 * An external secret manager. Variables reference its secrets as ${{secrets.<name>.<path>}};
 * values are fetched at deploy time and never stored here.
 */
export const secretProvider = pgTable(
  "secret_provider",
  {
    id: id(),
    organizationId: orgRef(),
    /** Used in references: lowercase letters, digits and dashes. */
    name: text("name").notNull(),
    kind: text("kind").$type<SecretProviderKind>().notNull(),
    /** Addresses and options; nothing secret. */
    config: jsonb("config").$type<SecretProviderConfig>().notNull().default({}),
    /** Encrypted JSON with the token or keys. */
    credentials: text("credentials").notNull(),
    /** Projects and environments that may use it. Empty lists mean all. */
    access: jsonb("access").$type<SecretProviderAccess>().notNull().default({ projectIds: [], environmentIds: [] }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("secret_provider_org_name_idx").on(t.organizationId, t.name)],
);

export type DatabaseBranchStatus = "creating" | "ready" | "resetting" | "failed" | "deleting";

/**
 * A branch of a Postgres database service: a second database inside the same container, filled
 * with a copy of the main database, with its own login. Removed with the service.
 */
export const databaseBranch = pgTable(
  "database_branch",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
    /** Used in references: lowercase letters, digits and dashes. */
    name: text("name").notNull(),
    /** Database and role inside the container. */
    database: text("database").notNull(),
    username: text("username").notNull(),
    /** Encrypted. */
    password: text("password").notNull(),
    status: text("status").$type<DatabaseBranchStatus>().notNull().default("creating"),
    error: text("error"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    /** When the data was last copied from the main database. */
    copiedAt: timestamp("copied_at", { withTimezone: true }),
    /** Every copy into this branch runs the clean-up SQL (personal data hidden). */
    scrubbed: boolean("scrubbed").notNull().default(false),
    /** Also copies the server's other databases, each as <database>__<branch>, reached by the same login. */
    allDatabases: boolean("all_databases").notNull().default(false),
    /** The other databases the last copy took (their original names). */
    extraDatabases: jsonb("extra_databases").$type<string[]>().notNull().default([]),
    /** The branch this one copies (made and reset from); null copies the main database. */
    sourceBranchId: text("source_branch_id").references((): AnyPgColumn => databaseBranch.id, { onDelete: "set null" }),
    /** The pull request preview that uses this branch; removed when the preview closes. */
    previewServiceId: text("preview_service_id").references((): AnyPgColumn => service.id, { onDelete: "set null" }),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("database_branch_service_name_idx").on(t.serviceId, t.name), index("database_branch_preview_idx").on(t.previewServiceId)],
);

export type DatabaseUserAccess = "read" | "readwrite" | "owner";

/**
 * A login Serve made inside a database service (Users page). The login itself lives in the
 * database; this row keeps its password so its connection URL can be copied later.
 */
export const databaseUser = pgTable(
  "database_user",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    /** Encrypted. Null for a login made outside Serve whose password Serve was never given. */
    password: text("password"),
    /** Null until Serve sets it (a login made outside Serve keeps its own grants). */
    access: text("access").$type<DatabaseUserAccess>(),
    /** The databases inside the service this login can reach. */
    databases: jsonb("databases").$type<string[]>().notNull().default([]),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("database_user_service_username_idx").on(t.serviceId, t.username)],
);
