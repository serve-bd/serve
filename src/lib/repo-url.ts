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

/**
 * A git repository URL without any login in it (https://token@host/…), safe to write into an
 * image label. SSH addresses (git@host:owner/repo) become https ones. Null when it is not a URL.
 */
export function repoUrlWithoutLogin(url: string): string | null {
  const value = url.trim();
  const ssh = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(value);
  if (ssh) return `https://${ssh[1]}/${ssh[2].replace(/\.git$/, "")}`;
  try {
    const ssh2 = value.startsWith("ssh://");
    const u = new URL(ssh2 ? value.replace(/^ssh:\/\//, "https://") : value);
    if (!["https:", "http:"].includes(u.protocol)) return null;
    u.username = "";
    u.password = "";
    // An ssh:// port is the ssh server's, not the web one.
    if (ssh2) u.port = "";
    return u
      .toString()
      .replace(/\.git$/, "")
      .replace(/\/$/, "");
  } catch {
    return null;
  }
}
