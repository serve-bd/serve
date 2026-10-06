/**
 * Notification catalog shared by the dashboard and the server: events, providers
 * with their settings, severities and message placeholders.
 */

export type Severity = "info" | "warning" | "critical";

export const severityRank: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export const severityOptions: { value: Severity; label: string; description: string }[] = [
  { value: "info", label: "Everything", description: "Successes and problems." },
  { value: "warning", label: "Problems only", description: "Warnings and failures." },
  { value: "critical", label: "Critical only", description: "Outages, crashes and failed backups." },
];

export type NotifyEventGroup = "Deployments" | "Uptime & incidents" | "Backups" | "Certificates" | "Servers" | "Tasks" | "Organization" | "Instance";

export const notifyEventCatalog = [
  { id: "deploy.success", label: "Deployment succeeded", group: "Deployments", severity: "info" },
  { id: "deploy.failed", label: "Deployment failed", group: "Deployments", severity: "warning" },
  { id: "deploy.waiting", label: "Deployment waiting for approval", group: "Deployments", severity: "warning" },
  { id: "service.down", label: "Uptime check failing", group: "Uptime & incidents", severity: "critical" },
  { id: "service.recovered", label: "Uptime check recovered", group: "Uptime & incidents", severity: "info" },
  { id: "service.crashed", label: "Service crashed", group: "Uptime & incidents", severity: "critical" },
  { id: "container.crashloop", label: "Container restarting repeatedly", group: "Uptime & incidents", severity: "critical" },
  { id: "backup.success", label: "Backup succeeded", group: "Backups", severity: "info" },
  { id: "backup.failed", label: "Backup failed", group: "Backups", severity: "critical" },
  { id: "backup.test.failed", label: "Backup test failed", group: "Backups", severity: "critical" },
  { id: "backup.test.passed", label: "Backup test passed", group: "Backups", severity: "info" },
  { id: "restore.success", label: "Restore or import finished", group: "Backups", severity: "info" },
  { id: "restore.failed", label: "Restore or import failed", group: "Backups", severity: "critical" },
  { id: "certificate.renewed", label: "Certificate issued or renewed", group: "Certificates", severity: "info" },
  { id: "certificate.failed", label: "Certificate failed", group: "Certificates", severity: "warning" },
  { id: "server.resource", label: "Server CPU, memory or disk high", group: "Servers", severity: "warning" },
  { id: "server.disk", label: "Disk full, cleanup ran", group: "Servers", severity: "warning" },
  { id: "server.updates", label: "Operating system updates available", group: "Servers", severity: "info" },
  { id: "task.failed", label: "Scheduled task failed", group: "Tasks", severity: "warning" },
  { id: "org.limit", label: "Organization limit reached", group: "Organization", severity: "warning" },
  { id: "instance.backup.success", label: "Instance backup succeeded", group: "Instance", severity: "info" },
  { id: "instance.backup.failed", label: "Instance backup failed", group: "Instance", severity: "critical" },
  { id: "instance.update.available", label: "Update available", group: "Instance", severity: "info" },
  { id: "instance.update.success", label: "Instance updated", group: "Instance", severity: "info" },
  { id: "instance.update.failed", label: "Update failed", group: "Instance", severity: "critical" },
] as const satisfies readonly { id: string; label: string; group: NotifyEventGroup; severity: Severity }[];

export type NotifyEvent = (typeof notifyEventCatalog)[number]["id"];

export const notifyEventGroups: NotifyEventGroup[] = ["Deployments", "Uptime & incidents", "Backups", "Certificates", "Servers", "Tasks", "Organization", "Instance"];

/**
 * The Telegram topic for an event from "deploy=12, backup.failed=15": the longest name that is the
 * event or the start of it wins (deploy.failed before deploy). Null when none matches.
 */
export function topicFor(map: string | undefined, event: string): number | null {
  let best: { len: number; topic: number } | null = null;
  for (const part of (map ?? "").split(/[,\n]/)) {
    const m = part.trim().match(/^([a-z.]+)\s*=\s*(\d+)$/);
    if (!m) continue;
    const key = m[1].replace(/\.$/, "");
    if ((event === key || event.startsWith(`${key}.`)) && (!best || key.length > best.len)) best = { len: key.length, topic: Number(m[2]) };
  }
  return best?.topic ?? null;
}

export function eventInfo(id: string) {
  return notifyEventCatalog.find((e) => e.id === id);
}

/** Events a new channel starts with: the problems. */
export const defaultChannelEvents: NotifyEvent[] = notifyEventCatalog.filter((e) => e.severity !== "info").map((e) => e.id);

