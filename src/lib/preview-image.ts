/**
 * The app's image with another tag or digest: `repo:tag` or `repo@sha256:…`. Null when `tag` is
 * neither a Docker tag nor a sha256 digest.
 */
export function imageWithTag(image: string, tag: string) {
  const ref = image.trim().split("@")[0];
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  const repo = colon > slash ? ref.slice(0, colon) : ref;
  const t = tag.trim();
  if (/^sha256:[a-f0-9]{64}$/.test(t)) return `${repo}@${t}`;
  if (/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(t)) return `${repo}:${t}`;
  return null;
}
