"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, CircleCheck, CircleDashed, CircleX, Rss, TriangleAlert, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { cleanCss, formatPercent, LEVEL_TEXT, OVERALL_TEXT, type StatusDesign, type StatusLevel } from "@/lib/status-page";
import type { ComponentView, NoticeView, StatusView as View } from "@/server/status-pages/data";

/* Theme tokens of the page itself: it never takes the dashboard's colors. */
const LIGHT = `--sp-bg:#f6f7f9;--sp-surface:#ffffff;--sp-sunken:#eef0f3;--sp-fg:#14161a;--sp-fg2:#3b3f46;--sp-muted:#6b7079;--sp-line:rgb(20 22 26/.09);--sp-ok:#1a9a52;--sp-warn:#c47a00;--sp-orange:#e0601b;--sp-bad:#d9342b;--sp-maint:#2f6fdb;--sp-idle:#cfd3da;color-scheme:light;`;
const DARK = `--sp-bg:#0c0d10;--sp-surface:#15171b;--sp-sunken:#1c1f24;--sp-fg:#f2f3f5;--sp-fg2:#c9ccd2;--sp-muted:#8b9099;--sp-line:rgb(255 255 255/.08);--sp-ok:#2fbf6c;--sp-warn:#e2a03a;--sp-orange:#f07a3a;--sp-bad:#f0564c;--sp-maint:#5b8ff0;--sp-idle:#30343b;color-scheme:dark;`;

function themeCss(accent: string | null) {
  const a = accent ? `--sp-accent:${accent};` : "--sp-accent:var(--sp-fg);";
  return [
    `.sp{${LIGHT}${a}}`,
    `.sp[data-theme-mode="dark"]{${DARK}}`,
    `@media (prefers-color-scheme: dark){.sp[data-theme-mode="auto"]{${DARK}}}`,
    `.sp .sp-dark-only{display:none}`,
    // A phone fits about 30 bars: older days give way, and the caption says so.
    `.sp .sp-component{container-type:inline-size}.sp .sp-days-short{display:none}`,
    `@container (max-width: 480px){.sp .sp-old{display:none}.sp .sp-days-full{display:none}.sp .sp-days-short{display:inline}}`,
    `.sp[data-theme-mode="dark"] .sp-dark-only{display:inline-block}.sp[data-theme-mode="dark"] .sp-light-only{display:none}`,
    `@media (prefers-color-scheme: dark){.sp[data-theme-mode="auto"] .sp-dark-only{display:inline-block}.sp[data-theme-mode="auto"] .sp-light-only{display:none}}`,
  ].join("\n");
}

const FONTS: Record<StatusDesign["font"], string> = {
  sans: "var(--font-body), ui-sans-serif, system-ui, sans-serif",
  serif: '"Iowan Old Style", "Charter", "Source Serif Pro", Georgia, ui-serif, serif',
  mono: "var(--font-code), ui-monospace, SFMono-Regular, Menlo, monospace",
};

const LEVEL_COLOR: Record<StatusLevel, string> = {
  operational: "var(--sp-ok)",
  maintenance: "var(--sp-maint)",
  degraded: "var(--sp-warn)",
  partial: "var(--sp-orange)",
  major: "var(--sp-bad)",
  unknown: "var(--sp-idle)",
};

function LevelIcon({ level, className }: { level: StatusLevel; className?: string }) {
  const Icon = { operational: CircleCheck, maintenance: Wrench, degraded: TriangleAlert, partial: CircleAlert, major: CircleX, unknown: CircleDashed }[level];
  return <Icon className={className} style={{ color: LEVEL_COLOR[level] }} aria-hidden />;
}