export const placeholders = [
  { key: "title", description: "Short summary, like “api deployed”" },
  { key: "body", description: "Details of the event" },
  { key: "event", description: "Event name, like “Deployment failed”" },
  { key: "status", description: "succeeded, failed, down, up…" },
  { key: "severity", description: "info, warning or critical" },
  { key: "service", description: "Service name" },
  { key: "project", description: "Project name" },
  { key: "environment", description: "Environment name" },
  { key: "server", description: "Server name" },
  { key: "organization", description: "Organization name" },
  { key: "error", description: "Error message, if any" },
  { key: "url", description: "Link to the page in Serve" },
] as const;

export type PlaceholderKey = (typeof placeholders)[number]["key"];

/** Replaces {placeholders}; unknown ones stay as typed so mistakes are visible. */
export function fillTemplate(template: string, values: Partial<Record<PlaceholderKey, string | null | undefined>>) {
  return template.replace(/\{([a-z_]+)\}/g, (whole, key: string) => (Object.hasOwn(values, key) ? (values[key as PlaceholderKey] ?? "") : whole));
}

/* -------------------------------- Providers -------------------------------- */

export type ProviderField = {
  key: string;
  label: string;
  placeholder?: string;
  description?: string;
  /** Stored encrypted and never sent back to the browser. */
  secret?: boolean;
  optional?: boolean;
  type?: "text" | "url" | "select" | "textarea";
  options?: { value: string; label: string }[];
  mono?: boolean;
};

export type ProviderCategory = "Chat" | "Push" | "On-call" | "Other";

export type Provider = {
  id: string;
  label: string;
  category: ProviderCategory;
  description: string;
  /** Brand-ish accent for the icon tile. */
  color: string;
  fields: ProviderField[];
  /** Opens and closes alerts (quiet hours and custom text do not apply). */
  alerting?: boolean;
  docs?: string;
};

