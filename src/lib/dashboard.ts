import { z } from "zod";

/*
 * The overview is the member's own homepage. It is a list of rows; a row splits into columns
 * of chosen widths, and each column stacks its items on its own, so columns of different
 * heights sit side by side without gaps (a masonry look). An item is a widget, or a row of its
 * own that splits that column again (one level deep). Phones stack everything.
 */

export const WIDGET_TYPES = ["greeting", "glance", "attention", "deploys", "activity", "projects", "project", "servers", "server", "shortcuts", "note"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export type ShortcutLink = { label: string; href: string };

export type WidgetOptions = {
  projectId?: string;
  serverId?: string;
  text?: string;
  weeks?: number;
  links?: ShortcutLink[];
};

export type Widget = {
  kind: "widget";
  id: string;
  type: WidgetType;
  /** "card" draws a card around it; "plain" sits straight on the page. */
  frame: "card" | "plain";
  /** Grow to the bottom of its column when a column beside it is taller. */
  fill: boolean;
  /** Most items a list shows; the widget's default when unset. */
  limit?: number;
  /** A title of the member's own; the widget's name when unset. */
  title?: string;
  options: WidgetOptions;
};

/** A row inside a column: splits that column again. Its columns hold widgets only. */
export type InnerRow = { kind: "row"; id: string; title?: string; columns: Column<Widget>[] };

export type Item = Widget | InnerRow;

/** One column: its share of the row's width and the items stacked in it. */
export type Column<T extends Item = Item> = { id: string; width: number; items: T[] };

export type DashboardRow = { id: string; title?: string; columns: Column[] };
export type DashboardLayout = { version: 2; rows: DashboardRow[] };

type WidgetMeta = {
  name: string;
  description: string;
  /** Lucide icon name, looked up on the client. */
  icon: string;
  /** Lists only: how many items it shows by default, and at most. */
  limit?: { default: number; max: number };
  /** Card or plain by default. */
  frame: "card" | "plain";
  /** Shown while customizing when the widget has nothing to show right now. */
  emptyHint?: string;
};

export const WIDGETS: Record<WidgetType, WidgetMeta> = {
  greeting: { name: "Greeting", description: "Says hello and shows your local time and date.", icon: "Sun", frame: "plain" },
  glance: { name: "At a glance", description: "Running services, projects, servers and deploys this week.", icon: "Gauge", frame: "card" },
  attention: {
    name: "Needs attention",
    description: "Failed or crashed services and servers that are offline.",
    icon: "AlertTriangle",
    limit: { default: 10, max: 50 },
    frame: "card",
    emptyHint: "Nothing needs attention now. This widget appears when a service fails or a server goes offline.",
  },
  deploys: { name: "Recent deploys", description: "The last deployments on a timeline, grouped by day.", icon: "Rocket", limit: { default: 5, max: 30 }, frame: "card" },
  activity: { name: "Deploy activity", description: "A calendar of how often you ship, one square per day.", icon: "CalendarDays", frame: "card" },
  projects: { name: "Projects", description: "Your projects with a light for each service.", icon: "Blocks", limit: { default: 8, max: 50 }, frame: "card" },
  project: { name: "One project", description: "Every service of one project you pick, with its status.", icon: "Box", limit: { default: 10, max: 50 }, frame: "card" },
  servers: { name: "Servers", description: "Your servers with CPU, memory and disk now.", icon: "Server", limit: { default: 10, max: 50 }, frame: "card" },
  server: { name: "Server usage", description: "CPU and memory of one server over the last 6 hours.", icon: "Activity", frame: "card" },
  shortcuts: { name: "Shortcuts", description: "Links you open often, inside Serve or anywhere else.", icon: "Link2", frame: "card" },
  note: { name: "Note", description: "Write anything down. Only you see it.", icon: "StickyNote", frame: "card", emptyHint: "Open the settings of this note to write in it." },
};

export const ACTIVITY_WEEKS = [12, 26, 52] as const;
export const MAX_COLS = 4;
export const MAX_WIDTH = 4;

export const widgetTitle = (w: Pick<Widget, "type" | "title">) => w.title?.trim() || WIDGETS[w.type].name;
export const widgetLimit = (w: Pick<Widget, "type" | "limit">) => {
  const meta = WIDGETS[w.type].limit;
  return meta ? Math.min(meta.max, Math.max(1, w.limit ?? meta.default)) : Number.POSITIVE_INFINITY;
};

/** Short random ids. Not crypto.randomUUID: that needs HTTPS, and the dashboard may run on plain HTTP. */
export const layoutId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");

export const newWidget = (type: WidgetType): Widget => ({ kind: "widget", id: layoutId(), type, frame: WIDGETS[type].frame, fill: false, options: {} });
export const newColumn = <T extends Item = Item>(width = 1): Column<T> => ({ id: layoutId(), width, items: [] });
export const newInnerRow = (cols = 2): InnerRow => ({ kind: "row", id: layoutId(), columns: Array.from({ length: cols }, () => newColumn<Widget>()) });

/** Every widget in the layout, inner rows included. */
export function allWidgets(layout: DashboardLayout): Widget[] {
  return layout.rows.flatMap((r) => r.columns.flatMap((c) => c.items.flatMap((it) => (it.kind === "widget" ? [it] : it.columns.flatMap((ic) => ic.items)))));
}

const col = (id: string, width: number, items: Item[]): Column => ({ id, width, items });
const w = (type: WidgetType, id: string, extra: Partial<Widget> = {}): Widget => ({ ...newWidget(type), id, ...extra });

/**
 * What a member sees before changing anything: a greeting, trouble if there is any, the numbers
 * and recent deploys beside projects, servers and shortcuts, then a year of deploys.
 */
export function defaultLayout(): DashboardLayout {
  return {
    version: 2,
    rows: [
      { id: "greeting", columns: [col("greetingc", 1, [w("greeting", "greetingw")])] },
      { id: "attention", columns: [col("attentionc", 1, [w("attention", "attentionw")])] },
      {
        id: "main",
        columns: [
          col("mainl", 2, [w("glance", "glance"), w("deploys", "deploys", { fill: true })]),
          col("mainr", 1, [
            w("projects", "projects"),
            w("servers", "servers"),
            w("shortcuts", "shortcuts", {
              options: {
                links: [
                  { label: "New project", href: "/projects/new" },
                  { label: "Templates", href: "/templates" },
                  { label: "Domains", href: "/domains" },
                  { label: "Monitoring", href: "/monitoring" },
                ],
              },
            }),
          ]),
        ],
      },
      { id: "activity", columns: [col("activityc", 1, [w("activity", "activity", { options: { weeks: 52 } })])] },
    ],
  };
}

const idSchema = z.string().regex(/^[a-z0-9]{1,24}$/);
// Inside Serve ("/servers") or a web address. Never `javascript:` or a protocol-relative "//host"
// (browsers drop tabs and newlines and read "\" as "/", so "/\t/host" would be one).
const hrefSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => !/[\\\u0000-\u001f\u007f]/.test(v) && (/^\/(?![/\\])/.test(v) || /^https?:\/\/[^\s]+$/i.test(v)),
    "Use a path like /servers or a web address starting with https://",
  );

