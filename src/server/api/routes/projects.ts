import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { logsFrom } from "@/lib/log-offset";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import * as projects from "@/server/actions/projects";
import * as environments from "@/server/actions/environments";
import * as services from "@/server/actions/services";
import * as sharedVars from "@/server/actions/shared-vars";
import * as move from "@/server/actions/move";
import { approveDeployment, rejectDeployment, saveDeployRules } from "@/server/actions/deploy-rules";
import type { DeployRules } from "@/lib/deploy-rules";
import { deploymentView, environmentView, loadDeployment, loadEnvironment, loadProject, loadServer, projectFilter, projectView, serviceView } from "../data";
import { ApiError, type ApiRoute, assertCan, route, unwrap } from "../router";

/** A deployment that no longer waits, or a freeze, is a conflict with its state, not a bad request. */
const waitConflict = (e: unknown): never => {
  if (e instanceof ApiError && e.status === 400 && /not waiting for approval|frozen/i.test(e.message)) throw new ApiError(409, e.message);
  throw e;
};

/** A project's deploy rules with every field filled in: what the settings page shows. */
function rulesView(project: { deployRules: DeployRules | null }) {
  const r = project.deployRules ?? {};
  const now = r.freeze?.now ?? null;
  return {
    approval: { enabled: r.approval?.enabled ?? false, environmentIds: r.approval?.environmentIds ?? [] },
    freeze: {
      now: now ? { since: now.since, until: now.until ?? null, reason: now.reason ?? null } : null,
      windows: r.freeze?.windows ?? [],
      timezone: r.freeze?.timezone || "UTC",
      environmentIds: r.freeze?.environmentIds ?? [],
    },
  };
}

const projectBody = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(300).nullable().optional(),
  color: z.string().optional().describe("One of the dashboard's project colors."),
  groupServices: z.boolean().optional(),
});
const sharedVarList = z.array(z.object({ key: z.string(), value: z.string() })).max(500);

async function sharedVarsOf(where: ReturnType<typeof eq>, withValues: boolean) {
  const rows = await db.select().from(schema.sharedVar).where(where).orderBy(asc(schema.sharedVar.key));
  return rows.map((r) => ({ key: r.key, ...(withValues ? { value: decryptOrNull(r.value) ?? "" } : {}) }));
}

