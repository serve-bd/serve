/**
 * One-click service templates. Each template is a compose file plus the
 * variables it needs; `generate` values are created when the service is made.
 */
export type TemplateVar = {
  key: string;
  generate?: "password" | "secret" | "hex32";
  value?: string;
  /** Filled with the service's public URL (https://domain). */
  publicUrl?: boolean;
};

export type Template = {
  id: string;
  name: string;
  description: string;
  category: "Automation" | "Analytics" | "CMS" | "Developer tools" | "Storage" | "Monitoring" | "Security" | "Databases";
  website: string;
  /** Compose service + port that receives the generated domain. */
  expose: { service: string; port: number };
  vars: TemplateVar[];
  compose: string;
};

export const templates: Template[] = [
  {
    id: "n8n",
    name: "n8n",
    description: "Workflow automation with a visual editor and 400+ integrations.",
    category: "Automation",
    website: "https://n8n.io",
    expose: { service: "n8n", port: 5678 },
    vars: [
      { key: "N8N_ENCRYPTION_KEY", generate: "secret" },
      { key: "POSTGRES_PASSWORD", generate: "password" },
      { key: "WEBHOOK_URL", publicUrl: true },
    ],
    compose: `services:
  n8n:
    image: docker.n8n.io/n8nio/n8n:latest
    restart: unless-stopped
    environment:
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: postgres
      DB_POSTGRESDB_DATABASE: n8n
      DB_POSTGRESDB_USER: n8n
      DB_POSTGRESDB_PASSWORD: \${POSTGRES_PASSWORD}
      N8N_ENCRYPTION_KEY: \${N8N_ENCRYPTION_KEY}
      WEBHOOK_URL: \${WEBHOOK_URL}
      N8N_PROXY_HOPS: "1"
      GENERIC_TIMEZONE: UTC
    volumes:
      - n8n-data:/home/node/.n8n
    depends_on:
      postgres:
        condition: service_healthy
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: n8n
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: n8n
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U n8n"]
      interval: 5s
      retries: 10
volumes:
  n8n-data:
  postgres-data:
`,
  },
  {
    id: "uptime-kuma",
    name: "Uptime Kuma",
    description: "Self-hosted uptime monitoring with status pages and alerts.",
    category: "Monitoring",
    website: "https://uptime.kuma.pet",
    expose: { service: "uptime-kuma", port: 3001 },
    vars: [],
    compose: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:2
    restart: unless-stopped
    volumes:
      - kuma-data:/app/data
volumes:
  kuma-data:
`,
  },
  {
    id: "umami",
    name: "Umami",
    description: "Simple, privacy-focused web analytics. A Google Analytics alternative.",
    category: "Analytics",
    website: "https://umami.is",
    expose: { service: "umami", port: 3000 },
    vars: [
      { key: "APP_SECRET", generate: "secret" },
      { key: "POSTGRES_PASSWORD", generate: "password" },
    ],
    compose: `services:
  umami:
    image: ghcr.io/umami-software/umami:postgresql-latest
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://umami:\${POSTGRES_PASSWORD}@postgres:5432/umami
      APP_SECRET: \${APP_SECRET}
    depends_on:
      postgres:
        condition: service_healthy
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: umami
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: umami
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U umami"]
      interval: 5s
      retries: 10
volumes:
  postgres-data:
`,
  },
  {
    id: "plausible",
    name: "Plausible Analytics",
    description: "Lightweight, cookie-free website analytics.",
    category: "Analytics",
    website: "https://plausible.io",
    expose: { service: "plausible", port: 8000 },
    vars: [
      { key: "SECRET_KEY_BASE", generate: "hex32" },
      { key: "BASE_URL", publicUrl: true },
      { key: "POSTGRES_PASSWORD", generate: "password" },
    ],
    compose: `services:
  plausible:
    image: ghcr.io/plausible/community-edition:v3
    restart: unless-stopped
    command: sh -c "/entrypoint.sh db createdb && /entrypoint.sh db migrate && /entrypoint.sh run"
    environment:
      BASE_URL: \${BASE_URL}
      SECRET_KEY_BASE: \${SECRET_KEY_BASE}
      DATABASE_URL: postgres://plausible:\${POSTGRES_PASSWORD}@postgres:5432/plausible
      CLICKHOUSE_DATABASE_URL: http://clickhouse:8123/plausible
      HTTP_PORT: "8000"
    depends_on:
      postgres:
        condition: service_healthy
      clickhouse:
        condition: service_healthy
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: plausible
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: plausible
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U plausible"]
      interval: 5s
      retries: 10
  clickhouse:
    image: clickhouse/clickhouse-server:24.12-alpine
    restart: unless-stopped
    environment:
      CLICKHOUSE_SKIP_USER_SETUP: "1"
    volumes:
      - clickhouse-data:/var/lib/clickhouse
    ulimits:
      nofile:
        soft: 262144
        hard: 262144
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 -O - http://127.0.0.1:8123/ping || exit 1"]
      interval: 5s
      retries: 20
volumes:
  postgres-data:
  clickhouse-data:
`,
  },
  {
    id: "ghost",
    name: "Ghost",
    description: "Publishing platform for blogs, newsletters and memberships.",
    category: "CMS",
    website: "https://ghost.org",
    expose: { service: "ghost", port: 2368 },
    vars: [
      { key: "GHOST_URL", publicUrl: true },
      { key: "MYSQL_PASSWORD", generate: "password" },
    ],
    compose: `services:
  ghost:
    image: ghost:6-alpine
    restart: unless-stopped
    environment:
      url: \${GHOST_URL}
      database__client: mysql
      database__connection__host: mysql
      database__connection__user: ghost
      database__connection__password: \${MYSQL_PASSWORD}
      database__connection__database: ghost
    volumes:
      - ghost-content:/var/lib/ghost/content
    depends_on:
      mysql:
        condition: service_healthy
  mysql:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_PASSWORD}
      MYSQL_DATABASE: ghost
      MYSQL_USER: ghost
      MYSQL_PASSWORD: \${MYSQL_PASSWORD}
    volumes:
      - mysql-data:/var/lib/mysql
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -p$$MYSQL_ROOT_PASSWORD --silent"]
      interval: 5s
      retries: 20
volumes:
  ghost-content:
  mysql-data:
`,
  },
  {
    id: "wordpress",
    name: "WordPress",
    description: "The world's most popular CMS, with MariaDB.",
    category: "CMS",
    website: "https://wordpress.org",
    expose: { service: "wordpress", port: 80 },
    vars: [{ key: "DB_PASSWORD", generate: "password" }],
    compose: `services:
  wordpress:
    image: wordpress:6-apache
    restart: unless-stopped
    environment:
      WORDPRESS_DB_HOST: mariadb
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
      WORDPRESS_DB_NAME: wordpress
    volumes:
      - wp-content:/var/www/html
    depends_on:
      mariadb:
        condition: service_healthy
  mariadb:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: \${DB_PASSWORD}
      MARIADB_DATABASE: wordpress
      MARIADB_USER: wordpress
      MARIADB_PASSWORD: \${DB_PASSWORD}
    volumes:
      - db-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 5s
      retries: 20
volumes:
  wp-content:
  db-data:
`,
  },
  {
    id: "minio",
    name: "MinIO",
    description: "S3-compatible object storage. Console exposed on the domain.",
    category: "Storage",
    website: "https://min.io",
    expose: { service: "minio", port: 9001 },
    vars: [
      { key: "MINIO_ROOT_USER", value: "admin" },
      { key: "MINIO_ROOT_PASSWORD", generate: "password" },
    ],
    compose: `services:
  minio:
    image: quay.io/minio/minio:latest
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: \${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD}
    volumes:
      - minio-data:/data
volumes:
  minio-data:
`,
  },
  {
    id: "gitea",
    name: "Gitea",
    description: "Lightweight self-hosted Git service with issues and CI.",
    category: "Developer tools",
    website: "https://about.gitea.com",
    expose: { service: "gitea", port: 3000 },
    vars: [{ key: "ROOT_URL", publicUrl: true }],
    compose: `services:
  gitea:
    image: gitea/gitea:1
    restart: unless-stopped
    environment:
      GITEA__server__ROOT_URL: \${ROOT_URL}
      GITEA__database__DB_TYPE: sqlite3
    volumes:
      - gitea-data:/data
volumes:
  gitea-data:
`,
  },
  {
    id: "vaultwarden",
    name: "Vaultwarden",
    description: "Bitwarden-compatible password manager server.",
    category: "Security",
    website: "https://github.com/dani-garcia/vaultwarden",
    expose: { service: "vaultwarden", port: 80 },
    vars: [
      { key: "DOMAIN", publicUrl: true },
      { key: "ADMIN_TOKEN", generate: "secret" },
    ],
    compose: `services:
  vaultwarden:
    image: vaultwarden/server:latest
    restart: unless-stopped
    environment:
      DOMAIN: \${DOMAIN}
      ADMIN_TOKEN: \${ADMIN_TOKEN}
      SIGNUPS_ALLOWED: "true"
    volumes:
      - vw-data:/data
volumes:
  vw-data:
`,
  },
  {
    id: "metabase",
    name: "Metabase",
    description: "Business intelligence dashboards and questions for your data.",
    category: "Analytics",
    website: "https://www.metabase.com",
    expose: { service: "metabase", port: 3000 },
    vars: [{ key: "POSTGRES_PASSWORD", generate: "password" }],
    compose: `services:
  metabase:
    image: metabase/metabase:latest
    restart: unless-stopped
    environment:
      MB_DB_TYPE: postgres
      MB_DB_DBNAME: metabase
      MB_DB_PORT: "5432"
      MB_DB_USER: metabase
      MB_DB_PASS: \${POSTGRES_PASSWORD}
      MB_DB_HOST: postgres
    depends_on:
      postgres:
        condition: service_healthy
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: metabase
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: metabase
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U metabase"]
      interval: 5s
      retries: 10
volumes:
  postgres-data:
`,
  },
  {
    id: "pgadmin",
    name: "pgAdmin",
    description: "Web administration tool for PostgreSQL.",
    category: "Databases",
    website: "https://www.pgadmin.org",
    expose: { service: "pgadmin", port: 80 },
    vars: [
      { key: "PGADMIN_DEFAULT_EMAIL", value: "admin@example.com" },
      { key: "PGADMIN_DEFAULT_PASSWORD", generate: "password" },
    ],
    compose: `services:
  pgadmin:
    image: dpage/pgadmin4:latest
    restart: unless-stopped
    environment:
      PGADMIN_DEFAULT_EMAIL: \${PGADMIN_DEFAULT_EMAIL}
      PGADMIN_DEFAULT_PASSWORD: \${PGADMIN_DEFAULT_PASSWORD}
    volumes:
      - pgadmin-data:/var/lib/pgadmin
volumes:
  pgadmin-data:
`,
  },
  {
    id: "adminer",
    name: "Adminer",
    description: "Single-page database manager for MySQL, Postgres and more.",
    category: "Databases",
    website: "https://www.adminer.org",
    expose: { service: "adminer", port: 8080 },
    vars: [],
    compose: `services:
  adminer:
    image: adminer:latest
    restart: unless-stopped
`,
  },
  {
    id: "grafana",
    name: "Grafana",
    description: "Dashboards and visualisation for metrics and logs.",
    category: "Monitoring",
    website: "https://grafana.com",
    expose: { service: "grafana", port: 3000 },
    vars: [
      { key: "GF_SECURITY_ADMIN_PASSWORD", generate: "password" },
      { key: "GF_SERVER_ROOT_URL", publicUrl: true },
    ],
    compose: `services:
  grafana:
    image: grafana/grafana:latest
    restart: unless-stopped
    environment:
      GF_SECURITY_ADMIN_PASSWORD: \${GF_SECURITY_ADMIN_PASSWORD}
      GF_SERVER_ROOT_URL: \${GF_SERVER_ROOT_URL}
    volumes:
      - grafana-data:/var/lib/grafana
volumes:
  grafana-data:
`,
  },
  {
    id: "code-server",
    name: "code-server",
    description: "VS Code in the browser, running on your server.",
    category: "Developer tools",
    website: "https://coder.com/docs/code-server",
    expose: { service: "code-server", port: 8443 },
    vars: [{ key: "PASSWORD", generate: "password" }],
    compose: `services:
  code-server:
    image: lscr.io/linuxserver/code-server:latest
    restart: unless-stopped
    environment:
      PASSWORD: \${PASSWORD}
      PUID: "1000"
      PGID: "1000"
    volumes:
      - code-config:/config
volumes:
  code-config:
`,
  },
];

export function getTemplate(id: string) {
  return templates.find((t) => t.id === id) ?? null;
}
