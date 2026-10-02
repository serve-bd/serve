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
const SAFE_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CONTEXT",
  "SSH_AUTH_SOCK",
];

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

export function redactor(secrets: string[] = []) {
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
    // A partial line per stream, so stdout and stderr lines do not mix.
    const pending = { stdout: "", stderr: "" };
    const onData = (stream: keyof typeof pending) => (text: string) => {
      output += text;
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
      const lines = (pending[stream] + text).split(/\r?\n|\r/);
      pending[stream] = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) opts.onLine?.(redact(line));
    };
    // Decoded per stream, so a character split between two chunks stays whole.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onData("stdout"));
    child.stderr.on("data", onData("stderr"));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
    child.on("error", (error) => reject(new CommandError(error.message, null, redact(output))));
    child.on("close", (code) => {
      for (const rest of [pending.stdout, pending.stderr]) if (rest.trim()) opts.onLine?.(redact(rest));
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
