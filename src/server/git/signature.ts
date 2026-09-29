import crypto from "node:crypto";
import { timingSafeEqual } from "@/server/crypto";

const hmac = (secret: string, body: string) => crypto.createHmac("sha256", secret).update(body).digest("hex");

/**
 * True when a git webhook delivery is authentic: GitHub (X-Hub-Signature-256), Gitea/Forgejo/Gogs
 * (X-Gitea-Signature, hex HMAC), GitLab (X-Gitlab-Token), Bitbucket (X-Hub-Signature: sha256=…)
 * or a ?secret= query for providers without signing.
 */
export function verifyWebhookSignature(headers: Headers, raw: string, secret: string, query?: string | null): boolean {
  const gh = headers.get("x-hub-signature-256");
  const gitea = headers.get("x-gitea-signature") ?? headers.get("x-gogs-signature");
  const gitlab = headers.get("x-gitlab-token");
  // GitHub also sends a sha1 X-Hub-Signature; only Bitbucket deliveries (X-Event-Key) are checked with it.
  const bitbucket = headers.get("x-event-key") ? headers.get("x-hub-signature") : null;
  return !!(
    (gh && timingSafeEqual(gh, `sha256=${hmac(secret, raw)}`)) ||
    (gitea && timingSafeEqual(gitea, hmac(secret, raw))) ||
    (gitlab && timingSafeEqual(gitlab, secret)) ||
    (bitbucket && timingSafeEqual(bitbucket, `sha256=${hmac(secret, raw)}`)) ||
    (query && timingSafeEqual(query, secret))
  );
}