export const widgetSchema = z.object({
  kind: z.literal("widget"),
  id: idSchema,
  type: z.enum(WIDGET_TYPES),
  frame: z.enum(["card", "plain"]),
  fill: z.boolean(),
  limit: z.number().int().min(1).max(50).optional(),
  title: z.string().trim().max(60).optional(),
  options: z
    .object({
      projectId: z.string().max(64).optional(),
      serverId: z.string().max(64).optional(),
      text: z.string().max(4000).optional(),
      weeks: z
        .number()
        .int()
        .refine((v) => (ACTIVITY_WEEKS as readonly number[]).includes(v))
        .optional(),
      links: z
        .array(z.object({ label: z.string().trim().min(1, "Give each shortcut a name").max(40), href: hrefSchema }))
        .max(16)
        .optional(),
    })
    .strip(),
});

const columnOf = <T extends z.ZodTypeAny>(item: T) => z.object({ id: idSchema, width: z.number().int().min(1).max(MAX_WIDTH), items: z.array(item).max(16) });
const titleSchema = z.string().trim().max(60).optional();
const innerRowSchema = z.object({ kind: z.literal("row"), id: idSchema, title: titleSchema, columns: z.array(columnOf(widgetSchema)).min(1).max(MAX_COLS) });

export const layoutSchema = z.object({
  version: z.literal(2),
  rows: z
    .array(
      z.object({
        id: idSchema,
        title: titleSchema,
        columns: z
          .array(columnOf(z.discriminatedUnion("kind", [widgetSchema, innerRowSchema])))
          .min(1)
          .max(MAX_COLS),
      }),
    )
    .max(20),
});

/** A saved layout made safe to render: anything unknown or older than this shape gives the default. */
export function normalizeLayout(value: unknown): DashboardLayout {
  const parsed = layoutSchema.safeParse(value);
  return parsed.success ? (parsed.data as DashboardLayout) : defaultLayout();
}
