/** YAML comments removed (a `#` at line start or after whitespace, outside quotes is close enough here). */
function stripComments(content: string) {
  return content
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/**
 * `${VAR}` names a compose file interpolates (ignores `$${…}` escapes and comments).
 * `hasDefault` is true when the file still works with the variable unset:
 * `${VAR-x}`, `${VAR:-x}`, `${VAR+x}` and `${VAR:+x}`.
 * `required` is set by `${VAR:?message}`: the value must not be empty either, and `message` is the
 * file's own explanation (or null).
 */
export function composeVariables(content: string): { name: string; hasDefault: boolean; required: boolean; message: string | null }[] {
  const seen = new Map<string, { hasDefault: boolean; required: boolean; message: string | null }>();
  // `$$` is a literal dollar: dropped first, so `$$${VAR}` still names VAR.
  for (const m of stripComments(content)
    .replace(/\$\$/g, "")
    .matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?+][^}]*)?\}/g)) {
    const hasDefault = !!m[2] && /^:?[-+]/.test(m[2]);
    const required = !!m[2]?.startsWith(":?");
    const message = m[2] && /^:?\?/.test(m[2]) ? m[2].replace(/^:?\?/, "").trim() || null : null;
    const was = seen.get(m[1]);
    seen.set(m[1], { hasDefault: (was?.hasDefault ?? false) || hasDefault, required: (was?.required ?? false) || required, message: was?.message ?? message });
  }
  return [...seen].map(([name, v]) => ({ name, ...v }));
}

/** A reasonable first guess for how a detected variable should be filled. */
/** Credentials issued by another service (cloud keys, OAuth apps, API tokens): the user must supply them. */
const THIRD_PARTY =
  /^(AWS|R2|S3|B2|GCP|GOOGLE|AZURE|GITHUB|GITLAB|BITBUCKET|STRIPE|PAYPAL|SMTP|MAIL|MAILGUN|SENDGRID|POSTMARK|RESEND|SES|SNS|CLOUDFLARE|CF|OPENAI|ANTHROPIC|SENTRY|TWILIO|SLACK|DISCORD|TELEGRAM|FIREBASE|SUPABASE|DO|SPACES)_|(CLIENT_ID|CLIENT_SECRET|ACCESS_KEY|ACCESS_KEY_ID|SECRET_ACCESS_KEY|API_KEY|API_TOKEN|API_SECRET|ACCOUNT_ID|AUTH_TOKEN|BOT_TOKEN|APP_PASSWORD)$/i;

/** Secrets an app only needs to be random and stable: safe to generate. */
const SELF_ISSUED = /(AUTH_SECRET|SESSION_SECRET|COOKIE_SECRET|JWT_SECRET|ENCRYPTION_KEY|SECRET_KEY_BASE|SECRET_KEY|APP_KEY|APP_SECRET|SIGNING_SECRET|WEBHOOK_SECRET|SALT)$/i;

/**
 * How a ${VARIABLE} is probably filled. Only values the stack creates for itself are
 * generated (database passwords, session secrets); anything that looks like a key from
 * another service stays empty for the user to paste.
 */
export function guessVarKind(name: string): "password" | "secret" | "publicUrl" | "value" {
  if (/(PUBLIC_URL|BASE_URL|SITE_URL|ROOT_URL|APP_URL|WEBHOOK_URL|EXTERNAL_URL)$/i.test(name)) return "publicUrl";
  if (THIRD_PARTY.test(name)) return "value";
  if (/(PASSWORD|PASS|PASSWD)$/i.test(name)) return "password";
  if (SELF_ISSUED.test(name)) return "secret";
  return "value";
}
