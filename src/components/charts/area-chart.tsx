"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type Point = { t: number; v: number | null };

/** Minimal responsive SVG area chart with hover readout. */
export function AreaChart({
  data,
  color = "var(--accent)",
  height = 120,
  max,
  format = (v) => v.toFixed(1),
  className,
}: {
  data: Point[];
  color?: string;
  height?: number;
  max?: number;
  format?: (v: number) => string;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(600);
  const [hover, setHover] = React.useState<number | null>(null);
  const id = React.useId().replace(/:/g, "");

  React.useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const points = data.filter((d) => d.v !== null) as { t: number; v: number }[];
  if (points.length < 2) {
    return (
      <div ref={ref} className={cn("flex items-center justify-center text-xs text-faint", className)} style={{ height }}>
        Collecting data…
      </div>
    );
  }
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const top = max ?? (Math.max(...points.map((p) => p.v)) * 1.15 || 1);
  const pad = 4;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * width;
  const y = (v: number) => height - pad - (Math.min(v, top) / top) * (height - pad * 2);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = `${line}L${width},${height}L0,${height}Z`;
  const h = hover !== null ? points[hover] : null;

  return (
    <div
      ref={ref}
      className={cn("relative select-none", className)}
      style={{ height }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const t = t0 + ((e.clientX - rect.left) / rect.width) * (t1 - t0);
        let best = 0;
        for (let i = 1; i < points.length; i++) if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
        setHover(best);
      }}
      onMouseLeave={() => setHover(null)}
    >
      <svg width={width} height={height} className="block overflow-visible">
        <defs>
          <linearGradient id={`g${id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={width} y1={height * f} y2={height * f} stroke="var(--line)" strokeDasharray="2 4" />
        ))}
        <path d={area} fill={`url(#g${id})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
        {h && (
          <>
            <line x1={x(h.t)} x2={x(h.t)} y1="0" y2={height} stroke="var(--line-strong)" />
            <circle cx={x(h.t)} cy={y(h.v)} r="3.5" fill={color} stroke="var(--surface)" strokeWidth="2" />
          </>
        )}
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute -top-2 rounded-md border border-line bg-surface px-2 py-1 text-[11px] whitespace-nowrap shadow-md"
          style={{ left: Math.min(Math.max(x(h.t) - 50, 0), width - 110) }}
        >
          <span className="font-medium text-fg">{format(h.v)}</span>
          <span className="ml-1.5 text-faint">{new Date(h.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      )}
    </div>
  );
}

/** Horizontal usage meter. */
/** A usage bar: grey, and red only when it is critical (over 90%). */
export function Meter({ value, max, color = "color-mix(in oklab, var(--fg) 35%, transparent)" }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const tone = pct > 90 ? "var(--bad)" : color;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
      <div className="h-full rounded-full transition-[width] duration-700 ease-[var(--ease-out-quint)]" style={{ width: `${pct}%`, background: tone }} />
    </div>
  );
}
