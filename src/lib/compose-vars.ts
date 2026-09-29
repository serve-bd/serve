/** `${VAR}` names a compose file interpolates (ignores `$${…}` escapes). */
export function composeVariables(content: string): { name: string; hasDefault: boolean }[] {
  const seen = new Map<string, boolean>();
  for (const m of content.matchAll(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?+][^}]*)?\}/g)) {
    const hasDefault = !!m[2] && /^:?-/.test(m[2]);
    seen.set(m[1], (seen.get(m[1]) ?? false) || hasDefault);
  }
  return [...seen].map(([name, hasDefault]) => ({ name, hasDefault }));
}

/** A reasonable first guess for how a detected variable should be filled. */
export function guessVarKind(name: string): "password" | "secret" | "publicUrl" | "value" {
  if (/(PASSWORD|PASS|PASSWD)$/i.test(name)) return "password";
  if (/(SECRET|TOKEN|KEY|SALT)(_BASE)?$/i.test(name)) return "secret";
  if (/(PUBLIC_URL|BASE_URL|SITE_URL|ROOT_URL|APP_URL|WEBHOOK_URL|EXTERNAL_URL)$/i.test(name)) return "publicUrl";
  return "value";
}
