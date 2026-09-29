import { z } from "zod";
import { notifyEventCatalog, providerInfo } from "@/lib/notifications";
import { list, parseHeaders } from "./payloads";

export class ChannelConfigError extends Error {}

const httpUrl = (value: string, label: string, httpsOnly = false) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ChannelConfigError(`${label} is not a valid URL.`);
  }
  if (url.protocol !== "https:" && (httpsOnly || url.protocol !== "http:")) throw new ChannelConfigError(`${label} must start with https://${httpsOnly ? "" : " or http://"}.`);
  if (url.username || url.password) throw new ChannelConfigError(`${label} must not contain a user name or password.`);
  return value;
};

/**
 * Checks a provider's settings and returns them cleaned. `stored` holds the saved
 * values: an empty secret field keeps the saved secret.
 */
export function validateChannelConfig(kind: string, input: Record<string, string>, stored: Record<string, string> = {}): Record<string, string> {
  const provider = providerInfo(kind);
  if (!provider) throw new ChannelConfigError("Unknown channel type.");
  const out: Record<string, string> = {};
  for (const f of provider.fields) {
    let v = (input[f.key] ?? "").trim();
    if (!v && f.secret && stored[f.key]) v = stored[f.key];
    if (!v && f.type === "select" && f.options?.length) v = f.options[0].value;
    if (!v) {
      if (!f.optional) throw new ChannelConfigError(`Fill in ${f.label}.`);
      continue;
    }
    if (f.type === "select" && !f.options?.some((o) => o.value === v)) throw new ChannelConfigError(`Choose a valid ${f.label}.`);
    if (v.length > 4000) throw new ChannelConfigError(`${f.label} is too long.`);
    out[f.key] = v;
  }
  const c = out;
  switch (kind) {
    case "slack":
    case "discord":
    case "teams":
    case "googlechat":
      c.webhookUrl = httpUrl(c.webhookUrl, "Webhook URL", true);
      break;
    case "mattermost":
    case "rocketchat":
      c.webhookUrl = httpUrl(c.webhookUrl, "Webhook URL");
      break;
    case "telegram":
      if (!/^\d+:[\w-]{20,}$/.test(c.botToken)) throw new ChannelConfigError("The bot token looks like 123456:ABC-DEF…, from @BotFather.");
      if (!/^(-?\d+|@[A-Za-z]\w{3,})$/.test(c.chatId)) throw new ChannelConfigError("The chat ID is a number like -1001234567890, or @channelname.");
      if (c.threadId && !/^\d+$/.test(c.threadId)) throw new ChannelConfigError("The topic ID is a number.");
      break;
    case "matrix":
      c.homeserver = httpUrl(c.homeserver, "Homeserver URL");
      if (!/^[!#][^:]+:.+$/.test(c.roomId)) throw new ChannelConfigError("The room ID looks like !abcdef:matrix.org.");
      break;
    case "ntfy":
      if (c.server) c.server = httpUrl(c.server, "Server");
      if (!/^[-_A-Za-z0-9]{1,64}$/.test(c.topic)) throw new ChannelConfigError("The topic uses letters, numbers, - and _ (up to 64).");
      break;
    case "gotify":
      c.server = httpUrl(c.server, "Server");
      break;
    case "pushover":
      if (!/^[A-Za-z0-9]{30}$/.test(c.token) || !/^[A-Za-z0-9]{30}$/.test(c.user)) throw new ChannelConfigError("Pushover tokens and user keys are 30 letters and numbers.");
      break;
    case "pagerduty":
      if (!/^[A-Za-z0-9]{32}$/.test(c.routingKey)) throw new ChannelConfigError("The integration key has 32 letters and numbers.");
      break;
    case "twilio": {
      if (!/^AC[0-9a-fA-F]{32}$/.test(c.accountSid)) throw new ChannelConfigError("The Account SID starts with AC and has 34 characters.");
      if (!/^(\+[1-9]\d{6,14}|MG[0-9a-fA-F]{32}|[A-Za-z0-9 ]{1,11})$/.test(c.from))
        throw new ChannelConfigError("From is a phone number like +15017122661, a Messaging Service SID or a sender name.");
      const to = list(c.to, 11);
      if (!to.length || to.length > 10 || to.some((n) => !/^\+[1-9]\d{6,14}$/.test(n))) throw new ChannelConfigError("Enter up to 10 phone numbers like +15558675310.");
      c.to = to.join(", ");
      break;
    }
    case "email": {
      const to = list(c.to.toLowerCase(), 21);
      if (!to.length || to.length > 20 || to.some((a) => !z.email().safeParse(a).success)) throw new ChannelConfigError("Enter up to 20 email addresses, separated by commas.");
      c.to = to.join(", ");
      break;
    }
    case "webhook":
      c.url = httpUrl(c.url, "URL");
      try {
        parseHeaders(c.headers);
      } catch (e) {
        throw new ChannelConfigError((e as Error).message);
      }
      break;
  }
  return c;
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use the 24-hour form, like 22:00");

export function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const channelInput = z.object({
  name: z.string().trim().min(1, "Name the channel").max(60),
  kind: z.string(),
  config: z.record(z.string(), z.string()),
  events: z
    .array(z.string())
    .min(1, "Pick at least one event")
    .transform((list) => [...new Set(list)].filter((e) => notifyEventCatalog.some((x) => x.id === e))),
  scope: z
    .object({
      projectIds: z.array(z.string()).max(500),
      environmentIds: z.array(z.string()).max(500),
      serviceIds: z.array(z.string()).max(500),
      includeGlobal: z.boolean(),
    })
    .nullable(),
  minSeverity: z.enum(["info", "warning", "critical"]),
  quietHours: z
    .object({
      enabled: z.boolean(),
      start: hhmm,
      end: hhmm,
      timezone: z.string().refine(validTimezone, "Unknown time zone"),
      allowCritical: z.boolean(),
      digest: z.boolean(),
    })
    .nullable(),
  throttleMinutes: z.number().int().min(0).max(1440),
  template: z.object({ title: z.string().max(300), body: z.string().max(2000) }).nullable(),
});

export type ChannelInput = z.input<typeof channelInput>;
