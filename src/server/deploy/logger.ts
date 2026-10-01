import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";

const MAX_LOG_BYTES = 4_000_000;

export type StepLog = { line: (text: string) => void; step: (title: string) => void };

/** Buffers log lines and appends them to the deployment row in batches. */
export class DeployLogger {
  private buffer: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private redactions: string[] = [];

  constructor(private deploymentId: string) {}

  redact(values: string[]) {
    this.redactions.push(...values.filter((v) => v && v.length >= 4));
  }

  /** Text with every redacted value masked (for errors stored or sent outside the log). */
  scrub(text: string) {
    return this.clean(text);
  }

  private clean(line: string) {
    let out = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
    for (const secret of this.redactions) out = out.split(secret).join("********");
    return out;
  }

  line = (text: string) => {
    for (const l of text.split("\n")) this.buffer.push(this.clean(l));
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), 400);
  };

  step = (title: string) => this.line(`==> ${title}`);

  /** The same log with every line prefixed, for work on one of several servers. */
  scoped(prefix: string): StepLog {
    return {
      line: (text) =>
        this.line(
          text
            .split("\n")
            .map((l) => `[${prefix}] ${l}`)
            .join("\n"),
        ),
      step: (title) => this.line(`==> [${prefix}] ${title}`),
    };
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer.length) return this.flushing;
    const chunk = this.buffer.join("\n") + "\n";
    this.buffer = [];
    this.flushing = this.flushing
      .then(async () => {
        await db
          .update(schema.deployment)
          .set({
            logs: sql`CASE WHEN length(${schema.deployment.logs}) > ${MAX_LOG_BYTES}::int
            THEN right(${schema.deployment.logs}, ${MAX_LOG_BYTES / 2}::int) || ${chunk}
            ELSE ${schema.deployment.logs} || ${chunk} END`,
          })
          .where(eq(schema.deployment.id, this.deploymentId));
      })
      .catch(() => {});
    return this.flushing;
  }
}
