import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const nano = customAlphabet(alphabet, 16);
const short = customAlphabet(alphabet, 6);

export const newId = () => nano();
export const shortId = () => short();

/** Lowercase, docker/dns-safe slug. */
export function slugify(value: string, max = 40): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "app"
  );
}
