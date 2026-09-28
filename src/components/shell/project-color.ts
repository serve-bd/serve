export const projectColors: Record<string, string> = {
  amber: "#e89b2c",
  blue: "#4c8dff",
  green: "#2fbf71",
  violet: "#9b7bff",
  pink: "#ec5f9c",
  teal: "#23b8b0",
  red: "#ef5a52",
  slate: "#8792a2",
};

export function projectColor(name: string | null | undefined) {
  return projectColors[name ?? ""] ?? projectColors.blue;
}
