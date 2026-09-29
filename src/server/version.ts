import journal from "../../drizzle/meta/_journal.json";

/**
 * Latest database migration this code knows about. The worker reports the
 * value it was built with, so the dashboard can tell when a long-running
 * worker (or an old dist/worker.cjs) is behind the code.
 */
export const SCHEMA_VERSION: string = journal.entries.at(-1)?.tag ?? "none";
