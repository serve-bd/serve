/** Saved in place of database names: every database on the server when the backup runs, new ones included. */
export const ALL_DATABASES = "*";

/** With ALL_DATABASES, "!name" leaves that database out. */
export const SKIP_PREFIX = "!";

/** A saved choice read back: every database (less the skipped ones), or just the named ones. */
export function readChoice(saved: string[]): { all: boolean; skip: string[]; names: string[] } {
  const all = saved.includes(ALL_DATABASES);
  return {
    all,
    skip: all ? saved.filter((d) => d.startsWith(SKIP_PREFIX)).map((d) => d.slice(SKIP_PREFIX.length)) : [],
    names: saved.filter((d) => d !== ALL_DATABASES && !d.startsWith(SKIP_PREFIX)),
  };
}
