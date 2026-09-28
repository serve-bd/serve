/** Network alias for a compose service on the shared Serve network. */
export function composeAlias(slug: string, composeService: string) {
  return `${slug}-${composeService}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
