/**
 * One-click service templates. Each template is a compose file plus the
 * variables it needs; `generate` values are created when the service is made.
 */
export type TemplateVar = {
  key: string;
  generate?: "password" | "secret" | "hex32" | "base64key";
  value?: string;
  /** Filled with the service's public URL (https://domain); follows the primary domain. */
  publicUrl?: boolean;
  /** Filled with the service's public hostname (domain only); follows the primary domain. */
  publicHost?: boolean;
  /** Shown on the configure step. */
  label?: string;
};

export const templateCategories = [
  "Automation",
  "Analytics",
  "CMS",
  "Productivity",
  "Developer tools",
  "Monitoring",
  "Storage",
  "AI",
  "Communication",
  "Security",
  "Media",
  "Databases",
] as const;

export type TemplateCategory = (typeof templateCategories)[number];

export type Template = {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  website: string;
  /** Compose service + port that receives the generated domain. */
  expose: { service: string; port: number };
  vars: TemplateVar[];
  compose: string;
  /** Shown first in the catalog. */
  popular?: boolean;
  /** Mounts the Docker socket or host paths: only Root admins may create it. */
  hostAccess?: boolean;
  /** One or two sentences shown before creating (first login, extra ports, …). */
  note?: string;
};

/* ------------------------------ Shared blocks ----------------------------- */

const postgres = (user: string, db = user, password = "POSTGRES_PASSWORD", image = "postgres:17-alpine") => `  postgres:
    image: ${image}
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${user}
      POSTGRES_PASSWORD: \${${password}}
      POSTGRES_DB: ${db}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${user} -d ${db}"]
      interval: 5s
      retries: 20
`;

const mariadb = (user: string, db = user, password = "DB_PASSWORD") => `  mariadb:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: \${${password}}
      MARIADB_DATABASE: ${db}
      MARIADB_USER: ${user}
      MARIADB_PASSWORD: \${${password}}
    volumes:
      - db-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 5s
      retries: 20
`;

const redis = `  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 10
`;

const healthy = (...names: string[]) => `    depends_on:\n${names.map((n) => `      ${n}:\n        condition: service_healthy\n`).join("")}`;

const volumes = (...names: string[]) => `volumes:\n${names.map((n) => `  ${n}:\n`).join("")}`;

/* -------------------------------- Templates ------------------------------- */