export const providers = [
  {
    id: "slack",
    label: "Slack",
    category: "Chat",
    color: "#4A154B",
    description: "Post to a channel with an incoming webhook.",
    docs: "https://api.slack.com/messaging/webhooks",
    fields: [{ key: "webhookUrl", label: "Webhook URL", placeholder: "https://hooks.slack.com/services/…", secret: true, mono: true }],
  },
  {
    id: "discord",
    label: "Discord",
    category: "Chat",
    color: "#5865F2",
    description: "Post to a channel with a server webhook.",
    docs: "https://support.discord.com/hc/en-us/articles/228383668",
    fields: [
      { key: "webhookUrl", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/…", secret: true, mono: true },
      { key: "username", label: "Bot name", placeholder: "Serve", optional: true },
    ],
  },
  {
    id: "teams",
    label: "Microsoft Teams",
    category: "Chat",
    color: "#5059C9",
    description: "Post an Adaptive Card through a Teams workflow webhook.",
    docs: "https://support.microsoft.com/office/create-incoming-webhooks-with-workflows-for-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498",
    fields: [{ key: "webhookUrl", label: "Workflow webhook URL", placeholder: "https://…/workflows/…/triggers/manual/paths/invoke?…", secret: true, mono: true }],
  },
  {
    id: "googlechat",
    label: "Google Chat",
    category: "Chat",
    color: "#00AC47",
    description: "Post to a space with an incoming webhook.",
    docs: "https://developers.google.com/workspace/chat/quickstart/webhooks",
    fields: [{ key: "webhookUrl", label: "Webhook URL", placeholder: "https://chat.googleapis.com/v1/spaces/…/messages?key=…", secret: true, mono: true }],
  },
  {
    id: "mattermost",
    label: "Mattermost",
    category: "Chat",
    color: "#1E325C",
    description: "Post to a channel with an incoming webhook.",
    docs: "https://developers.mattermost.com/integrate/webhooks/incoming/",
    fields: [
      { key: "webhookUrl", label: "Webhook URL", placeholder: "https://chat.example.com/hooks/…", secret: true, mono: true },
      { key: "channel", label: "Channel", placeholder: "town-square", optional: true, description: "Overrides the webhook's default channel." },
      { key: "username", label: "Bot name", placeholder: "Serve", optional: true },
    ],
  },
  {
    id: "rocketchat",
    label: "Rocket.Chat",
    category: "Chat",
    color: "#F5455C",
    description: "Post to a channel with an incoming webhook integration.",
    docs: "https://docs.rocket.chat/use-rocket.chat/workspace-administration/integrations",
    fields: [
      { key: "webhookUrl", label: "Webhook URL", placeholder: "https://chat.example.com/hooks/…", secret: true, mono: true },
      { key: "channel", label: "Channel", placeholder: "#alerts", optional: true },
    ],
  },
  {
    id: "telegram",
    label: "Telegram",
    category: "Chat",
    color: "#229ED9",
    description: "Send with your bot to a chat, group or channel.",
    docs: "https://core.telegram.org/bots/api#sendmessage",
    fields: [
      { key: "botToken", label: "Bot token", placeholder: "123456:ABC-DEF…", secret: true, mono: true, description: "From @BotFather." },
      { key: "chatId", label: "Chat ID", placeholder: "-1001234567890", mono: true },
      { key: "threadId", label: "Topic ID", placeholder: "42", optional: true, mono: true, description: "For groups with topics." },
      {
        key: "threadMap",
        label: "Topics by event",
        placeholder: "deploy=12, backup=15, server=20",
        optional: true,
        mono: true,
        description: "Send some events to other topics. deploy covers every deployment event, deploy.failed only that one. Others go to the Topic ID.",
      },
    ],
  },
  {
    id: "matrix",
    label: "Matrix",
    category: "Chat",
    color: "#0DBD8B",
    description: "Send to a room as a bot user.",
    docs: "https://spec.matrix.org/latest/client-server-api/#put_matrixclientv3roomsroomidsendeventtypetxnid",
    fields: [
      { key: "homeserver", label: "Homeserver URL", placeholder: "https://matrix.org", type: "url", mono: true },
      { key: "accessToken", label: "Access token", placeholder: "syt_…", secret: true, mono: true },
      { key: "roomId", label: "Room ID", placeholder: "!abcdef:matrix.org", mono: true, description: "The bot must already be in the room." },
    ],
  },
  {
    id: "ntfy",
    label: "ntfy",
    category: "Push",
    color: "#317F6F",
    description: "Push to phones and desktops through an ntfy topic.",
    docs: "https://docs.ntfy.sh/publish/",
    fields: [
      { key: "server", label: "Server", placeholder: "https://ntfy.sh", type: "url", optional: true, mono: true, description: "Leave empty for ntfy.sh." },
      { key: "topic", label: "Topic", placeholder: "serve-alerts-8f2k", mono: true },
      { key: "token", label: "Access token", placeholder: "tk_…", secret: true, optional: true, mono: true },
    ],
  },
  {
    id: "gotify",
    label: "Gotify",
    category: "Push",
    color: "#1D9CE5",
    description: "Push through your Gotify server.",
    docs: "https://gotify.net/docs/pushmsg",
    fields: [
      { key: "server", label: "Server", placeholder: "https://gotify.example.com", type: "url", mono: true },
      { key: "token", label: "Application token", placeholder: "AbCdEf…", secret: true, mono: true },
    ],
  },
  {
    id: "pushover",
    label: "Pushover",
    category: "Push",
    color: "#249DF1",
    description: "Push to your devices with Pushover.",
    docs: "https://pushover.net/api",
    fields: [
      { key: "token", label: "Application token", placeholder: "azGDORePK8gMaC0QOYAMyEEuzJnyUi", secret: true, mono: true },
      { key: "user", label: "User or group key", placeholder: "uQiRzpo4DXghDmr9QzzfQu27cmVRsG", secret: true, mono: true },
      { key: "device", label: "Device", placeholder: "iphone", optional: true },
    ],
  },
  {
    id: "pushbullet",
    label: "Pushbullet",
    category: "Push",
    color: "#4AB367",
    description: "Push to all your devices or a channel.",
    docs: "https://docs.pushbullet.com/#create-push",
    fields: [
      { key: "accessToken", label: "Access token", placeholder: "o.abc123…", secret: true, mono: true },
      { key: "channelTag", label: "Channel tag", placeholder: "my-channel", optional: true, description: "Push to a channel instead of your devices." },
    ],
  },
  {
    id: "pagerduty",
    label: "PagerDuty",
    category: "On-call",
    color: "#06AC38",
    alerting: true,
    description: "Open incidents on problems and resolve them on recovery.",
    docs: "https://developer.pagerduty.com/docs/events-api-v2/trigger-events/",
    fields: [{ key: "routingKey", label: "Integration key", placeholder: "32 characters, from an Events API v2 integration", secret: true, mono: true }],
  },
  {
    id: "opsgenie",
    label: "Opsgenie",
    category: "On-call",
    color: "#2684FF",
    alerting: true,
    description: "Create alerts on problems and close them on recovery.",
    docs: "https://docs.opsgenie.com/docs/alert-api",
    fields: [
      { key: "apiKey", label: "API key", placeholder: "From an API integration", secret: true, mono: true },
      {
        key: "region",
        label: "Region",
        type: "select",
        options: [
          { value: "us", label: "US" },
          { value: "eu", label: "EU" },
        ],
      },
      { key: "responders", label: "Team", placeholder: "Platform", optional: true, description: "Team that receives the alert." },
    ],
  },
  {
    id: "email",
    label: "Email",
    category: "Other",
    color: "#6B7280",
    description: "Send email with the instance's email settings.",
    fields: [{ key: "to", label: "Send to", placeholder: "ops@example.com, oncall@example.com", description: "Up to 20 addresses, separated by commas." }],
  },
  {
    id: "twilio",
    label: "SMS (Twilio)",
    category: "Other",
    color: "#F22F46",
    description: "Text phone numbers through your Twilio account.",
    docs: "https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource",
    fields: [
      { key: "accountSid", label: "Account SID", placeholder: "AC…", mono: true },
      { key: "authToken", label: "Auth token", placeholder: "Your auth token", secret: true, mono: true },
      { key: "from", label: "From", placeholder: "+15017122661 or MG…", mono: true, description: "A Twilio number or a Messaging Service SID." },
      { key: "to", label: "To", placeholder: "+15558675310, +15558675311", mono: true, description: "Up to 10 numbers in E.164 format." },
    ],
  },
  {
    id: "webhook",
    label: "Webhook",
    category: "Other",
    color: "#111827",
    description: "Send a signed JSON payload to any URL.",
    fields: [
      { key: "url", label: "URL", placeholder: "https://example.com/hooks/serve", type: "url", mono: true },
      {
        key: "method",
        label: "Method",
        type: "select",
        options: [
          { value: "POST", label: "POST" },
          { value: "PUT", label: "PUT" },
          { value: "PATCH", label: "PATCH" },
        ],
      },
      {
        key: "headers",
        label: "Headers",
        type: "textarea",
        optional: true,
        secret: true,
        mono: true,
        placeholder: "Authorization: Bearer …\nX-Team: platform",
        description: "One per line, as Name: value.",
      },
      {
        key: "secret",
        label: "Signing secret",
        optional: true,
        secret: true,
        mono: true,
        placeholder: "A long random string",
        description: "Signs each request with an X-Serve-Signature header.",
      },
    ],
  },
] as const satisfies readonly Provider[];

export type NotificationKind = (typeof providers)[number]["id"];

export const providerCategories: ProviderCategory[] = ["Chat", "Push", "On-call", "Other"];

export function providerInfo(id: string): Provider | undefined {
  return (providers as readonly Provider[]).find((p) => p.id === id);
}

/** Defaults for select fields, so a new form is valid right away. */
export function providerDefaults(id: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of providerInfo(id)?.fields ?? []) if (f.type === "select" && f.options?.length) out[f.key] = f.options[0].value;
  return out;
}

