import { PROMETHEUS_CONTENT_TYPE } from "@/lib/prometheus";
import type { ApiAuth } from "@/server/api-auth";
import { METRICS_RATE_LIMIT, takeRequest } from "../rate-limit";
import { type ApiRoute, route } from "../router";

/**
 * Host figures of the servers are shared by every organization, so like the dashboard they go
 * only to Root admins: a token of the Root organization whose owner is an owner or admin there,
 * not limited to some projects.
 */
export async function hostMetricsAllowed(auth: ApiAuth) {
  if (auth.projectIds) return false;
  const { getSetting } = await import("@/server/settings");
  if ((await getSetting("rootOrganizationId")) !== auth.organizationId) return false;
  const { isInstanceAdmin } = await import("@/server/auth");
  return isInstanceAdmin(auth.userId);
}

export const metricsRoutes: ApiRoute[] = [
  route({
    method: "GET",
    path: "/metrics",
    tag: "Metrics",
    summary: "Metrics for Prometheus",
    description: [
      "The organization's services in the Prometheus text format (`text/plain; version=0.0.4`), for your own Prometheus or Grafana to scrape: CPU, memory, network, containers, restarts, status and deployments, from the samples Serve already stores.",
      "",
      "Request and 5xx rates are included when the token also has logs.view. A token of the Root organization whose owner is a Root admin also gets the servers' own CPU, memory, disk and load.",
      "",
      `The answer is cached for a few seconds, and a token may scrape ${METRICS_RATE_LIMIT} times a minute.`,
    ].join("\n"),
    needs: ["projects.view"],
    produces: PROMETHEUS_CONTENT_TYPE,
    handler: async ({ auth }) => {
      const rate = takeRequest(`metrics:${auth.tokenId}`, METRICS_RATE_LIMIT);
      if (!rate.allowed)
        return new Response(`Too many scrapes: this token may scrape ${METRICS_RATE_LIMIT} times a minute. Scrape less often, or give each Prometheus its own token.\n`, {
          status: 429,
          headers: { ...rate.headers, "content-type": "text/plain; charset=utf-8" },
        });
      const { metricsText } = await import("@/server/metrics-export");
      const text = await metricsText({
        organizationId: auth.organizationId,
        projectIds: auth.projectIds,
        requests: auth.can("logs.view"),
        hosts: await hostMetricsAllowed(auth),
      });
      return new Response(text, { headers: { "content-type": PROMETHEUS_CONTENT_TYPE, "cache-control": "no-store" } });
    },
  }),
];
