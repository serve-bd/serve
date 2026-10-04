/*
 * What the Metrics integration page hands out: the scrape config for prometheus.yml and a small
 * Grafana dashboard. Pure, so both are tested and built in the browser.
 */

export const METRICS_PATH = "/api/v1/metrics";

/** The metrics endpoint of a dashboard address (which may live under a path). */
export function metricsUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}${METRICS_PATH}`;
}

/** A scrape_configs entry for prometheus.yml. Without a token, a placeholder shows where it goes. */
export function prometheusScrapeConfig(baseUrl: string, token?: string | null, job = "serve") {
  let scheme = "https";
  let host = baseUrl;
  let path = METRICS_PATH;
  try {
    const u = new URL(baseUrl);
    scheme = u.protocol.replace(":", "");
    host = u.host;
    path = `${u.pathname.replace(/\/+$/, "")}${METRICS_PATH}`;
  } catch {
    // Not a full URL: used as the host.
  }
  return [
    "scrape_configs:",
    `  - job_name: ${job}`,
    "    scrape_interval: 30s",
    "    scrape_timeout: 10s",
    `    scheme: ${scheme}`,
    `    metrics_path: ${path}`,
    "    authorization:",
    "      type: Bearer",
    `      credentials: ${token || "srv_your_token_here"}`,
    "    static_configs:",
    `      - targets: ["${host}"]`,
    "",
  ].join("\n");
}

const DS = { type: "prometheus", uid: "${datasource}" };
const FILTER = 'project=~"$project", service=~"$service"';

type Target = { expr: string; legend: string };

function panel(id: number, title: string, unit: string, targets: Target[], grid: { x: number; y: number; w: number; h: number }, description?: string, signed = false) {
  return {
    id,
    type: "timeseries",
    title,
    description,
    datasource: DS,
    gridPos: grid,
    fieldConfig: { defaults: { unit, ...(signed ? {} : { min: 0 }), custom: { lineWidth: 1, fillOpacity: 10, showPoints: "never" } }, overrides: [] },
    options: { legend: { displayMode: "list", placement: "bottom", showLegend: true }, tooltip: { mode: "multi", sort: "desc" } },
    targets: targets.map((t, i) => ({ refId: String.fromCharCode(65 + i), datasource: DS, expr: t.expr, legendFormat: t.legend, range: true })),
  };
}

function labelVariable(name: string, label: string, query: string) {
  return {
    name,
    label,
    type: "query",
    datasource: DS,
    query: { query, refId: `${name}-var` },
    definition: query,
    refresh: 2,
    multi: true,
    includeAll: true,
    allValue: ".*",
    current: { selected: true, text: ["All"], value: ["$__all"] },
    sort: 1,
  };
}

/** A Grafana dashboard: CPU, memory, network, requests and 5xx per service, with project and service pickers. */
export function grafanaDashboard(title = "Serve services") {
  const by = "sum by (project, service)";
  const legend = "{{project}} / {{service}}";
  return {
    title,
    uid: "serve-services",
    tags: ["serve"],
    timezone: "browser",
    schemaVersion: 39,
    version: 1,
    editable: true,
    refresh: "30s",
    time: { from: "now-6h", to: "now" },
    templating: {
      list: [
        { name: "datasource", label: "Data source", type: "datasource", query: "prometheus", current: {}, hide: 0 },
        labelVariable("project", "Project", "label_values(serve_service_info, project)"),
        labelVariable("service", "Service", 'label_values(serve_service_info{project=~"$project"}, service)'),
      ],
    },
    panels: [
      panel(1, "CPU", "short", [{ expr: `${by} (serve_service_cpu_cores{${FILTER}})`, legend }], { x: 0, y: 0, w: 12, h: 8 }, "Cores in use (1 = one full core)."),
      panel(2, "Memory", "bytes", [{ expr: `${by} (serve_service_memory_bytes{${FILTER}})`, legend }], { x: 12, y: 0, w: 12, h: 8 }),
      panel(
        3,
        "Network",
        "Bps",
        [
          { expr: `${by} (rate(serve_service_network_receive_bytes_total{${FILTER}}[$__rate_interval]))`, legend: `${legend} in` },
          { expr: `-${by} (rate(serve_service_network_transmit_bytes_total{${FILTER}}[$__rate_interval]))`, legend: `${legend} out` },
        ],
        { x: 0, y: 8, w: 12, h: 8 },
        "Received above the line, sent below.",
        true,
      ),
      panel(4, "Running containers", "short", [{ expr: `${by} (serve_service_replicas_running{${FILTER}})`, legend }], { x: 12, y: 8, w: 12, h: 8 }),
      panel(
        5,
        "Requests per second",
        "reqps",
        [{ expr: `${by} (serve_service_http_requests_per_second{${FILTER}})`, legend }],
        { x: 0, y: 16, w: 12, h: 8 },
        "Average over the last 5 minutes, from the proxy.",
      ),
      panel(
        6,
        "5xx per second",
        "reqps",
        [{ expr: `${by} (serve_service_http_5xx_per_second{${FILTER}})`, legend }],
        { x: 12, y: 16, w: 12, h: 8 },
        "Server errors, average over the last 5 minutes.",
      ),
    ],
  };
}