/** Times in the visitor's own zone. The server renders UTC; the browser swaps in local time. */
function LocalTime({ iso, withDate = true }: { iso: string; withDate?: boolean }) {
  const [text, setText] = React.useState<string | null>(null);
  React.useEffect(() => {
    const d = new Date(iso);
    setText(
      withDate
        ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    );
  }, [iso, withDate]);
  const utc = new Date(iso);
  const fallback = `${withDate ? `${utc.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ` : ""}${utc.toISOString().slice(11, 16)} UTC`;
  return <time dateTime={iso}>{text ?? fallback}</time>;
}

const dayName = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function duration(fromIso: string, toIso: string | null) {
  const ms = (toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso);
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : `${Math.round(h / 24)} days`;
}

export type StatusViewProps = {
  view: View;
  design: StatusDesign;
  /** Path the page's own links start with: "" on its own domain, /status/<slug> on the dashboard's. */
  base: string;
  /** Refresh every minute (the public page; not the editor's preview). */
  live?: boolean;
  /** Shown above everything, like "Draft: only members see this page". */
  note?: string | null;
  /** The footer credit: the product's name, and a link only for the default one. */
  poweredBy: { name: string; url: string | null };
};

export function StatusView({ view, design, base, live, note, poweredBy }: StatusViewProps) {
  const router = useRouter();
  React.useEffect(() => {
    if (!live) return;
    const t = setInterval(() => router.refresh(), 60_000);
    return () => clearInterval(t);
  }, [live, router]);

  const radius = design.corners === "square" ? "0px" : "14px";
  const pad = design.density === "compact" ? "14px" : "20px";
  const css = cleanCss(design.css);

  return (
    <div
      className="sp min-h-full bg-[var(--sp-bg)] text-[var(--sp-fg)] antialiased"
      data-theme-mode={design.theme}
      style={{ fontFamily: FONTS[design.font], ["--sp-radius" as string]: radius, ["--sp-pad" as string]: pad }}
    >
      <style>{themeCss(design.accent)}</style>
      {css && <style>{css}</style>}
      {note && <div className="sp-note bg-[var(--sp-maint)] px-4 py-2 text-center text-[13px] font-medium text-white">{note}</div>}
      <div className={cn("mx-auto w-full max-w-[760px] px-4 sm:px-6", design.density === "compact" ? "py-8" : "py-12")}>
        <Header view={view} design={design} />
        {design.announcement?.text && (
          <div
            className="sp-announcement mt-6 rounded-[var(--sp-radius)] border px-4 py-3 text-[14px] leading-relaxed"
            style={{
              borderColor: design.announcement.tone === "warn" ? "color-mix(in srgb, var(--sp-warn) 35%, transparent)" : "var(--sp-line)",
              background: design.announcement.tone === "warn" ? "color-mix(in srgb, var(--sp-warn) 10%, var(--sp-surface))" : "var(--sp-surface)",
            }}
          >
            {design.announcement.text}
          </div>
        )}
        <Overall view={view} />
        {view.active.length > 0 && (
          <section className="sp-active mt-6 flex flex-col gap-3" aria-label="Ongoing">
            {view.active.map((n) => (
              <NoticeCard key={n.id} notice={n} open />
            ))}
          </section>
        )}
        {view.upcoming.length > 0 && (
          <section className="sp-upcoming mt-6 flex flex-col gap-3" aria-label="Planned maintenance">
            <h2 className="text-[13px] font-semibold tracking-wide text-[var(--sp-muted)] uppercase">Planned maintenance</h2>
            {view.upcoming.map((n) => (
              <NoticeCard key={n.id} notice={n} open />
            ))}
          </section>
        )}
        <Components view={view} design={design} />
        {design.historyDays > 0 && <History view={view} days={design.historyDays} />}
        <Footer design={design} base={base} poweredBy={poweredBy} />
      </div>
    </div>
  );
}

function Header({ view, design }: { view: View; design: StatusDesign }) {
  const logo = view.logoUrl && (
    <>
      <img src={view.logoUrl} alt={design.showName ? "" : view.name} className={cn("sp-logo h-9 w-auto max-w-[220px] object-contain", view.logoDarkUrl && "sp-light-only")} />
      {view.logoDarkUrl && <img src={view.logoDarkUrl} alt={design.showName ? "" : view.name} className="sp-logo sp-dark-only h-9 w-auto max-w-[220px] object-contain" />}
    </>
  );
  const brand = (
    <span className="flex min-w-0 items-center gap-3">
      {logo}
      {(design.showName || !view.logoUrl) && <span className="sp-name truncate text-[19px] font-semibold tracking-tight">{view.name}</span>}
    </span>
  );
  return (
    <header className="sp-header flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      {design.website ? (
        <a href={design.website} className="min-w-0 rounded-md outline-offset-4" rel="noopener">
          {brand}
        </a>
      ) : (
        brand
      )}
      {design.links.length > 0 && (
        <nav className="sp-links flex flex-wrap items-center gap-x-5 gap-y-1 text-[14px]">
          {design.links.map((l) => (
            <a
              key={`${l.label}-${l.url}`}
              href={l.url}
              className="font-medium text-[var(--sp-fg2)] underline-offset-4 hover:text-[var(--sp-accent)] hover:underline"
              rel="noopener"
            >
              {l.label}
            </a>
          ))}
        </nav>
      )}
      {design.description && <p className="sp-description w-full text-[15px] leading-relaxed text-[var(--sp-muted)]">{design.description}</p>}
    </header>
  );
}

