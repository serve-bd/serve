/** Tag colors, with the classes of their dot and chip. */
export const TAG_COLORS = {
  gray: "bg-fg-2/10 text-fg-2 ring-fg-2/20",
  red: "bg-bad-soft text-bad ring-bad/25",
  orange: "bg-warn-soft text-warn ring-warn/25",
  green: "bg-ok-soft text-ok ring-ok/25",
  blue: "bg-info-soft text-info ring-info/25",
  purple: "bg-accent-soft text-accent-strong ring-accent/25",
} as const;

export type TagColor = keyof typeof TAG_COLORS;

export const TAG_COLOR_NAMES = Object.keys(TAG_COLORS) as TagColor[];

/** Letters, numbers, dots, dashes and underscores, up to 40: short labels like prod, team-api or v2. */
export const TAG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export function tagColorClass(color: string) {
  return TAG_COLORS[color as TagColor] ?? TAG_COLORS.gray;
}
