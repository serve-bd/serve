import { spawn } from "node:child_process";

export type RunOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
  input?: string;
  /** Values that must never be printed in logs. */
  redact?: string[];
  /**
   * Start from a minimal environment instead of Serve's own. Needed for tools that read
   * variables from their environment (docker compose interpolates ${VAR} from it), so
   * user files can never pull in Serve's secrets.
   */
  isolatedEnv?: boolean;
};

/** Variables tools need to run and reach Docker; nothing of Serve's configuration. */
const SAFE_ENV = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "XDG_RUNTIME_DIR", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "DOCKER_CONTEXT", "SSH_AUTH_SOCK"];

function baseEnv(isolated?: boolean): Record<string, string | undefined> {
  if (!isolated) return process.env;
  return Object.fromEntries(SAFE_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
}

export class CommandError extends Error {
  constructor(
    message: string,
    public exitCode: number | null,
    public output: string,
  ) {
    super(message);
  }
}

function redactor(secrets: string[] = []) {
  const list = secrets.filter((s) => s && s.length >= 4);
  return (line: string) => list.reduce((acc, s) => acc.split(s).join("********"), line);
}

/** Spawn a process, stream its output line by line and resolve with the full output. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const redact = redactor(opts.redact);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...baseEnv(opts.isolatedEnv), ...opts.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      signal: opts.signal,
    });
    let output = "";
    let pending = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
      pending += text;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) opts.onLine?.(redact(line));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
    child.on("error", (error) => reject(new CommandError(error.message, null, redact(output))));
    child.on("close", (code) => {
      if (pending.trim()) opts.onLine?.(redact(pending));
      if (code === 0) resolve(redact(output));
      else reject(new CommandError(`${cmd} ${args[0] ?? ""} exited with code ${code}`, code, redact(output)));
    });
  });
}

export async function commandExists(cmd: string): Promise<boolean> {
  try {
    await run("sh", ["-c", `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
}
