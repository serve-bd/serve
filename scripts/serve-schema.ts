/**
 * Writes public/schema/serve.json, the JSON Schema editors use for serve.json ($schema), from the
 * same rules deploys check the file with.
 *   pnpm serve-schema          write it
 *   pnpm serve-schema --check  fail when it is out of date (CI)
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SERVE_CONFIG_SCHEMA_URL, serveConfigSchema } from "../src/lib/serve-config";

export const SCHEMA_FILE = path.resolve(__dirname, "../public/schema/serve.json");

/** Hover help in editors, by setting. */
const HELP: Record<string, string> = {
  "": "Settings of a Serve app, kept next to its code. Each new deploy applies them; a change made in the dashboard lasts until the next deploy (a redeploy keeps it).",
  build: "How the image is built.",
  "build.builder": "auto picks one from the files; dockerfile, nixpacks, railpack, buildpacks or static to choose.",
  "build.dockerfile": "Dockerfile path inside the root directory, like docker/Dockerfile.",
  "build.target": "Stage of a multi-stage Dockerfile to build.",
  "build.buildpacksBuilder": "Builder image for Cloud Native Buildpacks (default heroku/builder:24).",
  "build.installCommand": "Install step for nixpacks and railpack builds.",
  "build.buildCommand": "Build step for nixpacks, railpack and static builds.",
  "build.startCommand": "Start command baked into nixpacks and railpack images.",
  "build.publishDir": "Folder with the built site, for static builds.",
  "build.args": "Docker build arguments. Not for secrets: use build-time variables in the dashboard.",
  "build.noCache": "Always build without the layer cache.",
  "build.timeoutMinutes": "Stop a build that runs longer (minutes).",
  "build.submodules": "Clone Git submodules (default true).",
  "build.watchPaths": "Only pushes that change a matching path deploy (globs; !path excludes). A change to serve.json always deploys.",
  deploy: "How the app is started and replaced.",
  "deploy.startCommand": "Command the container runs, replacing the image's.",
  "deploy.entrypoint": "Entrypoint, replacing the image's, as a list of arguments.",
  "deploy.workingDir": "Working directory in the container.",
  "deploy.user": "User to run as, like node or 1000:1000.",
  "deploy.port": "Port the app listens on.",
  "deploy.replicas": "Containers to run; traffic is balanced across them.",
  "deploy.strategy": "rolling starts the new version before stopping the old one (no downtime); recreate stops first.",
  "deploy.drainSeconds": "Seconds old containers keep serving requests that are in flight.",
  "deploy.preDeployCommand": "Runs once in a container of the new version before traffic switches, like migrations. A failure keeps the old version.",
  "deploy.postDeployCommand": "Runs once in the new version after it is live.",
  "deploy.restartPolicy": "When Docker restarts a stopped container.",
  "deploy.crashLimit": "Stop a replica after this many crashes in a row; null restarts it forever.",
  "deploy.stopSignal": "Signal sent to stop the container.",
  "deploy.stopTimeout": "Seconds to shut down before the container is killed.",
  "deploy.init": "Run an init process that reaps zombie processes.",
  "deploy.restartSchedule": "Restart on a schedule (cron, server time zone), like 0 4 * * *.",
  healthcheck: "How a new version is checked before it gets traffic.",
  "healthcheck.path": "Path to request, like /health. Without one, the deploy waits for the port.",
  "healthcheck.port": "Port to check (default: the app port).",
  "healthcheck.timeout": "Seconds before giving up and keeping the old version.",
  "healthcheck.interval": "Seconds between checks.",
  "healthcheck.startPeriod": "Seconds to wait before the first check.",
  "healthcheck.status": "Statuses that pass, like 200-399 (default: below 500).",
  "healthcheck.successes": "Passing checks in a row that are needed.",
  resources: "Limits per container.",
  "resources.cpu": "CPU cores, like 0.5 or 2.",
  "resources.memory": "Memory limit in MB; the container stops above it.",
  "resources.memoryReservation": "Memory in MB kept free for it under pressure.",
  "resources.shm": "Size of /dev/shm in MB.",
  "resources.logMaxSizeMb": "Size of a log file before it rotates (MB).",
  "resources.logMaxFiles": "Log files kept.",
  tasks: "Scheduled tasks: commands run in the app's container on a cron schedule. Known by name; one removed here is removed on the next deploy.",
  volumes: "Named volumes: data kept across deploys.",
  files: "Files written into the container (read-only), like a config file.",
  variables: "Variables the app needs. Values stay in the dashboard.",
  "variables.required": "Names that must have a value: the deploy stops before building when one is missing.",
};

function describe(node: Record<string, unknown>, at: string) {
  if (HELP[at]) node.description = HELP[at];
  const props = node.properties as Record<string, Record<string, unknown>> | undefined;
  for (const [k, v] of Object.entries(props ?? {})) describe(v, at ? `${at}.${k}` : k);
  const items = node.items as Record<string, unknown> | undefined;
  if (items && typeof items === "object") describe(items, `${at}[]`);
}

export function serveSchemaText() {
  const schema = z.toJSONSchema(serveConfigSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  describe(schema, "");
  return `${JSON.stringify({ ...schema, $id: SERVE_CONFIG_SCHEMA_URL, title: "Serve app settings (serve.json)" }, null, 2)}\n`;
}

if (require.main === module) {
  const text = serveSchemaText();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(SCHEMA_FILE) ? fs.readFileSync(SCHEMA_FILE, "utf8") : "";
    if (current !== text) {
      console.error("public/schema/serve.json is out of date: run pnpm serve-schema and commit it.");
      process.exit(1);
    }
    console.log("serve.json schema OK.");
  } else {
    fs.mkdirSync(path.dirname(SCHEMA_FILE), { recursive: true });
    fs.writeFileSync(SCHEMA_FILE, text);
    console.log(`Wrote ${path.relative(process.cwd(), SCHEMA_FILE)}.`);
  }
}
