import { z } from "zod";
import * as stacks from "@/server/actions/stacks";
import { loadEnvironment } from "../data";
import { type ApiRoute, assertCan, route, unwrap } from "../router";

const body = z.object({
  /** The text of serve-compose.yml. */
  file: z.string().min(1),
  /** ${VAR} values: only those the file names. */
  values: z.record(z.string(), z.string()).optional(),
  /** Files the stack names (env_file, compose), by their path in it. */
  files: z.record(z.string(), z.string()).optional(),
  /** The stack's name when the file gives none (the folder's name). */
  folder: z.string().max(200).optional(),
  force: z.boolean().default(false),
  removeOrphans: z.boolean().default(false),
  redeploy: z.boolean().default(false),
  noDeploy: z.boolean().default(false),
  /** Who asks: "cli" shows the deployments as made from the CLI. */
  client: z.enum(["api", "cli"]).default("api"),
});

const input = (b: z.infer<typeof body>) => ({ text: b.file, values: b.values, files: b.files, folder: b.folder });

export const stackRoutes: ApiRoute[] = [
  route({
    method: "POST",
    path: "/environments/{environmentId}/stacks/plan",
    tag: "Stacks",
    summary: "Check a serve-compose.yml and show what up would do",
    description:
      "Changes nothing. needs lists the ${VAR} values and the files the file names that were not sent: send them and ask again. ready is true when up would go ahead. services: each one's action (create, update, unchanged), changes and deploy wave.",
    needs: ["services.manage"],
    body,
    handler: async ({ auth, params, body }) => {
      await loadEnvironment(auth, params.environmentId);
      return { plan: await unwrap(stacks.planStackAction(params.environmentId, input(body), body)) };
    },
  }),
  route({
    method: "POST",
    path: "/environments/{environmentId}/stacks/up",
    tag: "Stacks",
    summary: "Create, update and deploy a stack",
    description: [
      "Applies serve-compose.yml: missing services are created, existing ones of the stack updated (a value changed in the dashboard since the last up stays, unless force).",
      "Then the services deploy wave by wave, each after what it depends on (follow GET /stack-runs/{runId}).",
      "Services with a local folder (build: ./web) wait for it: upload it to POST /services/{serviceId}/deploy/upload?stackRun={runId}.",
      "removeOrphans removes the stack's services no longer in the file (their volumes stay). noDeploy makes the changes only.",
    ].join(" "),
    needs: ["services.manage"],
    body,
    status: 202,
    handler: async ({ auth, params, body }) => {
      await loadEnvironment(auth, params.environmentId);
      if (!body.noDeploy) assertCan(auth, "services.deploy");
      return unwrap(stacks.upStack(params.environmentId, input(body), { ...body, trigger: body.client }));
    },
  }),
  route({
    method: "GET",
    path: "/environments/{environmentId}/stacks",
    tag: "Stacks",
    summary: "The stacks of an environment",
    description: "Each stack with its services (key: its name in the file) and its last run. name: only that stack.",
    needs: ["projects.view"],
    query: z.object({ name: z.string().max(100).optional() }),
    handler: async ({ auth, params, query }) => {
      await loadEnvironment(auth, params.environmentId);
      return { stacks: await unwrap(stacks.stackStatus(params.environmentId, query.name)) };
    },
  }),
  route({
    method: "DELETE",
    path: "/environments/{environmentId}/stacks/{name}",
    tag: "Stacks",
    summary: "Remove a stack's services",
    description: "volumes=1 removes their data too, databases included. Without it the volumes stay.",
    needs: ["services.manage"],
    query: z.object({ volumes: z.enum(["0", "1", "true", "false"]).optional() }),
    handler: async ({ auth, params, query }) => {
      await loadEnvironment(auth, params.environmentId);
      return unwrap(stacks.downStack(params.environmentId, params.name, query.volumes === "1" || query.volumes === "true"));
    },
  }),
  route({
    method: "GET",
    path: "/stack-runs/{runId}",
    tag: "Stacks",
    summary: "A stack deploy's progress",
    description: "status: running, success, failed or cancelled. services: each one's state (waiting, deploying, success, failed, skipped, unchanged), deployment and note.",
    needs: ["projects.view"],
    handler: async ({ params }) => ({ run: await unwrap(stacks.stackRun(params.runId)) }),
  }),
];