export const projectRoutes: ApiRoute[] = [
  route({
    method: "GET",
    path: "/projects",
    tag: "Projects",
    summary: "List projects",
    needs: ["projects.view"],
    handler: async ({ auth }) => {
      const rows = await db
        .select()
        .from(schema.project)
        .where(and(eq(schema.project.organizationId, auth.organizationId), projectFilter(auth)))
        .orderBy(asc(schema.project.name));
      return { projects: rows.map(projectView) };
    },
  }),
  route({
    method: "POST",
    path: "/projects",
    tag: "Projects",
    summary: "Create a project",
    description: "It starts with one environment, production.",
    needs: ["projects.manage"],
    body: projectBody,
    status: 201,
    handler: async ({ auth, body }) => {
      const { id } = await unwrap(projects.createProject(body));
      const env = await db.select().from(schema.environment).where(eq(schema.environment.projectId, id));
      return { project: projectView(await loadProject({ ...auth, canAccessProject: () => true }, id)), environments: env.map(environmentView) };
    },
  }),
  route({
    method: "GET",
    path: "/projects/{projectId}",
    tag: "Projects",
    summary: "Get a project",
    description: "The project with its environments and services.",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      const project = await loadProject(auth, params.projectId);
      const [envs, rows] = await Promise.all([
        db.select().from(schema.environment).where(eq(schema.environment.projectId, project.id)).orderBy(asc(schema.environment.createdAt)),
        db.select().from(schema.service).where(eq(schema.service.projectId, project.id)).orderBy(asc(schema.service.name)),
      ]);
      return { project: { ...projectView(project), environments: envs.map(environmentView), services: rows.map((s) => serviceView(s, project)) } };
    },
  }),
  route({
    method: "PATCH",
    path: "/projects/{projectId}",
    tag: "Projects",
    summary: "Change a project",
    needs: ["projects.manage"],
    body: projectBody.partial(),
    handler: async ({ auth, params, body }) => {
      const project = await loadProject(auth, params.projectId);
      await unwrap(projects.updateProject(project.id, { name: project.name, description: project.description, color: project.color, ...body }));
      return { project: projectView(await loadProject(auth, project.id)) };
    },
  }),
  route({
    method: "DELETE",
    path: "/projects/{projectId}",
    tag: "Projects",
    summary: "Delete a project",
    description: "Only an empty project: delete or move its services first.",
    needs: ["projects.manage"],
    handler: async ({ auth, params }) => {
      await loadProject(auth, params.projectId);
      await unwrap(projects.deleteProject(params.projectId));
      return { ok: true };
    },
  }),
  route({
    method: "GET",
    path: "/projects/{projectId}/variables",
    tag: "Variables",
    summary: "List the project's shared variables",
    description: "Values need variables.view-secrets. Services use them as ${{project.KEY}}.",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      await loadProject(auth, params.projectId);
      return { variables: await sharedVarsOf(eq(schema.sharedVar.projectId, params.projectId), auth.can("variables.view-secrets")) };
    },
  }),
  route({
    method: "PUT",
    path: "/projects/{projectId}/variables",
    tag: "Variables",
    summary: "Replace the project's shared variables",
    description: "redeploy: true then redeploys the running services that use ${{project.…}} (needs services.deploy too).",
    needs: ["variables.edit", "variables.view-secrets"],
    body: z.object({ variables: sharedVarList, redeploy: z.boolean().default(false) }),
    handler: async ({ auth, params, body }) => {
      if (body.redeploy) assertCan(auth, "services.deploy");
      await loadProject(auth, params.projectId);
      await unwrap(sharedVars.saveProjectSharedVars(params.projectId, body.variables));
      return { ok: true, redeployed: body.redeploy ? (await unwrap(sharedVars.redeployReferencing({ projectId: params.projectId }))).count : 0 };
    },
  }),

  // Deploy rules
  route({
    method: "GET",
    path: "/projects/{projectId}/deploy-rules",
    tag: "Deployments",
    summary: "A project's deploy rules",
    description: "approval: whether deploys of the environments listed (empty: every environment) wait for approval. freeze: frozen now (now), or in weekly windows in timezone.",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => ({ rules: rulesView(await loadProject(auth, params.projectId)) }),
  }),
  route({
    method: "PATCH",
    path: "/projects/{projectId}/deploy-rules",
    tag: "Deployments",
    summary: "Change a project's deploy rules",
    description:
      "Fields left out keep their value. freeze.now {until?, reason?} freezes deploys now (until an ISO 8601 time, or until turned off), null ends the freeze. windows: [{days (0 Sunday to 6 Saturday), start, end (like 22:00)}] in timezone (an IANA zone). environmentIds: the environments a rule holds for, empty for every one.",
    needs: ["projects.manage"],
    body: z.object({
      approval: z.object({ enabled: z.boolean().optional(), environmentIds: z.array(z.string()).optional() }).optional(),
      freeze: z
        .object({
          now: z.object({ until: z.string().nullable().optional(), reason: z.string().nullable().optional() }).nullable().optional(),
          windows: z.array(z.object({ days: z.array(z.number().int()), start: z.string(), end: z.string() })).optional(),
          timezone: z.string().optional(),
          environmentIds: z.array(z.string()).optional(),
        })
        .optional(),
    }),
    handler: async ({ auth, params, body }) => {
      const current = rulesView(await loadProject(auth, params.projectId));
      const now = body.freeze?.now === undefined ? current.freeze.now : body.freeze.now;
      await unwrap(
        saveDeployRules(params.projectId, {
          approval: {
            enabled: body.approval?.enabled ?? current.approval.enabled,
            environmentIds: body.approval?.environmentIds ?? current.approval.environmentIds,
          },
          freeze: {
            now: now ? { until: now.until ?? null, reason: now.reason ?? null } : null,
            windows: body.freeze?.windows ?? current.freeze.windows,
            timezone: body.freeze?.timezone ?? current.freeze.timezone,
            environmentIds: body.freeze?.environmentIds ?? current.freeze.environmentIds,
          },
        }),
      );
      return { rules: rulesView(await loadProject(auth, params.projectId)) };
    },
  }),

  // Environments
  route({
    method: "GET",
    path: "/projects/{projectId}/environments",
    tag: "Environments",
    summary: "List environments",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      await loadProject(auth, params.projectId);
      const rows = await db.select().from(schema.environment).where(eq(schema.environment.projectId, params.projectId)).orderBy(asc(schema.environment.createdAt));
      return { environments: rows.map(environmentView) };
    },
  }),
  route({
    method: "POST",
    path: "/projects/{projectId}/environments",
    tag: "Environments",
    summary: "Create an environment",
    description: "An empty one. To copy another environment, use POST /environments/{environmentId}/clone.",
    needs: ["projects.manage"],
    body: z.object({ name: z.string() }),
    status: 201,
    handler: async ({ auth, params, body }) => {
      await loadProject(auth, params.projectId);
      const { id } = await unwrap(projects.createEnvironment(params.projectId, body.name));
      return { environment: environmentView((await loadEnvironment(auth, id)).environment) };
    },
  }),
  route({
    method: "GET",
    path: "/environments/{environmentId}",
    tag: "Environments",
    summary: "Get an environment",
    description: "The environment with its services.",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      const { environment, project } = await loadEnvironment(auth, params.environmentId);
      const rows = await db.select().from(schema.service).where(eq(schema.service.environmentId, environment.id)).orderBy(asc(schema.service.name));
      return { environment: { ...environmentView(environment), services: rows.map((s) => serviceView(s, project)) } };
    },
  }),
  route({
    method: "DELETE",
    path: "/environments/{environmentId}",
    tag: "Environments",
    summary: "Delete an environment",
    needs: ["projects.manage"],
    handler: async ({ auth, params }) => {
      await loadEnvironment(auth, params.environmentId);
      await unwrap(projects.deleteEnvironment(params.environmentId));
      return { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/environments/{environmentId}/clone",
    tag: "Environments",
    summary: "Clone an environment",
    description: "A new environment with copies of every service. generatedDomains: give the copies addresses of their own. copyData: copy database data too.",
    needs: ["projects.manage"],
    body: z.object({ name: z.string(), generatedDomains: z.boolean().optional(), copyData: z.boolean().optional() }),
    status: 201,
    handler: async ({ auth, params, body }) => {
      await loadEnvironment(auth, params.environmentId);
      return (await unwrap(environments.cloneEnvironmentAction(params.environmentId, body))) ?? { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/environments/{environmentId}/deploy",
    tag: "Environments",
    summary: "Deploy every service of an environment",
    needs: ["services.deploy"],
    status: 202,
    handler: async ({ auth, params }) => {
      await loadEnvironment(auth, params.environmentId);
      return unwrap(environments.deployEnvironment(params.environmentId));
    },
  }),
  route({
    method: "GET",
    path: "/environments/{environmentId}/variables",
    tag: "Variables",
    summary: "List the environment's shared variables",
    description: "Values need variables.view-secrets. Services use them as ${{shared.KEY}}.",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      await loadEnvironment(auth, params.environmentId);
      return { variables: await sharedVarsOf(eq(schema.sharedVar.environmentId, params.environmentId), auth.can("variables.view-secrets")) };
    },
  }),
  route({
    method: "PUT",
    path: "/environments/{environmentId}/variables",
    tag: "Variables",
    summary: "Replace the environment's shared variables",
    needs: ["variables.edit"],
    body: z.object({ variables: sharedVarList, redeploy: z.boolean().default(false) }),
    handler: async ({ auth, params, body }) => {
      await loadEnvironment(auth, params.environmentId);
      if (body.redeploy) assertCan(auth, "services.deploy");
      await unwrap(projects.saveSharedVars(params.environmentId, body.variables));
      const deployed = body.redeploy ? await unwrap(projects.redeployEnvironment(params.environmentId)) : null;
      return { ok: true, redeployed: deployed?.count ?? 0 };
    },
  }),
  route({
    method: "POST",
    path: "/services/move",
    tag: "Services",
    summary: "Move services to another environment",
    description: "dryRun: true only lists what would change.",
    needs: ["services.manage"],
    body: z.object({ serviceIds: z.array(z.string()).min(1).max(100), environmentId: z.string(), dryRun: z.boolean().optional() }),
    handler: async ({ auth, body }) => {
      await loadEnvironment(auth, body.environmentId);
      if (body.dryRun) return { plan: await unwrap(move.planServiceMove(body.serviceIds, body.environmentId)) };
      return (await unwrap(move.moveServicesTo(body.serviceIds, body.environmentId))) ?? { ok: true };
    },
  }),

  // Organization-wide shared variables
  route({
    method: "GET",
    path: "/variables",
    tag: "Variables",
    summary: "List the organization's shared variables",
    description: "Values need variables.view-secrets. Services use them as ${{org.KEY}}.",
    needs: ["projects.view"],
    handler: async ({ auth }) => ({ variables: await sharedVarsOf(eq(schema.sharedVar.organizationId, auth.organizationId), auth.can("variables.view-secrets")) }),
  }),
  route({
    method: "PUT",
    path: "/variables",
    tag: "Variables",
    summary: "Replace the organization's shared variables",
    description: "redeploy: true then redeploys the running services that use ${{org.…}} (needs services.deploy too).",
    needs: ["admin"],
    body: z.object({ variables: sharedVarList, redeploy: z.boolean().default(false) }),
    handler: async ({ auth, body }) => {
      if (body.redeploy) assertCan(auth, "services.deploy");
      await unwrap(sharedVars.saveOrgSharedVars(body.variables));
      return { ok: true, redeployed: body.redeploy ? (await unwrap(sharedVars.redeployReferencing("org"))).count : 0 };
    },
  }),
  route({
    method: "GET",
    path: "/servers/{serverId}/variables",
    tag: "Variables",
    summary: "List the organization's variables of a server",
    description: "Values need variables.view-secrets. The organization's services on that server use them as ${{server.KEY}}.",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      await loadServer(auth, params.serverId);
      const rows = await db
        .select()
        .from(schema.serverVar)
        .where(and(eq(schema.serverVar.serverId, params.serverId), eq(schema.serverVar.organizationId, auth.organizationId)))
        .orderBy(asc(schema.serverVar.key));
      const values = auth.can("variables.view-secrets");
      return { variables: rows.map((r) => ({ key: r.key, ...(values ? { value: decryptOrNull(r.value) ?? "" } : {}) })) };
    },
  }),
  route({
    method: "PUT",
    path: "/servers/{serverId}/variables",
    tag: "Variables",
    summary: "Replace the organization's variables of a server",
    description: "redeploy: true then redeploys the organization's running services on the server that use ${{server.…}} (needs services.deploy too).",
    needs: ["admin"],
    body: z.object({ variables: sharedVarList, redeploy: z.boolean().default(false) }),
    handler: async ({ auth, params, body }) => {
      if (body.redeploy) assertCan(auth, "services.deploy");
      await loadServer(auth, params.serverId);
      await unwrap(sharedVars.saveServerVars(params.serverId, body.variables));
      return { ok: true, redeployed: body.redeploy ? (await unwrap(sharedVars.redeployReferencing({ serverId: params.serverId }))).count : 0 };
    },
  }),

  // Deployments
  route({
    method: "GET",
    path: "/deployments/{deploymentId}",
    tag: "Deployments",
    summary: "Get a deployment",
    description: "Status with the end of the build log (logTail, with logs.view).",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      const { deployment } = await loadDeployment(auth, params.deploymentId);
      // The log tail is part of the logs.
      return { deployment: deploymentView(deployment, { logTail: auth.can("logs.view") }) };
    },
  }),
  route({
    method: "GET",
    path: "/deployments/{deploymentId}/logs",
    tag: "Deployments",
    summary: "Full build and deploy log",
    description:
      "With offset (from the previous answer), only the text after it: poll with the offset you got to follow a deployment. An offset past the end (the log was shortened) starts again from the beginning.",
    needs: ["logs.view"],
    query: z.object({ offset: z.coerce.number().int().min(0).optional() }),
    handler: async ({ auth, params, query }) => {
      const { deployment } = await loadDeployment(auth, params.deploymentId);
      return { status: deployment.status, ...logsFrom(deployment.logs, query.offset) };
    },
  }),
  route({
    method: "POST",
    path: "/deployments/{deploymentId}/cancel",
    tag: "Deployments",
    summary: "Cancel a deployment",
    needs: ["services.deploy"],
    handler: async ({ auth, params }) => {
      await loadDeployment(auth, params.deploymentId);
      await unwrap(services.cancelDeployment(params.deploymentId));
      return { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/deployments/{deploymentId}/force-start",
    tag: "Deployments",
    summary: "Force start a queued deployment",
    description: "Starts it now, past its build server's limit of concurrent builds. A deployment of the same service that is running still goes first.",
    needs: ["services.deploy"],
    handler: async ({ auth, params }) => {
      await loadDeployment(auth, params.deploymentId);
      await unwrap(services.forceStartDeployment(params.deploymentId));
      return { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/deployments/{deploymentId}/approve",
    tag: "Deployments",
    summary: "Approve a deployment that waits for approval",
    description: "It is queued and builds as usual. A deploy freeze still holds it back (409 with when the freeze ends).",
    needs: ["deploys.approve"],
    handler: async ({ auth, params }) => {
      await loadDeployment(auth, params.deploymentId);
      await unwrap(approveDeployment(params.deploymentId)).catch(waitConflict);
      const { deployment } = await loadDeployment(auth, params.deploymentId);
      return { deployment: deploymentView(deployment) };
    },
  }),
  route({
    method: "POST",
    path: "/deployments/{deploymentId}/reject",
    tag: "Deployments",
    summary: "Reject a deployment that waits for approval",
    description: "It is cancelled. reason (optional, up to 500 characters) is shown with it.",
    needs: ["deploys.approve"],
    body: z.object({ reason: z.string().max(500).nullable().optional() }),
    handler: async ({ auth, params, body }) => {
      await loadDeployment(auth, params.deploymentId);
      await unwrap(rejectDeployment(params.deploymentId, body.reason ?? null)).catch(waitConflict);
      const { deployment } = await loadDeployment(auth, params.deploymentId);
      return { deployment: deploymentView(deployment) };
    },
  }),
  route({
    method: "POST",
    path: "/deployments/{deploymentId}/rollback",
    tag: "Deployments",
    summary: "Roll back to this deployment",
    description: "Runs its image again, without building.",
    needs: ["services.deploy"],
    status: 202,
    handler: async ({ auth, params }) => {
      await loadDeployment(auth, params.deploymentId);
      return (await unwrap(services.rollbackTo(params.deploymentId))) ?? { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/deployments/{deploymentId}/redeploy",
    tag: "Deployments",
    summary: "Deploy the same commit again",
    needs: ["services.deploy"],
    status: 202,
    handler: async ({ auth, params }) => {
      await loadDeployment(auth, params.deploymentId);
      return (await unwrap(services.redeployDeployment(params.deploymentId))) ?? { ok: true };
    },
  }),
];
