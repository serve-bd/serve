import crypto from "node:crypto";
import type { LogDrainKind } from "@/server/db/schema";

/** A drain as the config is written from: its secrets already read. */
export type DrainSpec = {
  id: string;
  organizationId: string;
  kind: LogDrainKind;
  url: string;
  header?: { name: string; value: string } | null;
  username?: string | null;
  password?: string | null;
  projectIds: string[] | null;
  serviceIds?: string[] | null;
  index?: string | null;
  sourcetype?: string | null;
};

/** tcp://, tls:// or udp:// host and port of a syslog drain. */
export function syslogTarget(url: string) {
  const u = new URL(url);
  const scheme = u.protocol.replace(/:$/, "");
  if (!["tcp", "tls", "udp"].includes(scheme) || !u.hostname || !u.port) return null;
  return { mode: scheme === "udp" ? ("udp" as const) : ("tcp" as const), tls: scheme === "tls", host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port) };
}

/** A service whose container logs may be sent, with the names a log line carries. */
export type ServiceRow = { serviceId: string; organizationId: string; projectId: string; project: string; environment: string; service: string; type: string };

const COLUMNS = ["service_id", "organization_id", "project_id", "project", "environment", "service", "type"] as const;

function csvCell(value: string) {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The services table Vector looks each log line's service up in. */
export function servicesCsv(rows: ServiceRow[]) {
  const lines = [...rows]
    .sort((a, b) => a.serviceId.localeCompare(b.serviceId))
    .map((r) => [r.serviceId, r.organizationId, r.projectId, r.project, r.environment, r.service, r.type].map(csvCell).join(","));
  return `${[COLUMNS.join(","), ...lines].join("\n")}\n`;
}

/** A string literal for VRL. */
function vrl(value: string) {
  return JSON.stringify(value);
}

/**
 * Vector's config for one server, as JSON (which Vector reads like YAML). Every Serve container's
 * logs are read from Docker; a line whose service is not in the table (Vector itself, the proxy,
 * helpers) is dropped. Each drain gets the lines of its own organization (and projects) only.
 */
export function vectorConfig(serverName: string, drains: DrainSpec[], csv: string) {
  // The table is reloaded with the config: its hash in the config makes a changed table a changed config.
  const tableHash = crypto.createHash("sha256").update(csv).digest("hex").slice(0, 16);
  const transforms: Record<string, unknown> = {
    serve_enrich: {
      type: "remap",
      inputs: ["serve_docker"],
      source: [
        `# services ${tableHash}`,
        'sid = string(.label."serve.service") ?? ""',
        'if sid == "" { abort }',
        'row, err = get_enrichment_table_record("serve_services", {"service_id": sid})',
        "if err != null { abort }",
        ". = {",
        '  "timestamp": .timestamp,',
        '  "message": .message,',
        '  "stream": .stream,',
        '  "organization_id": row.organization_id,',
        '  "project_id": row.project_id,',
        '  "project": row.project,',
        '  "environment": row.environment,',
        '  "service_id": sid,',
        '  "service": row.service,',
        '  "service_type": row.type,',
        '  "deployment": .label."serve.deployment",',
        '  "kind": .label."serve.kind",',
        '  "container": .container_name,',
        `  "server": ${vrl(serverName)}`,
        "}",
      ].join("\n"),
    },
  };
  const sinks: Record<string, unknown> = {};
  for (const d of drains) {
    const conditions = [`.organization_id == ${vrl(d.organizationId)}`];
    // Picked projects (with their new services) and picked services; neither picked: everything.
    const picked = [
      ...(d.projectIds?.length ? [`includes(${JSON.stringify(d.projectIds)}, .project_id)`] : []),
      ...(d.serviceIds?.length ? [`includes(${JSON.stringify(d.serviceIds)}, .service_id)`] : []),
    ];
    if (picked.length) conditions.push(picked.length > 1 ? `(${picked.join(" || ")})` : picked[0]);
    transforms[`drain_${d.id}`] = { type: "filter", inputs: ["serve_enrich"], condition: conditions.join(" && ") };
    // A destination that is down must not make Vector hold everything in memory.
    const common = {
      inputs: [`drain_${d.id}`],
      buffer: { type: "memory", max_events: 10_000, when_full: "drop_newest" },
      batch: { timeout_secs: 5, max_events: 1000 },
      request: { retry_attempts: 10 },
    };
    if (d.kind === "loki") {
      sinks[`drain_${d.id}_out`] = {
        ...common,
        type: "loki",
        endpoint: d.url.replace(/\/loki\/api\/v1\/push\/?$/, "").replace(/\/$/, ""),
        encoding: { codec: "json" },
        labels: { project: "{{ project }}", environment: "{{ environment }}", service: "{{ service }}", stream: "{{ stream }}", server: "{{ server }}" },
        out_of_order_action: "accept",
        ...(d.username || d.password ? { auth: { strategy: "basic", user: d.username ?? "", password: d.password ?? "" } } : {}),
      };
    } else if (d.kind === "elasticsearch") {
      sinks[`drain_${d.id}_out`] = {
        ...common,
        type: "elasticsearch",
        endpoints: [d.url.replace(/\/$/, "")],
        mode: "bulk",
        // A daily index, like serve-logs-2026.10.04: old days can be dropped whole.
        bulk: { index: `${d.index || "serve-logs"}-%Y.%m.%d`, action: "create" },
        api_version: "auto",
        healthcheck: { enabled: false },
        ...(d.username || d.password ? { auth: { strategy: "basic", user: d.username ?? "", password: d.password ?? "" } } : {}),
      };
    } else if (d.kind === "splunk") {
      sinks[`drain_${d.id}_out`] = {
        ...common,
        type: "splunk_hec_logs",
        endpoint: d.url.replace(/\/services\/collector.*$/, "").replace(/\/$/, ""),
        default_token: d.password ?? "",
        encoding: { codec: "json" },
        ...(d.index ? { index: d.index } : {}),
        sourcetype: d.sourcetype || "serve",
        host_key: "server",
        healthcheck: { enabled: false },
      };
    } else if (d.kind === "syslog") {
      const target = syslogTarget(d.url);
      if (!target) continue;
      // RFC 5424 lines: <priority>1 time host app - - - message. 14 is user.info, 11 user.err (stderr).
      transforms[`drain_${d.id}_syslog`] = {
        type: "remap",
        inputs: [`drain_${d.id}`],
        source: [
          'pri = if .stream == "stderr" { "11" } else { "14" }',
          'app = replace(string(.service) ?? "serve", r\'[^A-Za-z0-9._-]\', "-")',
          'host = replace(string(.server) ?? "serve", r\'[^A-Za-z0-9._-]\', "-")',
          'ts = format_timestamp!(.timestamp, format: "%+")',
          '. = {"message": "<" + pri + ">1 " + ts + " " + host + " " + app + " - - - " + (string(.message) ?? "")}',
        ].join("\n"),
      };
      sinks[`drain_${d.id}_out`] = {
        inputs: [`drain_${d.id}_syslog`],
        buffer: common.buffer,
        type: "socket",
        mode: target.mode,
        address: `${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}`,
        encoding: { codec: "text" },
        ...(target.mode === "tcp" ? { framing: { method: "newline_delimited" } } : {}),
        ...(target.tls ? { tls: { enabled: true } } : {}),
      };
    } else {
      sinks[`drain_${d.id}_out`] = {
        ...common,
        type: "http",
        uri: d.url,
        method: "post",
        encoding: { codec: "json" },
        request: { ...common.request, ...(d.header?.name ? { headers: { [d.header.name]: d.header.value } } : {}) },
      };
    }
  }
  return `${JSON.stringify(
    {
      data_dir: "/var/lib/vector",
      api: { enabled: false },
      enrichment_tables: {
        serve_services: {
          type: "file",
          file: { path: "/etc/vector/services.csv", encoding: { type: "csv" } },
          schema: Object.fromEntries(COLUMNS.map((c) => [c, "string"])),
        },
      },
      sources: { serve_docker: { type: "docker_logs", include_labels: ["serve.managed=true"] } },
      transforms,
      sinks,
    },
    null,
    2,
  )}\n`;
}

/** One sample line, as a drain receives it, for "Send test". */
export function sampleLine(organizationId: string) {
  return {
    timestamp: new Date().toISOString(),
    message: "Test line from Serve: this drain works.",
    stream: "stdout",
    organization_id: organizationId,
    project_id: "test",
    project: "Serve",
    environment: "test",
    service_id: "test",
    service: "log-drain-test",
    service_type: "app",
    deployment: null,
    kind: "app",
    container: "serve-log-drain-test",
    server: "dashboard",
  };
}
