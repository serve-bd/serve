/**
 * A repository address git may fetch: https/http, ssh:// or scp-like (git@host:path). Local
 * paths, file:// and git's other transports would read repositories on the server itself, and a
 * leading "-" would be taken for an option.
 */
export function repoUrlProblem(url: string): string | null {
  const v = url.trim();
  if (!v) return "Enter a repository.";
  if (v.startsWith("-") || /\s/.test(v)) return "Enter a repository address like https://github.com/owner/repo.";
  if (/^https?:\/\/[^/\s]+\/.+/i.test(v) || /^ssh:\/\/[^/\s]+\/.+/i.test(v) || /^[\w.-]+@[\w.-]+:[^\s:][^\s]*$/.test(v)) return null;
  return "Use an https:// or ssh address for the repository.";
}
