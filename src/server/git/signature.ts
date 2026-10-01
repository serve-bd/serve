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

/** Deliveries seen lately, so a captured signed request cannot be replayed to deploy again. */
const seenDeliveries = new Map<string, number>();
export function deliveryReplayed(headers: Headers) {
  const id = headers.get("x-github-delivery") ?? headers.get("x-gitlab-event-uuid") ?? headers.get("x-gitea-delivery") ?? headers.get("x-request-id");
  if (!id) return false;
  const now = Date.now();
  if (seenDeliveries.size > 5000) for (const [k, t] of seenDeliveries) if (t < now - 3_600_000) seenDeliveries.delete(k);
  if ((seenDeliveries.get(id) ?? 0) > now - 3_600_000) return true;
  seenDeliveries.set(id, now);
  return false;
}
