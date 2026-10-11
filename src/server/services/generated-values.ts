import crypto from "node:crypto";
import { randomPassword, randomSecret } from "@/server/crypto";

/** Kinds of values Serve can generate for a variable (templates and serve.json). */
export type GeneratedKind = "password" | "strongPassword" | "secret" | "hex32" | "hex16" | "base64key";

/**
 * For apps that refuse a password without upper and lower case, a digit and a symbol (OpenObserve).
 * The symbol is a dash: safe in URLs, shells and connection strings.
 */
export function strongPassword() {
  const pick = (chars: string) => chars[crypto.randomInt(chars.length)];
  return `${randomPassword(20)}-${pick("ABCDEFGHJKLMNPQRSTUVWXYZ")}${pick("abcdefghijkmnopqrstuvwxyz")}${pick("23456789")}`;
}

/** A new random value of that kind. Kept free of "server-only" so the worker can use it too. */
export function generatedValue(kind: GeneratedKind): string {
  switch (kind) {
    case "password":
      return randomPassword(24);
    case "strongPassword":
      return strongPassword();
    case "secret":
      return randomSecret(32);
    case "hex32":
      // 32 random bytes as 64 hex characters (Rails SECRET_KEY_BASE and similar validate hex).
      return crypto.randomBytes(32).toString("hex");
    case "hex16":
      // 16 random bytes as exactly 32 hex characters, for apps that want a 32-character key.
      return crypto.randomBytes(16).toString("hex");
    case "base64key":
      return `base64:${crypto.randomBytes(32).toString("base64")}`;
  }
}