export const templates: Template[] = [
  /* ------------------------------- Automation ------------------------------ */
  {
    id: "n8n",
    name: "n8n",
    description: "Workflow automation with a visual editor and 400+ integrations.",
    category: "Automation",
    website: "https://n8n.io",
    popular: true,
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
${healthy("postgres")}${postgres("n8n")}${volumes("n8n-data", "postgres-data")}`,
  },
  {
    id: "node-red",
    name: "Node-RED",
    description: "Low-code, flow-based programming for events, APIs and IoT.",
    category: "Automation",
    website: "https://nodered.org",
    expose: { service: "node-red", port: 1880 },
    vars: [],
    note: "The editor has no login by default. Set adminAuth in settings.js (in the data volume) before sharing the domain.",
    compose: `services:
  node-red:
    image: nodered/node-red:latest
    restart: unless-stopped
    environment:
      TZ: UTC
    volumes:
      - node-red-data:/data
${volumes("node-red-data")}`,
  },
  {
    id: "changedetection",
    name: "changedetection.io",
    description: "Watch websites for changes and get notified.",
    category: "Automation",
    website: "https://changedetection.io",
    expose: { service: "changedetection", port: 5000 },
    vars: [{ key: "BASE_URL", publicUrl: true }],
    compose: `services:
  changedetection:
    image: ghcr.io/dgtlmoon/changedetection.io:latest
    restart: unless-stopped
    environment:
      BASE_URL: \${BASE_URL}
    volumes:
      - changedetection-data:/datastore
${volumes("changedetection-data")}`,
  },

  /* -------------------------------- Analytics ------------------------------ */
  {
    id: "umami",
    name: "Umami",
    description: "Simple, privacy-focused web analytics. A Google Analytics alternative.",
    category: "Analytics",
    website: "https://umami.is",
    popular: true,
    expose: { service: "umami", port: 3000 },
    vars: [
      { key: "APP_SECRET", generate: "secret" },
      { key: "POSTGRES_PASSWORD", generate: "password" },
    ],
    note: "Sign in with admin / umami and change the password right away.",
    compose: `services:
  umami:
    image: ghcr.io/umami-software/umami:postgresql-latest
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://umami:\${POSTGRES_PASSWORD}@postgres:5432/umami
      APP_SECRET: \${APP_SECRET}
${healthy("postgres")}${postgres("umami")}${volumes("postgres-data")}`,
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
${healthy("postgres", "clickhouse")}${postgres("plausible")}  clickhouse:
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
${volumes("postgres-data", "clickhouse-data")}`,
  },
  {
    id: "matomo",
    name: "Matomo",
    description: "Full-featured web analytics you own, with MariaDB.",
    category: "Analytics",
    website: "https://matomo.org",
    expose: { service: "matomo", port: 80 },
    vars: [{ key: "DB_PASSWORD", generate: "password" }],
    compose: `services:
  matomo:
    image: matomo:apache
    restart: unless-stopped
    environment:
      MATOMO_DATABASE_HOST: mariadb
      MATOMO_DATABASE_ADAPTER: mysql
      MATOMO_DATABASE_TABLES_PREFIX: matomo_
      MATOMO_DATABASE_USERNAME: matomo
      MATOMO_DATABASE_PASSWORD: \${DB_PASSWORD}
      MATOMO_DATABASE_DBNAME: matomo
    volumes:
      - matomo-data:/var/www/html
${healthy("mariadb")}${mariadb("matomo")}${volumes("matomo-data", "db-data")}`,
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
${healthy("postgres")}${postgres("metabase")}${volumes("postgres-data")}`,
  },

  /* ----------------------------------- CMS --------------------------------- */
  {
    id: "wordpress",
    name: "WordPress",
    description: "The world's most popular CMS, with MariaDB.",
    category: "CMS",
    website: "https://wordpress.org",
    popular: true,
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
${healthy("mariadb")}${mariadb("wordpress")}${volumes("wp-content", "db-data")}`,
  },
  {
    id: "ghost",
    name: "Ghost",
    description: "Publishing platform for blogs, newsletters and memberships.",
    category: "CMS",
    website: "https://ghost.org",
    popular: true,
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
${healthy("mysql")}  mysql:
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
${volumes("ghost-content", "mysql-data")}`,
  },
  {
    id: "directus",
    name: "Directus",
    description: "Headless CMS and instant REST/GraphQL API for any SQL database.",
    category: "CMS",
    website: "https://directus.io",
    expose: { service: "directus", port: 8055 },
    vars: [
      { key: "SECRET", generate: "secret" },
      { key: "POSTGRES_PASSWORD", generate: "password" },
      { key: "ADMIN_EMAIL", value: "admin@example.com", label: "Admin email" },
      { key: "ADMIN_PASSWORD", generate: "password", label: "Admin password" },
      { key: "PUBLIC_URL", publicUrl: true },
    ],
    compose: `services:
  directus:
    image: directus/directus:latest
    restart: unless-stopped
    environment:
      SECRET: \${SECRET}
      DB_CLIENT: pg
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_DATABASE: directus
      DB_USER: directus
      DB_PASSWORD: \${POSTGRES_PASSWORD}
      ADMIN_EMAIL: \${ADMIN_EMAIL}
      ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      PUBLIC_URL: \${PUBLIC_URL}
    volumes:
      - directus-uploads:/directus/uploads
      - directus-extensions:/directus/extensions
${healthy("postgres")}${postgres("directus")}${volumes("directus-uploads", "directus-extensions", "postgres-data")}`,
  },
  {
    id: "wikijs",
    name: "Wiki.js",
    description: "Modern, powerful wiki with a Markdown and visual editor.",
    category: "CMS",
    website: "https://js.wiki",
    expose: { service: "wiki", port: 3000 },
    vars: [{ key: "POSTGRES_PASSWORD", generate: "password" }],
    compose: `services:
  wiki:
    image: ghcr.io/requarks/wiki:2
    restart: unless-stopped
    environment:
      DB_TYPE: postgres
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_USER: wikijs
      DB_PASS: \${POSTGRES_PASSWORD}
      DB_NAME: wiki
${healthy("postgres")}${postgres("wikijs", "wiki")}${volumes("postgres-data")}`,
  },
  {
    id: "bookstack",
    name: "BookStack",
    description: "Organise documentation into shelves, books and pages.",
    category: "CMS",
    website: "https://www.bookstackapp.com",
    expose: { service: "bookstack", port: 80 },
    vars: [
      { key: "APP_URL", publicUrl: true },
      { key: "APP_KEY", generate: "base64key" },
      { key: "DB_PASSWORD", generate: "password" },
    ],
    note: "Sign in with admin@admin.com / password and change it right away.",
    compose: `services:
  bookstack:
    image: lscr.io/linuxserver/bookstack:latest
    restart: unless-stopped
    environment:
      PUID: "1000"
      PGID: "1000"
      APP_URL: \${APP_URL}
      APP_KEY: \${APP_KEY}
      DB_HOST: mariadb
      DB_PORT: "3306"
      DB_USERNAME: bookstack
      DB_PASSWORD: \${DB_PASSWORD}
      DB_DATABASE: bookstack
    volumes:
      - bookstack-config:/config
${healthy("mariadb")}${mariadb("bookstack")}${volumes("bookstack-config", "db-data")}`,
  },
  {
    id: "docmost",
    name: "Docmost",
    description: "Collaborative wiki and documentation, a Notion and Confluence alternative.",
    category: "CMS",
    website: "https://docmost.com",
    expose: { service: "docmost", port: 3000 },
    vars: [
      { key: "APP_URL", publicUrl: true },
      { key: "APP_SECRET", generate: "secret" },
      { key: "POSTGRES_PASSWORD", generate: "password" },
    ],
    compose: `services:
  docmost:
    image: docmost/docmost:latest
    restart: unless-stopped
    environment:
      APP_URL: \${APP_URL}
      APP_SECRET: \${APP_SECRET}
      DATABASE_URL: postgresql://docmost:\${POSTGRES_PASSWORD}@postgres:5432/docmost?schema=public
      REDIS_URL: redis://redis:6379
    volumes:
      - docmost-storage:/app/data/storage
${healthy("postgres", "redis")}${postgres("docmost")}${redis}${volumes("docmost-storage", "postgres-data", "redis-data")}`,
  },

  /* ------------------------------ Productivity ----------------------------- */
  {
    id: "nextcloud",
    name: "Nextcloud",
    description: "Files, calendar, contacts and office in your own cloud.",
    category: "Productivity",
    website: "https://nextcloud.com",
    popular: true,
    expose: { service: "nextcloud", port: 80 },
    vars: [
      { key: "POSTGRES_PASSWORD", generate: "password" },
      { key: "NEXTCLOUD_ADMIN_USER", value: "admin", label: "Admin user" },
      { key: "NEXTCLOUD_ADMIN_PASSWORD", generate: "password", label: "Admin password" },
      { key: "NEXTCLOUD_URL", publicUrl: true },
      { key: "NEXTCLOUD_HOST", publicHost: true },
    ],
    compose: `services:
  nextcloud:
    image: nextcloud:apache
    restart: unless-stopped
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_DB: nextcloud
      POSTGRES_USER: nextcloud
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      REDIS_HOST: redis
      NEXTCLOUD_ADMIN_USER: \${NEXTCLOUD_ADMIN_USER}
      NEXTCLOUD_ADMIN_PASSWORD: \${NEXTCLOUD_ADMIN_PASSWORD}
      NEXTCLOUD_TRUSTED_DOMAINS: \${NEXTCLOUD_HOST}
      OVERWRITECLIURL: \${NEXTCLOUD_URL}
      TRUSTED_PROXIES: 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16
    volumes:
      - nextcloud-data:/var/www/html
${healthy("postgres", "redis")}${postgres("nextcloud")}${redis}${volumes("nextcloud-data", "postgres-data", "redis-data")}`,
  },
  {
    id: "nocodb",
    name: "NocoDB",
    description: "Turn a database into a smart spreadsheet. An Airtable alternative.",
    category: "Productivity",
    website: "https://nocodb.com",
    expose: { service: "nocodb", port: 8080 },
    vars: [
      { key: "POSTGRES_PASSWORD", generate: "password" },
      { key: "NC_AUTH_JWT_SECRET", generate: "secret" },
      { key: "NC_PUBLIC_URL", publicUrl: true },
    ],
    compose: `services:
  nocodb:
    image: nocodb/nocodb:latest
    restart: unless-stopped
    environment:
      NC_DB: pg://postgres:5432?u=nocodb&p=\${POSTGRES_PASSWORD}&d=nocodb
      NC_AUTH_JWT_SECRET: \${NC_AUTH_JWT_SECRET}
      NC_PUBLIC_URL: \${NC_PUBLIC_URL}
    volumes:
      - nocodb-data:/usr/app/data
${healthy("postgres")}${postgres("nocodb")}${volumes("nocodb-data", "postgres-data")}`,
  },
  {
    id: "baserow",
    name: "Baserow",
    description: "No-code database and spreadsheet collaboration tool.",
    category: "Productivity",
    website: "https://baserow.io",
    expose: { service: "baserow", port: 80 },
    vars: [{ key: "BASEROW_PUBLIC_URL", publicUrl: true }],
    compose: `services:
  baserow:
    image: baserow/baserow:latest
    restart: unless-stopped
    environment:
      BASEROW_PUBLIC_URL: \${BASEROW_PUBLIC_URL}
    volumes:
      - baserow-data:/baserow/data
${volumes("baserow-data")}`,
  },
  {
    id: "paperless-ngx",
    name: "Paperless-ngx",
    description: "Scan, index and archive your documents with full-text search.",
    category: "Productivity",
    website: "https://docs.paperless-ngx.com",
    expose: { service: "paperless", port: 8000 },
    vars: [
      { key: "PAPERLESS_SECRET_KEY", generate: "secret" },
      { key: "POSTGRES_PASSWORD", generate: "password" },
      { key: "PAPERLESS_URL", publicUrl: true },
      { key: "PAPERLESS_ADMIN_PASSWORD", generate: "password", label: "Admin password" },
    ],
    note: "Sign in as admin with the generated admin password (Variables tab).",
    compose: `services:
  paperless:
    image: ghcr.io/paperless-ngx/paperless-ngx:latest
    restart: unless-stopped
    environment:
      PAPERLESS_REDIS: redis://redis:6379
      PAPERLESS_DBHOST: postgres
      PAPERLESS_DBUSER: paperless
      PAPERLESS_DBPASS: \${POSTGRES_PASSWORD}
      PAPERLESS_SECRET_KEY: \${PAPERLESS_SECRET_KEY}
      PAPERLESS_URL: \${PAPERLESS_URL}
      PAPERLESS_ADMIN_USER: admin
      PAPERLESS_ADMIN_PASSWORD: \${PAPERLESS_ADMIN_PASSWORD}
    volumes:
      - paperless-data:/usr/src/paperless/data
      - paperless-media:/usr/src/paperless/media
      - paperless-consume:/usr/src/paperless/consume
      - paperless-export:/usr/src/paperless/export
${healthy("postgres", "redis")}${postgres("paperless")}${redis}${volumes("paperless-data", "paperless-media", "paperless-consume", "paperless-export", "postgres-data", "redis-data")}`,
  },
  {
    id: "actual",
    name: "Actual Budget",
    description: "Private, local-first personal finance and budgeting.",
    category: "Productivity",
    website: "https://actualbudget.org",
    expose: { service: "actual", port: 5006 },
    vars: [],
    compose: `services:
  actual:
    image: actualbudget/actual-server:latest
    restart: unless-stopped
    volumes:
      - actual-data:/data
${volumes("actual-data")}`,
  },
  {
    id: "linkwarden",
    name: "Linkwarden",
    description: "Collect, organise and archive bookmarks with your team.",
    category: "Productivity",
    website: "https://linkwarden.app",
    expose: { service: "linkwarden", port: 3000 },
    vars: [
      { key: "NEXTAUTH_SECRET", generate: "secret" },
      { key: "POSTGRES_PASSWORD", generate: "password" },
      { key: "BASE_URL", publicUrl: true },
    ],
    compose: `services:
  linkwarden:
    image: ghcr.io/linkwarden/linkwarden:latest
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://linkwarden:\${POSTGRES_PASSWORD}@postgres:5432/linkwarden
      NEXTAUTH_SECRET: \${NEXTAUTH_SECRET}
      NEXTAUTH_URL: \${BASE_URL}/api/v1/auth
    volumes:
      - linkwarden-data:/data/data
${healthy("postgres")}${postgres("linkwarden")}${volumes("linkwarden-data", "postgres-data")}`,
  },
  {
    id: "memos",
    name: "Memos",
    description: "Lightweight, privacy-first note taking.",
    category: "Productivity",
    website: "https://usememos.com",
    expose: { service: "memos", port: 5230 },
    vars: [],
    compose: `services:
  memos:
    image: neosmemo/memos:stable
    restart: unless-stopped
    volumes:
      - memos-data:/var/opt/memos
${volumes("memos-data")}`,
  },
  {
    id: "mealie",
    name: "Mealie",
    description: "Recipe manager and meal planner for the whole household.",
    category: "Productivity",
    website: "https://mealie.io",
    expose: { service: "mealie", port: 9000 },
    vars: [{ key: "BASE_URL", publicUrl: true }],
    note: "Sign in with changeme@example.com / MyPassword and change it right away.",
    compose: `services:
  mealie:
    image: ghcr.io/mealie-recipes/mealie:latest
    restart: unless-stopped
    environment:
      BASE_URL: \${BASE_URL}
      ALLOW_SIGNUP: "false"
      TZ: UTC
    volumes:
      - mealie-data:/app/data
${volumes("mealie-data")}`,
  },
  {
    id: "vikunja",
    name: "Vikunja",
    description: "To-do lists, kanban boards and project planning.",
    category: "Productivity",
    website: "https://vikunja.io",
    expose: { service: "vikunja", port: 3456 },
    vars: [
      { key: "VIKUNJA_SERVICE_PUBLICURL", publicUrl: true },
      { key: "VIKUNJA_SERVICE_JWTSECRET", generate: "secret" },
      { key: "POSTGRES_PASSWORD", generate: "password" },
    ],
    compose: `services:
  vikunja:
    image: vikunja/vikunja:latest
    restart: unless-stopped
    environment:
      VIKUNJA_SERVICE_PUBLICURL: \${VIKUNJA_SERVICE_PUBLICURL}
      VIKUNJA_SERVICE_JWTSECRET: \${VIKUNJA_SERVICE_JWTSECRET}
      VIKUNJA_DATABASE_TYPE: postgres
      VIKUNJA_DATABASE_HOST: postgres
      VIKUNJA_DATABASE_USER: vikunja
      VIKUNJA_DATABASE_PASSWORD: \${POSTGRES_PASSWORD}
      VIKUNJA_DATABASE_DATABASE: vikunja
    volumes:
      - vikunja-files:/app/vikunja/files
${healthy("postgres")}${postgres("vikunja")}${volumes("vikunja-files", "postgres-data")}`,
  },
  {
    id: "excalidraw",
    name: "Excalidraw",
    description: "Virtual whiteboard for hand-drawn style diagrams.",
    category: "Productivity",
    website: "https://excalidraw.com",
    expose: { service: "excalidraw", port: 80 },
    vars: [],
    compose: `services:
  excalidraw:
    image: excalidraw/excalidraw:latest
    restart: unless-stopped
`,
  },
  {
    id: "stirling-pdf",
    name: "Stirling PDF",
    description: "Merge, split, convert, sign and OCR PDFs in the browser.",
    category: "Productivity",
    website: "https://www.stirlingpdf.com",
    expose: { service: "stirling-pdf", port: 8080 },
    vars: [],
    compose: `services:
  stirling-pdf:
    image: stirlingtools/stirling-pdf:latest
    restart: unless-stopped
    volumes:
      - stirling-tessdata:/usr/share/tessdata
      - stirling-configs:/configs
${volumes("stirling-tessdata", "stirling-configs")}`,
  },
  {
    id: "it-tools",
    name: "IT-Tools",
    description: "Handy tools for developers: encoders, converters, generators and more.",
    category: "Productivity",
    website: "https://it-tools.tech",
    expose: { service: "it-tools", port: 80 },
    vars: [],
    compose: `services:
  it-tools:
    image: corentinth/it-tools:latest
    restart: unless-stopped
`,
  },
  {
    id: "homepage",
    name: "Homepage",
    description: "A modern, customisable start page for your services.",
    category: "Productivity",
    website: "https://gethomepage.dev",
    expose: { service: "homepage", port: 3000 },
    vars: [{ key: "HOMEPAGE_ALLOWED_HOSTS", publicHost: true }],
    compose: `services:
  homepage:
    image: ghcr.io/gethomepage/homepage:latest
    restart: unless-stopped
    environment:
      HOMEPAGE_ALLOWED_HOSTS: \${HOMEPAGE_ALLOWED_HOSTS}
    volumes:
      - homepage-config:/app/config
${volumes("homepage-config")}`,
  },
  {
    id: "freshrss",
    name: "FreshRSS",
    description: "Fast, self-hosted RSS and Atom feed reader.",
    category: "Productivity",
    website: "https://freshrss.org",
    expose: { service: "freshrss", port: 80 },
    vars: [],
    compose: `services:
  freshrss:
    image: freshrss/freshrss:latest
    restart: unless-stopped
    environment:
      TZ: UTC
      CRON_MIN: "*/20"
    volumes:
      - freshrss-data:/var/www/FreshRSS/data
      - freshrss-extensions:/var/www/FreshRSS/extensions
${volumes("freshrss-data", "freshrss-extensions")}`,
  },
  {
    id: "miniflux",
    name: "Miniflux",
    description: "Minimalist, opinionated feed reader.",
    category: "Productivity",
    website: "https://miniflux.app",
    expose: { service: "miniflux", port: 8080 },
    vars: [
      { key: "POSTGRES_PASSWORD", generate: "password" },
      { key: "ADMIN_PASSWORD", generate: "password", label: "Admin password" },
      { key: "BASE_URL", publicUrl: true },
    ],
    note: "Sign in as admin with the generated admin password (Variables tab).",
    compose: `services:
  miniflux:
    image: miniflux/miniflux:latest
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://miniflux:\${POSTGRES_PASSWORD}@postgres/miniflux?sslmode=disable
      RUN_MIGRATIONS: "1"
      CREATE_ADMIN: "1"
      ADMIN_USERNAME: admin
      ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      BASE_URL: \${BASE_URL}
${healthy("postgres")}${postgres("miniflux")}${volumes("postgres-data")}`,
  },
  {
    id: "searxng",
    name: "SearXNG",
    description: "Private metasearch engine that aggregates results without tracking.",
    category: "Productivity",
    website: "https://docs.searxng.org",
    expose: { service: "searxng", port: 8080 },
    vars: [
      { key: "SEARXNG_BASE_URL", publicUrl: true },
      { key: "SEARXNG_SECRET", generate: "secret" },
    ],
    compose: `services:
  searxng:
    image: searxng/searxng:latest
    restart: unless-stopped
    environment:
      SEARXNG_BASE_URL: \${SEARXNG_BASE_URL}/
      SEARXNG_SECRET: \${SEARXNG_SECRET}
    volumes:
      - searxng-config:/etc/searxng
${volumes("searxng-config")}`,
  },

  /* ----------------------------- Developer tools --------------------------- */
  {
    id: "gitea",
    name: "Gitea",
    description: "Lightweight self-hosted Git service with issues and CI.",
    category: "Developer tools",
    website: "https://about.gitea.com",
    popular: true,
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
${volumes("gitea-data")}`,
  },
  {
    id: "forgejo",
    name: "Forgejo",
    description: "Community-run Git forge with issues, pull requests and Actions.",
    category: "Developer tools",
    website: "https://forgejo.org",
    expose: { service: "forgejo", port: 3000 },
    vars: [{ key: "ROOT_URL", publicUrl: true }],
    note: "Git over SSH needs port 22 of the container published in Domains & ports.",
    compose: `services:
  forgejo:
    image: codeberg.org/forgejo/forgejo:11
    restart: unless-stopped
    environment:
      USER_UID: "1000"
      USER_GID: "1000"
      FORGEJO__server__ROOT_URL: \${ROOT_URL}
      FORGEJO__database__DB_TYPE: sqlite3
    volumes:
      - forgejo-data:/data
${volumes("forgejo-data")}`,
  },
  {
    id: "code-server",
    name: "code-server",
    description: "VS Code in the browser, running on your server.",
    category: "Developer tools",
    website: "https://coder.com/docs/code-server",
    expose: { service: "code-server", port: 8443 },
    vars: [{ key: "PASSWORD", generate: "password", label: "Password" }],
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
${volumes("code-config")}`,
  },
  {
    id: "mailpit",
    name: "Mailpit",
    description: "Email testing: catch outgoing mail over SMTP and read it in a web UI.",
    category: "Developer tools",
    website: "https://mailpit.axllent.org",
    expose: { service: "mailpit", port: 8025 },
    vars: [],
    note: "Other services send mail to <stack>-mailpit:1025 on the private network.",
    compose: `services:
  mailpit:
    image: axllent/mailpit:latest
    restart: unless-stopped
    environment:
      MP_DATABASE: /data/mailpit.db
      MP_SMTP_AUTH_ACCEPT_ANY: "1"
      MP_SMTP_AUTH_ALLOW_INSECURE: "1"
    volumes:
      - mailpit-data:/data
${volumes("mailpit-data")}`,
  },
  {
    id: "browserless",
    name: "Browserless",
    description: "Headless Chrome as a service for Puppeteer and Playwright.",
    category: "Developer tools",
    website: "https://www.browserless.io",
    expose: { service: "browserless", port: 3000 },
    vars: [{ key: "TOKEN", generate: "secret", label: "API token" }],
    compose: `services:
  browserless:
    image: ghcr.io/browserless/chromium:latest
    restart: unless-stopped
    environment:
      TOKEN: \${TOKEN}
      CONCURRENT: "5"
`,
  },
  {
    id: "pocketbase",
    name: "PocketBase",
    description: "Open-source backend in one file: database, auth, files and realtime.",
    category: "Developer tools",
    website: "https://pocketbase.io",
    expose: { service: "pocketbase", port: 8090 },
    vars: [],
    note: "Open the link printed in the logs to create the first superuser.",
    compose: `services:
  pocketbase:
    image: ghcr.io/muchobien/pocketbase:latest
    restart: unless-stopped
    volumes:
      - pocketbase-data:/pb_data
${volumes("pocketbase-data")}`,
  },
  {
    id: "appsmith",
    name: "Appsmith",
    description: "Build internal tools and admin panels with drag and drop.",
    category: "Developer tools",
    website: "https://www.appsmith.com",
    expose: { service: "appsmith", port: 80 },
    vars: [],
    compose: `services:
  appsmith:
    image: index.docker.io/appsmith/appsmith-ce:latest
    restart: unless-stopped
    volumes:
      - appsmith-stacks:/appsmith-stacks
${volumes("appsmith-stacks")}`,
  },
  {
    id: "meilisearch",
    name: "Meilisearch",
    description: "Lightning-fast, typo-tolerant search engine with a simple API.",
    category: "Developer tools",
    website: "https://www.meilisearch.com",
    expose: { service: "meilisearch", port: 7700 },
    vars: [{ key: "MEILI_MASTER_KEY", generate: "secret", label: "Master key" }],
    compose: `services:
  meilisearch:
    image: getmeili/meilisearch:latest
    restart: unless-stopped
    environment:
      MEILI_MASTER_KEY: \${MEILI_MASTER_KEY}
      MEILI_ENV: production
    volumes:
      - meili-data:/meili_data
${volumes("meili-data")}`,
  },
  {
    id: "typesense",
    name: "Typesense",
    description: "Open-source, typo-tolerant search engine. An Algolia alternative.",
    category: "Developer tools",
    website: "https://typesense.org",
    expose: { service: "typesense", port: 8108 },
    vars: [{ key: "TYPESENSE_API_KEY", generate: "secret", label: "API key" }],
    compose: `services:
  typesense:
    image: typesense/typesense:28.0
    restart: unless-stopped
    command: ["--data-dir", "/data", "--api-key", "\${TYPESENSE_API_KEY}", "--enable-cors"]
    volumes:
      - typesense-data:/data
${volumes("typesense-data")}`,
  },
  {
    id: "rabbitmq",
    name: "RabbitMQ",
    description: "Message broker with the management UI on the domain.",
    category: "Developer tools",
    website: "https://www.rabbitmq.com",
    expose: { service: "rabbitmq", port: 15672 },
    vars: [
      { key: "RABBITMQ_DEFAULT_USER", value: "admin", label: "Admin user" },
      { key: "RABBITMQ_DEFAULT_PASS", generate: "password", label: "Admin password" },
    ],
    note: "Services connect over AMQP to <stack>-rabbitmq:5672 on the private network.",
    compose: `services:
  rabbitmq:
    image: rabbitmq:4-management
    restart: unless-stopped
    environment:
      RABBITMQ_DEFAULT_USER: \${RABBITMQ_DEFAULT_USER}
      RABBITMQ_DEFAULT_PASS: \${RABBITMQ_DEFAULT_PASS}
    volumes:
      - rabbitmq-data:/var/lib/rabbitmq
${volumes("rabbitmq-data")}`,
  },
  {
    id: "dozzle",
    name: "Dozzle",
    description: "Real-time log viewer for every container on the server.",
    category: "Developer tools",
    website: "https://dozzle.dev",
    expose: { service: "dozzle", port: 8080 },
    vars: [],
    hostAccess: true,
    note: "Reads the Docker socket and has no login by default. Keep the domain private (IP allowlist) or remove it.",
    compose: `services:
  dozzle:
    image: amir20/dozzle:latest
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
`,
  },
  {
    id: "portainer",
    name: "Portainer",
    description: "Web UI to manage containers, images, volumes and networks.",
    category: "Developer tools",
    website: "https://www.portainer.io",
    expose: { service: "portainer", port: 9000 },
    vars: [],
    hostAccess: true,
    note: "Has full control of Docker on the server. Create the admin account within 5 minutes of the first start.",
    compose: `services:
  portainer:
    image: portainer/portainer-ce:lts
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - portainer-data:/data
${volumes("portainer-data")}`,
  },

  /* ------------------------------- Monitoring ------------------------------ */
  {
    id: "uptime-kuma",
    name: "Uptime Kuma",
    description: "Self-hosted uptime monitoring with status pages and alerts.",
    category: "Monitoring",
    website: "https://uptime.kuma.pet",
    popular: true,
    expose: { service: "uptime-kuma", port: 3001 },
    vars: [],
    compose: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:2
    restart: unless-stopped
    volumes:
      - kuma-data:/app/data
${volumes("kuma-data")}`,
  },
  {
    id: "grafana",
    name: "Grafana",
    description: "Dashboards and visualisation for metrics and logs.",
    category: "Monitoring",
    website: "https://grafana.com",
    expose: { service: "grafana", port: 3000 },
    vars: [
      { key: "GF_SECURITY_ADMIN_PASSWORD", generate: "password", label: "Admin password" },
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
${volumes("grafana-data")}`,
  },
  {
    id: "prometheus",
    name: "Prometheus",
    description: "Metrics collection and alerting with a powerful query language.",
    category: "Monitoring",
    website: "https://prometheus.io",
    expose: { service: "prometheus", port: 9090 },
    vars: [],
    note: "Starts with the default config that scrapes itself. The UI has no login; keep the domain private.",
    compose: `services:
  prometheus:
    image: prom/prometheus:latest
    restart: unless-stopped
    volumes:
      - prometheus-data:/prometheus
${volumes("prometheus-data")}`,
  },

  /* ---------------------------------- Storage ------------------------------ */
  {
    id: "minio",
    name: "MinIO",
    description: "S3-compatible object storage. Console exposed on the domain.",
    category: "Storage",
    website: "https://min.io",
    popular: true,
    expose: { service: "minio", port: 9001 },
    vars: [
      { key: "MINIO_ROOT_USER", value: "admin", label: "Root user" },
      { key: "MINIO_ROOT_PASSWORD", generate: "password", label: "Root password" },
    ],
    note: "The S3 API listens on port 9000. Add a second domain for it in Domains & ports.",
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
${volumes("minio-data")}`,
  },
  {
    id: "filebrowser",
    name: "File Browser",
    description: "Upload, organise and share files from a web interface.",
    category: "Storage",
    website: "https://filebrowser.org",
    expose: { service: "filebrowser", port: 80 },
    vars: [],
    note: "The first admin password is printed in the logs on the first start.",
    compose: `services:
  filebrowser:
    image: filebrowser/filebrowser:latest
    restart: unless-stopped
    volumes:
      - filebrowser-files:/srv
      - filebrowser-database:/database
      - filebrowser-config:/config
${volumes("filebrowser-files", "filebrowser-database", "filebrowser-config")}`,
  },
  {
    id: "syncthing",
    name: "Syncthing",
    description: "Continuous peer-to-peer file synchronisation between devices.",
    category: "Storage",
    website: "https://syncthing.net",
    expose: { service: "syncthing", port: 8384 },
    vars: [],
    note: "Set a GUI password first. For direct device connections publish port 22000 (TCP and UDP) in Domains & ports.",
    compose: `services:
  syncthing:
    image: syncthing/syncthing:latest
    restart: unless-stopped
    volumes:
      - syncthing-data:/var/syncthing
${volumes("syncthing-data")}`,
  },
  {
    id: "immich",
    name: "Immich",
    description: "Photo and video backup with face recognition. A Google Photos alternative.",
    category: "Storage",
    website: "https://immich.app",
    popular: true,
    expose: { service: "immich-server", port: 2283 },
    vars: [{ key: "DB_PASSWORD", generate: "password" }],
    note: "Needs about 4 GB of RAM. Machine learning downloads models on first use.",
    compose: `services:
  immich-server:
    image: ghcr.io/immich-app/immich-server:release
    restart: unless-stopped
    environment:
      DB_HOSTNAME: database
      DB_USERNAME: postgres
      DB_PASSWORD: \${DB_PASSWORD}
      DB_DATABASE_NAME: immich
      REDIS_HOSTNAME: redis
    volumes:
      - immich-upload:/data
${healthy("redis", "database")}  immich-machine-learning:
    image: ghcr.io/immich-app/immich-machine-learning:release
    restart: unless-stopped
    volumes:
      - immich-model-cache:/cache
  redis:
    image: valkey/valkey:8-bookworm
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 10
  database:
    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0
    restart: unless-stopped
    shm_size: 128mb
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      POSTGRES_DB: immich
      POSTGRES_INITDB_ARGS: --data-checksums
    volumes:
      - immich-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d immich"]
      interval: 5s
      retries: 20
${volumes("immich-upload", "immich-model-cache", "immich-pgdata")}`,
  },

  /* ----------------------------------- AI ---------------------------------- */
  {
    id: "open-webui",
    name: "Open WebUI",
    description: "ChatGPT-style interface for local models, bundled with Ollama.",
    category: "AI",
    website: "https://openwebui.com",
    popular: true,
    expose: { service: "open-webui", port: 8080 },
    vars: [{ key: "WEBUI_SECRET_KEY", generate: "secret" }],
    note: "The first account you create becomes the admin. Pull a model from Settings → Models.",
    compose: `services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    restart: unless-stopped
    environment:
      OLLAMA_BASE_URL: http://ollama:11434
      WEBUI_SECRET_KEY: \${WEBUI_SECRET_KEY}
    volumes:
      - open-webui-data:/app/backend/data
    depends_on:
      - ollama
  ollama:
    image: ollama/ollama:latest
    restart: unless-stopped
    volumes:
      - ollama-data:/root/.ollama
${volumes("open-webui-data", "ollama-data")}`,
  },
  {
    id: "flowise",
    name: "Flowise",
    description: "Build LLM apps and AI agents with a drag-and-drop editor.",
    category: "AI",
    website: "https://flowiseai.com",
    expose: { service: "flowise", port: 3000 },
    vars: [],
    compose: `services:
  flowise:
    image: flowiseai/flowise:latest
    restart: unless-stopped
    volumes:
      - flowise-data:/root/.flowise
${volumes("flowise-data")}`,
  },

  /* ------------------------------ Communication ---------------------------- */
  {
    id: "mattermost",
    name: "Mattermost",
    description: "Team chat and collaboration. A Slack alternative.",
    category: "Communication",
    website: "https://mattermost.com",
    expose: { service: "mattermost", port: 8065 },
    vars: [
      { key: "POSTGRES_PASSWORD", generate: "password" },
      { key: "SITE_URL", publicUrl: true },
    ],
    compose: `services:
  mattermost:
    image: mattermost/mattermost-team-edition:10.11
    restart: unless-stopped
    environment:
      MM_SQLSETTINGS_DRIVERNAME: postgres
      MM_SQLSETTINGS_DATASOURCE: postgres://mattermost:\${POSTGRES_PASSWORD}@postgres:5432/mattermost?sslmode=disable&connect_timeout=10
      MM_SERVICESETTINGS_SITEURL: \${SITE_URL}
    volumes:
      - mattermost-config:/mattermost/config
      - mattermost-data:/mattermost/data
      - mattermost-logs:/mattermost/logs
      - mattermost-plugins:/mattermost/plugins
      - mattermost-client-plugins:/mattermost/client/plugins
${healthy("postgres")}${postgres("mattermost")}${volumes("mattermost-config", "mattermost-data", "mattermost-logs", "mattermost-plugins", "mattermost-client-plugins", "postgres-data")}`,
  },
  {
    id: "listmonk",
    name: "listmonk",
    description: "Newsletter and mailing list manager with a fast dashboard.",
    category: "Communication",
    website: "https://listmonk.app",
    expose: { service: "listmonk", port: 9000 },
    vars: [
      { key: "POSTGRES_PASSWORD", generate: "password" },
      { key: "LISTMONK_ADMIN_PASSWORD", generate: "password", label: "Admin password" },
    ],
    note: "Sign in as admin with the generated admin password (Variables tab).",
    compose: `services:
  listmonk:
    image: listmonk/listmonk:latest
    restart: unless-stopped
    command: [sh, -c, "./listmonk --install --idempotent --yes --config '' && ./listmonk --upgrade --yes --config '' && ./listmonk --config ''"]
    environment:
      LISTMONK_app__address: 0.0.0.0:9000
      LISTMONK_db__host: postgres
      LISTMONK_db__port: "5432"
      LISTMONK_db__user: listmonk
      LISTMONK_db__password: \${POSTGRES_PASSWORD}
      LISTMONK_db__database: listmonk
      LISTMONK_db__ssl_mode: disable
      LISTMONK_ADMIN_USER: admin
      LISTMONK_ADMIN_PASSWORD: \${LISTMONK_ADMIN_PASSWORD}
      TZ: UTC
    volumes:
      - listmonk-uploads:/listmonk/uploads
${healthy("postgres")}${postgres("listmonk")}${volumes("listmonk-uploads", "postgres-data")}`,
  },
  {
    id: "ntfy",
    name: "ntfy",
    description: "Send push notifications to your phone or desktop over HTTP.",
    category: "Communication",
    website: "https://ntfy.sh",
    expose: { service: "ntfy", port: 80 },
    vars: [{ key: "NTFY_BASE_URL", publicUrl: true }],
    compose: `services:
  ntfy:
    image: binwiederhier/ntfy:latest
    restart: unless-stopped
    command: serve
    environment:
      NTFY_BASE_URL: \${NTFY_BASE_URL}
      NTFY_CACHE_FILE: /var/cache/ntfy/cache.db
      NTFY_BEHIND_PROXY: "true"
    volumes:
      - ntfy-cache:/var/cache/ntfy
${volumes("ntfy-cache")}`,
  },
  {
    id: "gotify",
    name: "Gotify",
    description: "Simple server for sending and receiving push messages.",
    category: "Communication",
    website: "https://gotify.net",
    expose: { service: "gotify", port: 80 },
    vars: [{ key: "GOTIFY_DEFAULTUSER_PASS", generate: "password", label: "Admin password" }],
    note: "Sign in as admin with the generated admin password (Variables tab).",
    compose: `services:
  gotify:
    image: gotify/server:latest
    restart: unless-stopped
    environment:
      GOTIFY_DEFAULTUSER_NAME: admin
      GOTIFY_DEFAULTUSER_PASS: \${GOTIFY_DEFAULTUSER_PASS}
    volumes:
      - gotify-data:/app/data
${volumes("gotify-data")}`,
  },

  /* --------------------------------- Security ------------------------------ */
  {
    id: "vaultwarden",
    name: "Vaultwarden",
    description: "Bitwarden-compatible password manager server.",
    category: "Security",
    website: "https://github.com/dani-garcia/vaultwarden",
    popular: true,
    expose: { service: "vaultwarden", port: 80 },
    vars: [
      { key: "DOMAIN", publicUrl: true },
      { key: "ADMIN_TOKEN", generate: "secret", label: "Admin token" },
    ],
    note: "Bitwarden apps require HTTPS. Keep HTTPS on for the domain.",
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
${volumes("vw-data")}`,
  },
  {
    id: "keycloak",
    name: "Keycloak",
    description: "Identity and access management: SSO, OAuth 2.0, OpenID Connect and SAML.",
    category: "Security",
    website: "https://www.keycloak.org",
    expose: { service: "keycloak", port: 8080 },
    vars: [
      { key: "POSTGRES_PASSWORD", generate: "password" },
      { key: "KC_BOOTSTRAP_ADMIN_PASSWORD", generate: "password", label: "Admin password" },
      { key: "KC_HOSTNAME", publicUrl: true },
    ],
    note: "Sign in as admin with the generated admin password (Variables tab).",
    compose: `services:
  keycloak:
    image: quay.io/keycloak/keycloak:latest
    restart: unless-stopped
    command: start
    environment:
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://postgres:5432/keycloak
      KC_DB_USERNAME: keycloak
      KC_DB_PASSWORD: \${POSTGRES_PASSWORD}
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: \${KC_BOOTSTRAP_ADMIN_PASSWORD}
      KC_HOSTNAME: \${KC_HOSTNAME}
      KC_HTTP_ENABLED: "true"
      KC_PROXY_HEADERS: xforwarded
      KC_HEALTH_ENABLED: "true"
${healthy("postgres")}${postgres("keycloak")}${volumes("postgres-data")}`,
  },

  /* ---------------------------------- Media -------------------------------- */
  {
    id: "jellyfin",
    name: "Jellyfin",
    description: "Stream your movies, shows and music. A Plex alternative.",
    category: "Media",
    website: "https://jellyfin.org",
    popular: true,
    expose: { service: "jellyfin", port: 8096 },
    vars: [],
    note: "Put media in the jellyfin-media volume, or replace it with a directory mount in Persistent storage.",
    compose: `services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    restart: unless-stopped
    volumes:
      - jellyfin-config:/config
      - jellyfin-cache:/cache
      - jellyfin-media:/media
${volumes("jellyfin-config", "jellyfin-cache", "jellyfin-media")}`,
  },
  {
    id: "navidrome",
    name: "Navidrome",
    description: "Music server and streamer compatible with Subsonic apps.",
    category: "Media",
    website: "https://www.navidrome.org",
    expose: { service: "navidrome", port: 4533 },
    vars: [],
    compose: `services:
  navidrome:
    image: deluan/navidrome:latest
    restart: unless-stopped
    volumes:
      - navidrome-data:/data
      - navidrome-music:/music
${volumes("navidrome-data", "navidrome-music")}`,
  },
  {
    id: "audiobookshelf",
    name: "Audiobookshelf",
    description: "Audiobook and podcast server with mobile apps.",
    category: "Media",
    website: "https://www.audiobookshelf.org",
    expose: { service: "audiobookshelf", port: 80 },
    vars: [],
    compose: `services:
  audiobookshelf:
    image: ghcr.io/advplyr/audiobookshelf:latest
    restart: unless-stopped
    volumes:
      - abs-config:/config
      - abs-metadata:/metadata
      - abs-audiobooks:/audiobooks
      - abs-podcasts:/podcasts
${volumes("abs-config", "abs-metadata", "abs-audiobooks", "abs-podcasts")}`,
  },

  /* -------------------------------- Databases ------------------------------ */
  {
    id: "pgadmin",
    name: "pgAdmin",
    description: "Web administration tool for PostgreSQL.",
    category: "Databases",
    website: "https://www.pgadmin.org",
    expose: { service: "pgadmin", port: 80 },
    vars: [
      { key: "PGADMIN_DEFAULT_EMAIL", value: "admin@example.com", label: "Login email" },
      { key: "PGADMIN_DEFAULT_PASSWORD", generate: "password", label: "Login password" },
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
${volumes("pgadmin-data")}`,
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
    id: "redisinsight",
    name: "Redis Insight",
    description: "Visual browser, profiler and CLI for Redis and Valkey.",
    category: "Databases",
    website: "https://redis.io/insight",
    expose: { service: "redisinsight", port: 5540 },
    vars: [],
    compose: `services:
  redisinsight:
    image: redis/redisinsight:latest
    restart: unless-stopped
    volumes:
      - redisinsight-data:/data
${volumes("redisinsight-data")}`,
  },
];

export function getTemplate(id: string) {
  return templates.find((t) => t.id === id) ?? null;
}

export { composeVariables } from "@/lib/compose-vars";
