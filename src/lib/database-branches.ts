/** Branch names, as typed and as used in references: lowercase letters, digits and dashes. */
export const branchNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

/** Variables each branch provides, read as ${{<database>.branches.<name>.<VAR>}}. */
export const BRANCH_VARS = ["DATABASE_URL", "POSTGRES_URL", "HOST", "PORT", "USERNAME", "PASSWORD", "DATABASE"] as const;

export const branchReference = (serviceRefName: string, branch: string, key = "DATABASE_URL") => `\${{${serviceRefName}.branches.${branch}.${key}}}`;

/** The name of a pull request preview's branch. */
export const previewBranchName = (pr: number) => `pr-${pr}`;
/** Names like pr-12 belong to pull request previews: a branch made by hand with one would be taken over by the preview. */
export const isPreviewBranchName = (name: string) => /^pr-\d+$/.test(name);

/**
 * The database and role a branch uses inside Postgres: the main database's name and the branch
 * name, joined and kept within Postgres' 63-character limit.
 */
export function branchDatabaseName(mainDatabase: string, branch: string) {
  const base =
    mainDatabase
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 30) || "db";
  return `${base}__${branch.replace(/-/g, "_")}`.slice(0, 63);
}