function Overall({ view }: { view: View }) {
  const color = LEVEL_COLOR[view.overall];
  return (
    <section
      className="sp-overall mt-8 flex items-center gap-4 rounded-[var(--sp-radius)] border p-[var(--sp-pad)]"
      style={{ borderColor: `color-mix(in srgb, ${color} 30%, transparent)`, background: `color-mix(in srgb, ${color} 9%, var(--sp-surface))` }}
      data-level={view.overall}
    >
      <span className="relative flex size-10 flex-none items-center justify-center rounded-full" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)` }}>
        {view.overall !== "operational" && view.overall !== "unknown" && (
          <span className="absolute inset-0 animate-ping rounded-full opacity-30 motion-reduce:hidden" style={{ background: color }} />
        )}
        <LevelIcon level={view.overall} className="relative size-6" />
      </span>
      <div className="min-w-0">
        <h1 className="text-[20px] leading-tight font-semibold tracking-tight">{OVERALL_TEXT[view.overall]}</h1>
        <p className="mt-0.5 text-[13px] text-[var(--sp-muted)]">
          Updated <LocalTime iso={view.generatedAt} withDate={false} />
        </p>
      </div>
    </section>
  );
}

function NoticeCard({ notice, open }: { notice: NoticeView; open?: boolean }) {
  const level: StatusLevel =
    notice.kind === "maintenance" ? "maintenance" : notice.done ? "operational" : notice.impact === "minor" ? "degraded" : notice.impact === "major" ? "partial" : "major";
  return (
    <article className="sp-notice overflow-hidden rounded-[var(--sp-radius)] border border-[var(--sp-line)] bg-[var(--sp-surface)]" data-kind={notice.kind}>
      <div className="flex items-start gap-3 p-[var(--sp-pad)]" style={open ? { boxShadow: `inset 3px 0 0 ${LEVEL_COLOR[level]}` } : undefined}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h3 className="text-[15px] font-semibold">{notice.title}</h3>
            <span className="text-[12px] font-medium tracking-wide uppercase" style={{ color: LEVEL_COLOR[level] }}>
              {notice.state}
            </span>
          </div>
          <p className="mt-1 text-[13px] text-[var(--sp-muted)]">
            {notice.kind === "maintenance" && notice.startsAt ? (
              <>
                <LocalTime iso={notice.startsAt} />
                {notice.endsAt && (
                  <>
                    {" "}
                    – <LocalTime iso={notice.endsAt} />
                  </>
                )}
              </>
            ) : notice.startsAt ? (
              <>
                Started <LocalTime iso={notice.startsAt} />
                {notice.resolvedAt ? ` · lasted ${duration(notice.startsAt, notice.resolvedAt)}` : ""}
              </>
            ) : null}
            {notice.components.length > 0 && <> · {notice.components.join(", ")}</>}
          </p>
          {notice.updates.length > 0 && (
            <ol className="sp-updates mt-3 flex flex-col gap-3 border-l border-[var(--sp-line)] pl-4">
              {notice.updates.map((u) => (
                <li key={`${u.at}-${u.state}`} className="relative">
                  <span className="absolute top-[7px] -left-[20.5px] size-2 rounded-full border-2 border-[var(--sp-surface)] bg-[var(--sp-muted)]" />
                  <p className="text-[14px] leading-relaxed whitespace-pre-line text-[var(--sp-fg2)]">
                    <span className="font-semibold text-[var(--sp-fg)]">{u.state}</span> — {u.body}
                  </p>
                  <p className="mt-0.5 text-[12px] text-[var(--sp-muted)]">
                    <LocalTime iso={u.at} />
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </article>
  );
}

function Components({ view, design }: { view: View; design: StatusDesign }) {
  if (!view.groups.length) return null;
  return (
    <section className="sp-components mt-8 flex flex-col gap-5" aria-label="Components">
      {view.groups.map((g, i) => (
        <div key={g.name ?? `ungrouped-${i}`} className="sp-group">
          {g.name && <h2 className="mb-2.5 text-[13px] font-semibold tracking-wide text-[var(--sp-muted)] uppercase">{g.name}</h2>}
          <div className="divide-y divide-[var(--sp-line)] overflow-hidden rounded-[var(--sp-radius)] border border-[var(--sp-line)] bg-[var(--sp-surface)]">
            {g.components.map((c) => (
              <ComponentRow key={c.id} c={c} design={design} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function ComponentRow({ c, design }: { c: ComponentView; design: StatusDesign }) {
  return (
    <div className="sp-component p-[var(--sp-pad)]" data-level={c.level}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[15px] font-medium">{c.name}</h3>
          {c.description && <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--sp-muted)]">{c.description}</p>}
        </div>
        <div className="flex flex-none items-center gap-2 text-[13px] font-medium" style={{ color: LEVEL_COLOR[c.level] }}>
          {LEVEL_TEXT[c.level]}
          <LevelIcon level={c.level} className="size-4" />
        </div>
      </div>
      {design.showBars && <Bars c={c} days={design.days} square={design.corners === "square"} />}
      {(design.showBars || design.showUptime || design.showLatency) && (
        <div className="mt-2 flex items-center justify-between gap-3 text-[12px] text-[var(--sp-muted)]">
          {design.showBars ? (
            <span>
              <span className="sp-days-full">{design.days} days ago</span>
              <span className="sp-days-short">{Math.min(design.days, PHONE_DAYS)} days ago</span>
            </span>
          ) : (
            <span />
          )}
          <span className="flex items-center gap-3 tabular-nums">
            {design.showUptime && c.monitored && <span>{formatPercent(c.uptime)} uptime</span>}
            {design.showLatency && c.latency !== null && <span>{c.latency} ms</span>}
          </span>
          {design.showBars ? <span>Today</span> : <span />}
        </div>
      )}
    </div>
  );
}

const PHONE_DAYS = 30;

function Bars({ c, days, square }: { c: ComponentView; days: number; square: boolean }) {
  // The bar under the pointer and its center, in pixels from the left of the row.
  const [hover, setHover] = React.useState<{ i: number; x: number } | null>(null);
  const bar = hover === null ? null : c.bars[hover.i];
  const pick = (i: number, el: HTMLElement) => setHover({ i, x: el.offsetLeft + el.offsetWidth / 2 });
  return (
    <div className="relative mt-3">
      <div
        className="sp-bars flex h-8 items-stretch"
        style={{ gap: days > 60 ? 2 : 3 }}
        role="img"
        aria-label={`${c.name}: ${c.monitored ? `${formatPercent(c.uptime)} uptime over the last ${days} days` : `status over the last ${days} days`}`}
        onMouseLeave={() => setHover(null)}
      >
        {c.bars.map((b, i) => (
          <span
            key={b.day}
            className={cn(
              "min-w-[2px] flex-1 transition-opacity",
              square ? "rounded-none" : "rounded-[2px]",
              hover !== null && hover.i !== i && "opacity-60",
              i < c.bars.length - PHONE_DAYS && "sp-old",
            )}
            style={{ background: LEVEL_COLOR[b.level] }}
            onMouseEnter={(e) => pick(i, e.currentTarget)}
            onClick={(e) => pick(i, e.currentTarget)}
          />
        ))}
      </div>
      {bar && hover && (
        <div
          className="pointer-events-none absolute bottom-full z-10 mb-2 w-max max-w-[260px] -translate-x-1/2 rounded-lg border border-[var(--sp-line)] bg-[var(--sp-surface)] px-3 py-2 text-[12px] shadow-lg"
          style={{ left: `clamp(110px, ${hover.x}px, calc(100% - 110px))` }}
        >
          <p className="font-semibold">{dayName(bar.day)}</p>
          <p className="text-[var(--sp-muted)]">{bar.uptime !== null ? `${formatPercent(bar.uptime)} uptime` : bar.level === "unknown" ? "No data" : LEVEL_TEXT[bar.level]}</p>
          {bar.notes.map((n) => (
            <p key={n} className="mt-1 text-[var(--sp-fg2)]">
              {n}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function History({ view, days }: { view: View; days: number }) {
  return (
    <section className="sp-history mt-10" aria-label="Past incidents">
      <h2 className="text-[17px] font-semibold tracking-tight">Past incidents</h2>
      {view.history.length === 0 ? (
        <p className="mt-3 text-[14px] text-[var(--sp-muted)]">No incidents in the last {days === 1 ? "day" : `${days} days`}.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-6">
          {view.history.map((d) => (
            <div key={d.day}>
              <h3 className="border-b border-[var(--sp-line)] pb-2 text-[13px] font-semibold text-[var(--sp-fg2)]">{dayName(d.day)}</h3>
              <div className="mt-3 flex flex-col gap-3">
                {d.notices.map((n) => (
                  <NoticeCard key={n.id} notice={n} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Footer({ design, base, poweredBy }: { design: StatusDesign; base: string; poweredBy: StatusViewProps["poweredBy"] }) {
  return (
    <footer className="sp-footer mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--sp-line)] pt-5 text-[13px] text-[var(--sp-muted)]">
      <span className="whitespace-pre-line">{design.footer}</span>
      <span className="flex items-center gap-4">
        <a href={`${base}/feed.xml`} className="inline-flex items-center gap-1.5 hover:text-[var(--sp-accent)]">
          <Rss className="size-3.5" /> RSS
        </a>
        {!design.hideBadge &&
          (poweredBy.url ? (
            <a href={poweredBy.url} className="hover:text-[var(--sp-accent)]" rel="noopener">
              Powered by {poweredBy.name}
            </a>
          ) : (
            <span>Powered by {poweredBy.name}</span>
          ))}
      </span>
    </footer>
  );
}
