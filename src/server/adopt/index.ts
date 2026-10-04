import { and, eq, inArray, sql } from "drizzle-orm";
import { UserError } from "@/server/action";
import { db, schema } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { LABEL, execInContainer } from "@/server/docker/client";
import { newId } from "@/server/id";
import { HOSTNAME_RE } from "@/lib/hostname";
import { engines } from "@/server/databases/engines";
import { getServer, type ServerCtx } from "@/server/servers/context";
import { isSystemContainer } from "@/server/servers/resources";
import { newWebhookSecret, queueDeployment, uniqueServiceName, uniqueServiceSlug } from "@/server/services/create";
import { defaultRuntime, type RuntimeConfig } from "@/server/services/types";
import { toServiceName } from "@/lib/service-name";
import { type AdoptPlan, choosePort, listeningPorts, planAdoption } from "./plan";
import { type GitAfter, retiredName } from "./handoff";
import { volumeName } from "@/server/deploy/containers";
import { volumesFor } from "@/server/deploy/image-volumes";

export type { AdoptPlan } from "./plan";

/** Reads a container made outside Serve and plans the service that takes its place. */
export async function adoptionPlan(server: ServerCtx, containerId: string): Promise<AdoptPlan> {
  const info = await server.docker
    .getContainer(containerId)
    .inspect()
    .catch(() => null);
  if (!info) throw new UserError("Container not found.");
  const name = info.Name.replace(/^\//, "");
  const labels = info.Config.Labels ?? {};
  if (labels[LABEL.service]) throw new UserError("This container already belongs to a Serve service.");
  if (isSystemContainer(labels, name)) throw new UserError("Serve's own containers cannot be moved.");
  const image = await server.docker
    .getImage(info.Image)
    .inspect()
    .catch(() => null);
  const plan = planAdoption(info, image);
  // The image's declared port is a guess: the running container says which ones it listens on.
  if (plan.container.running) {
    const proc = await execInContainer(info.Id, ["cat", "/proc/net/tcp", "/proc/net/tcp6"], {}, server.docker).catch(() => null);
    if (proc?.output.includes("local_address")) {
      const before = plan.port;
      plan.port = choosePort(plan.port, listeningPorts(proc.output), plan.exposed);
      if (before && !plan.port) plan.notes.push(`It does not listen on port ${before}: Serve checks that it keeps running instead.`);
    }
  }
  // Serve's own networks are joined the normal way, never as outside networks.
  plan.networks = plan.networks.filter((n) => !/^serve($|[-_])/.test(n.name) && n.name !== server.network);
  if (name.endsWith(retiredName(""))) plan.blockers.push("This container was replaced by a Serve service already.");
  if (!image) plan.notes.push("Its image is not on the server any more by name; Serve runs it by its id.");
  // Data already used by a service: two containers on one data directory corrupt it.
  const outside = new Set([...plan.volumes.filter((v) => v.external || v.kind === "bind").map((v) => v.source)]);
  if (outside.size) {
    const rows = await db
      .select({ name: schema.service.name, runtime: schema.service.runtime, database: schema.service.database })
      .from(schema.service)
      .where(eq(schema.service.serverId, server.id));
    const user = rows.find((r) => (r.database?.dataVolume && outside.has(r.database.dataVolume)) || r.runtime.volumes.some((v) => v.external && outside.has(v.source)));
    if (user) plan.blockers.push(`Its data is used by the service ${user.name} already.`);
  }
  const [busy] = await db
    .select({ id: schema.deployment.id })
    .from(schema.deployment)
    .where(and(sql`${schema.deployment.adopt}->>'containerId' = ${info.Id}`, inArray(schema.deployment.status, ["queued", "building", "deploying"])))
    .limit(1);
  if (busy) plan.blockers.push("A move of this container is running already.");
  return plan;
}

/** Signs in to the running database with the password found (or typed): true when it is right. */
export async function checkDatabaseLogin(server: ServerCtx, plan: AdoptPlan, password: string) {
  const d = plan.database;
  if (!d) return false;
  const run = (script: string) =>
    execInContainer(plan.container.id, ["sh", "-c", script], { env: [`SERVE_PW=${password}`, `SERVE_USER=${d.username}`, `SERVE_DB=${d.database}`] }, server.docker)
      .then((r) => r.exitCode === 0 && /serve-ok/.test(r.output))
      .catch(() => false);
  if (d.engine === "postgres") {
    // Over TCP on its own address: the image trusts the socket and loopback without a password.
    return run(`IP=$(hostname -i 2>/dev/null | awk '{print $1}'); PGPASSWORD="$SERVE_PW" psql -X -h "\${IP:-127.0.0.1}" -U "$SERVE_USER" -d "$SERVE_DB" -tAc "select 'serve-ok'"`);
  }
  if (d.engine === "mysql" || d.engine === "mariadb") {
    return run(`C=$(command -v mariadb || command -v mysql); MYSQL_PWD="$SERVE_PW" "$C" -h127.0.0.1 -uroot -N -e "select 'serve-ok'"`);
  }
  if (d.engine === "redis" || d.engine === "valkey") {
    return run(`C=$(command -v ${d.engine}-cli || command -v redis-cli); R=$(REDISCLI_AUTH="$SERVE_PW" "$C" ping 2>&1); [ "$R" = PONG ] && echo serve-ok`);
  }
  if (d.engine === "mongodb") {
    return run(
      `C=$(command -v mongosh || command -v mongo); "$C" --quiet -u "$SERVE_USER" -p "$SERVE_PW" --authenticationDatabase admin --eval "if (db.runCommand({ ping: 1 }).ok) print('serve-ok')"`,
    );
  }
  return false;
}

/** A private name for the service: the container's, unless another service answers to it already. */
async function freeHostname(environmentId: string, wanted: string | null) {
  if (!wanted || !HOSTNAME_RE.test(wanted) || wanted.startsWith("serve-")) return null;
  const all = await db.select({ environmentId: schema.service.environmentId, slug: schema.service.slug, hostname: schema.service.hostname }).from(schema.service);
  const taken = all.some((x) => x.slug === wanted || wanted.startsWith(`${x.slug}-`) || (x.environmentId === environmentId && x.hostname === wanted));
  return taken ? null : wanted;
}

export type AdoptInput = {
  serverId: string;
  containerId: string;
  projectId: string;
  environmentId: string;
  name?: string;
  as: "database" | "container";
  /** move: the service takes over the container's data and names. copy: it keeps running; the service gets a copy of its data. */
  mode: "move" | "copy";
  /** The database password, when the one in its variables is wrong or missing. */
  password?: string;
  /** Containers: deploy from this repository after the move (the move itself runs the image as it is). */
  git?: GitAfter | null;
  userId: string;
};

/** Creates the service and queues the deployment that takes over from the container, or copies it. */
export async function adoptContainer(input: AdoptInput, reserved: { cpuLimit: number | null; memoryLimit: number | null }) {
  const server = await getServer(input.serverId);
  const plan = await adoptionPlan(server, input.containerId);
  if (plan.blockers.length) throw new UserError(plan.blockers[0]);
  const asDatabase = input.as === "database";
  const copy = input.mode === "copy";
  if (asDatabase && !plan.database) throw new UserError(plan.databaseProblems[0] ?? "This container cannot move as a database. Move it as a container.");
  const password = input.password || plan.database?.password || "";
  if (asDatabase && !(await checkDatabaseLogin(server, plan, password))) {
    throw new UserError("Serve could not sign in to the database with this password. Type the right one, or use it as a container.");
  }

  const id = newId();
  const name = await uniqueServiceName(input.environmentId, toServiceName(input.name || plan.container.name) || "service");
  const slug = await uniqueServiceSlug(name);
  const hostname = await freeHostname(input.environmentId, plan.hostname);
  let copied: { from: string; to: string }[] = [];
  const base: Partial<RuntimeConfig> = {
    // A copy is reached by its name in the project only: on the old networks, the original answers.
    networks: copy ? [] : plan.networks,
    memoryLimit: plan.memoryLimit ?? reserved.memoryLimit,
    cpuLimit: plan.cpuLimit ?? reserved.cpuLimit,
    shmSize: plan.shmSize,
    privileged: plan.privileged,
    capAdd: plan.capAdd,
    capDrop: plan.capDrop,
    noNewPrivileges: plan.noNewPrivileges,
    securityOpt: plan.securityOpt,
    cpuset: plan.cpuset,
    cpuWeight: plan.cpuWeight,
    swapLimit: plan.swapLimit,
    extraHosts: plan.extraHosts,
  };

  if (asDatabase) {
    const d = plan.database!;
    const engine = engines[d.engine];
    await db.insert(schema.service).values({
      id,
      projectId: input.projectId,
      environmentId: input.environmentId,
      serverId: server.id,
      name,
      slug,
      hostname,
      type: "database",
      runtime: {
        ...defaultRuntime(engine.port),
        ...base,
        restartPolicy: plan.restartPolicy === "no" ? "unless-stopped" : plan.restartPolicy,
        // A copy keeps only read-only folders (settings) of the original; its data is its own.
        volumes: copy ? d.volumes.filter((v) => v.kind === "bind" && v.readOnly) : d.volumes,
      },
      database: {
        engine: d.engine,
        version: d.version,
        image: plan.image,
        username: d.username,
        password: encrypt(password),
        database: d.database,
        // A copy starts on a volume of its own, laid out as Serve lays out new databases.
        ...(copy ? {} : { dataVolume: d.dataVolume, dataMountPath: d.dataMountPath, pgdata: d.pgdata }),
        extraArgs: d.extraArgs,
        // The original keeps its host port.
        publicPort: copy ? null : d.publicPort,
        publicBind: copy ? undefined : d.publicBind,
        backupSchedule: null,
        backupRetention: 7,
        s3DestinationId: null,
      },
      webhookSecret: newWebhookSecret(),
    });
  } else {
    // A copy gets volumes of its own, filled from the original's before the first start. Folders on
    // the server stay shared: two containers may use the same folder, and Serve cannot tell a file from one.
    const own = copy
      ? volumesFor(
          plan.volumes.filter((v) => v.external).map((v) => v.mountPath),
          [],
        )
      : [];
    const volumes = copy ? [...plan.volumes.filter((v) => !v.external), ...own] : plan.volumes;
    copied = copy ? plan.volumes.filter((v) => v.external).map((v, i) => ({ from: v.source, to: volumeName(slug, own[i].source) })) : [];
    await db.insert(schema.service).values({
      id,
      projectId: input.projectId,
      environmentId: input.environmentId,
      serverId: server.id,
      name,
      slug,
      hostname,
      type: "app",
      source: { type: "image", image: plan.image, registryId: null, registryUsername: null, registryPassword: null },
      build: null,
      runtime: {
        ...defaultRuntime(plan.port),
        ...base,
        restartPolicy: plan.restartPolicy,
        volumes,
        // The original keeps its host ports.
        ports: copy ? [] : plan.ports,
        entrypoint: plan.entrypoint,
        workingDir: plan.workingDir,
        user: plan.user,
        init: plan.init,
        // The image is on the server already, and may exist nowhere else.
        pullPolicy: "missing",
        detectPort: false,
      },
      webhookSecret: newWebhookSecret(),
    });
    if (plan.env.length) {
      await db.insert(schema.envVar).values(plan.env.map((v) => ({ id: newId(), serviceId: id, key: v.key, value: encrypt(v.value), buildTime: false, runtime: true })));
    }
  }
  const deploymentId = await queueDeployment(id, "create", {
    userId: input.userId,
    adopt: {
      containerId: plan.container.id,
      name: plan.container.name,
      ...(copy ? { mode: "copy" as const, volumes: copied } : {}),
      ...(!asDatabase && input.git ? { git: input.git } : {}),
    },
  });
  return { id, name, deploymentId };
}
