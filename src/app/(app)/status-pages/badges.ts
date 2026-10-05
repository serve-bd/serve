import type { StatusLevel, StatusVisibility } from "@/lib/status-page";

/** Dot color of a level in the dashboard. Plain data: the server page and client parts both use it. */
export const levelDot: Record<StatusLevel, string> = {
  operational: "bg-ok",
  maintenance: "bg-info",
  degraded: "bg-warn",
  partial: "bg-warn",
  major: "bg-bad",
  unknown: "bg-idle",
};

export const visibilityBadge: Record<StatusVisibility, { tone: "ok" | "warn" | "neutral"; label: string }> = {
  public: { tone: "ok", label: "Public" },
  password: { tone: "warn", label: "Password" },
  draft: { tone: "neutral", label: "Draft" },
};
