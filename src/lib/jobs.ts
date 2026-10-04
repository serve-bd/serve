/** Names of the worker's repeating schedulers and of job types, for Settings → Jobs. */
export const SCHEDULER_LABELS: Record<string, string> = {
  heartbeat: "Worker heartbeat",
  monitor: "Container status and crash limits",
  "github-app-hooks": "GitHub App webhooks",
  servers: "Server reachability",
  "host-ports": "Host port relays",
  tunnels: "Cloudflare Tunnels",
  "server-listener": "Servers that connect out",
  metrics: "Metrics",
  "metrics-agents": "Metrics agents",
  "metric-rollups": "Metric rollups",
  backups: "Backup schedules",
  "instance-backups": "Instance backups",
  "update-status": "Update status",
  "update-check": "Update checks",
  tasks: "Scheduled tasks",
  analytics: "Request analytics",
  certificates: "Certificate renewals",
  "certificate-retries": "Certificate retries",
  "log-drains": "Log drains",
  cleanup: "Docker cleanup",
  "db-allowlists": "Database allowlists",
  "db-tunnels": "Database tunnels",
  "proxy-health": "Proxy health",
  "cloudflare-ranges": "Cloudflare IP ranges",
  "container-health": "Container health",
  mesh: "Private networks",
  notifications: "Notification deliveries",
  "org-disk": "Organization disk usage",
  "server-resources": "Server resource alerts",
  uptime: "Uptime checks",
  "os-updates": "Operating system update checks",
  "cli-logins": "CLI sign-in cleanup",
};

export const JOB_LABELS: Record<string, string> = {
  deploy: "Deployment",
  "backup.run": "Backup",
  "backup.restore": "Restore",
  "backup.import": "Backup import",
  "task.run": "Scheduled task",
  "certificate.issue": "Certificate",
  "certificate.retire": "Certificate removal",
  cleanup: "Docker cleanup",
  "database.branch": "Database branch",
  "environment.copy-data": "Data copy",
  "instance.backup": "Instance backup",
  "instance.update": "Instance update",
  "mesh.sync": "Private network",
  "notification.deliver": "Notification",
  "preview.database": "Preview database",
  "proxy.switch": "Proxy switch",
  "proxy.sync": "Proxy config",
  "server.setup": "Server setup",
  "service.delete": "Service delete",
  "service.restart": "Service restart",
  "service.stop": "Service stop",
  "tunnel.sync": "Tunnel sync",
  "server.os-updates": "OS updates",
};

/** "every 5 min" for an interval in milliseconds. */
export function everyLabel(ms: number) {
  if (ms < 60_000) return `every ${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `every ${Math.round(ms / 60_000)} min`;
  return `every ${Math.round(ms / 3_600_000)} h`;
}
