import { type AnyPgColumn, bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type {
  BuildConfig,
  ComposeConfig,
  DatabaseConfig,
  DeploymentTarget,
  DistributionConfig,
  MaintenanceConfig,
  PreviewDatabaseConfig,
  RuntimeConfig,
  SourceConfig,
} from "@/server/services/types";
import type { ServiceProxyConfig } from "@/server/services/proxy-config";
import type { ProxyKind, RunningKind, ProxySwitchState, ServerProxyConfig } from "@/server/proxy/config";
import type { ChannelScope, MessageTemplate, NotificationKind, QuietHours, Severity } from "@/lib/notifications";

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

/* -------------------------------------------------------------------------- */
/*                                  Settings                                  */
/* -------------------------------------------------------------------------- */

/** Key/value store for instance-wide settings. */
/* -------------------------------------------------------------------------- */
/*                                   Servers                                  */
/* -------------------------------------------------------------------------- */

/** SSH keys Serve uses to reach remote servers. Managed by Root admins. */
export const privateKey = pgTable("private_key", {
  id: id(),
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
  /** Organizations allowed to deploy here; null means every organization. */
  organizationIds: text("organization_ids").array(),
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
    compose: jsonb("compose").$type<ComposeConfig>(),
    /** Build server, registry and extra servers of an app (build once, run on many servers). */
    distribution: jsonb("distribution").$type<DistributionConfig>(),
    /** Per-service HTTP options for the nginx site (limits, auth, headers…). */
    proxy: jsonb("proxy").$type<ServiceProxyConfig>(),
    /** Full site configuration written instead of the generated one, per proxy kind. Root admins only. */
    proxyCustom: jsonb("proxy_custom").$type<Partial<Record<RunningKind, string>>>(),
    autoDeploy: boolean("auto_deploy").notNull().default(true),
    /** Deploy pull requests as temporary preview services. */
    previewsEnabled: boolean("previews_enabled").notNull().default(false),
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("env_var_service_key_idx").on(t.serviceId, t.key)],
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

/** Compose templates an organization saved for its own one-click catalog. */
export type CustomTemplateVar = {
  key: string;
  generate?: "password" | "secret" | "hex32" | "base64key";
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

export type DeploymentStatus = "queued" | "building" | "deploying" | "success" | "failed" | "cancelled" | "superseded";

export type DeploymentTrigger = "manual" | "webhook" | "rollback" | "redeploy" | "create" | "deploy-hook" | "api";

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

export type CertificateProvider = "letsencrypt-http" | "letsencrypt-cloudflare" | "cloudflare-origin" | "custom";

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

export const cloudflareAccount = pgTable("cloudflare_account", {
  id: id(),
  organizationId: orgRef(),
  name: text("name").notNull(),
  /** Encrypted API token. */
  apiToken: text("api_token").notNull(),
  /** Optional encrypted Origin CA key (for origin certificates with legacy keys). */
  originCaKey: text("origin_ca_key"),
  cfAccountId: text("cf_account_id"),
  email: text("email"),
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
    s3Status: text("s3_status").$type<"uploaded" | "failed" | "deleted">(),
    /** Last restore of this backup. */
    restoreStatus: text("restore_status").$type<"running" | "success" | "failed">(),
    restoredAt: timestamp("restored_at", { withTimezone: true }),
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