/* ------------------------------- Channel rules ------------------------------ */

export type ChannelScope = {
  /** Empty lists everywhere means every project. */
  projectIds: string[];
  environmentIds: string[];
  serviceIds: string[];
  /** Events without a project: servers, certificates and Serve itself. */
  includeGlobal: boolean;
};

export type QuietHours = {
  enabled: boolean;
  /** "22:00" */
  start: string;
  end: string;
  timezone: string;
  /** Critical alerts still go out during quiet hours. */
  allowCritical: boolean;
  /** Send one summary of what was held when quiet hours end. */
  digest: boolean;
};

export type MessageTemplate = { title: string; body: string };

/** Example webhook body, shown in the dashboard and kept in sync with the sender. */
export const webhookExample = {
  version: 1,
  id: "ntf_4k2j9s8d7f6g5h3",
  event: "deploy.failed",
  occurredAt: "2026-09-29T14:03:12.000Z",
  severity: "warning",
  ok: false,
  status: "failed",
  title: "api failed to deploy",
  body: "The build exited with code 1.",
  error: "The build exited with code 1.",
  url: "https://serve.example.com/projects/p1/services/s1/deployments/d1",
  organization: { id: "o1", name: "Acme" },
  project: { id: "p1", name: "Shop" },
  environment: { id: "e1", name: "production" },
  service: { id: "s1", name: "api", type: "app" },
  server: { id: "local", name: "localhost" },
  deployment: { id: "d1" },
  data: {},
};
