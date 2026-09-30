import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROLLED_BACK_EXIT, updaterScript } from "@/server/instance/updater-script";

const PREV = "ghcr.io/acme/serve:0.1.0";
const NEW = "ghcr.io/acme/serve:0.1.1";
let dirs: string[] = [];

/** Runs the update script against a fake `docker` that answers from environment variables. */
function run(opts: { health?: string; image?: string; worker?: string; upFails?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-updater-"));
  dirs.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, ".env"), `SERVE_DB_PASSWORD=x\nSERVE_IMAGE=${PREV}\nOTHER=1\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "docker-compose.yml"), "old: true\n");
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh
echo "docker $*" >> "$CALLS"
if [ "$1" = compose ]; then
  case "$*" in *" up "*) echo "up SERVE_IMAGE=$(grep '^SERVE_IMAGE=' "$DIR/.env" | cut -d= -f2)" >> "$CALLS"; [ "$UP_FAILS" = 1 ] && [ "$(grep '^SERVE_IMAGE=' "$DIR/.env" | cut -d= -f2)" = "${NEW}" ] && exit 1 ;; esac
  exit 0
fi
if [ "$1" = inspect ]; then
  case "$3" in
    *Health*) echo "$HEALTH" ;;
    *RestartCount*) echo "$WORKER" ;;
    *) echo "$IMAGE" ;;
  esac
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const calls = path.join(dir, "calls.log");
  let code = 0;
  let out = "";
  try {
    out = execFileSync("sh", ["-c", updaterScript({ dir, previousImage: PREV, image: NEW, healthTimeoutSeconds: 20, settleSeconds: 0 })], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CALLS: calls,
        DIR: dir,
        HEALTH: opts.health ?? "healthy",
        IMAGE: opts.image ?? NEW,
        WORKER: opts.worker ?? `running 0 ${NEW}`,
        UP_FAILS: opts.upFails ? "1" : "0",
      },
      encoding: "utf8",
    });
  } catch (e) {
    const err = e as { status: number; stdout: string };
    code = err.status;
    out = err.stdout;
  }
  const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
  return { code, out, env, calls: fs.readFileSync(calls, "utf8"), dir, mode: fs.statSync(path.join(dir, ".env")).mode & 0o777 };
}

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("update script", () => {
  it("moves the install to the new image and keeps the rest of .env", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.env).toBe(`SERVE_DB_PASSWORD=x\nSERVE_IMAGE=${NEW}\nOTHER=1\n`);
    expect(r.mode).toBe(0o600);
    expect(r.calls).toContain(`up SERVE_IMAGE=${NEW}`);
    expect(r.out).toContain(`Serve runs ${NEW}.`);
    expect(fs.readFileSync(path.join(r.dir, "docker-compose.previous.yml"), "utf8")).toBe("old: true\n");
  });

  it("rolls back when the dashboard reports unhealthy", () => {
    const r = run({ health: "unhealthy" });
    expect(r.code).toBe(ROLLED_BACK_EXIT);
    expect(r.env).toContain(`SERVE_IMAGE=${PREV}`);
    expect(r.calls.trim().split("\n").at(-1)).toBe(`up SERVE_IMAGE=${PREV}`);
    expect(r.out).toContain("The previous version runs again");
  });

  it("rolls back when the dashboard never becomes healthy", () => {
    const r = run({ health: "starting" });
    expect(r.code).toBe(ROLLED_BACK_EXIT);
    expect(r.out).toContain("did not become healthy within 20 seconds");
    expect(r.env).toContain(`SERVE_IMAGE=${PREV}`);
  });

  it("does not accept a healthy container still on the old image", () => {
    const r = run({ image: PREV });
    expect(r.code).toBe(ROLLED_BACK_EXIT);
  });

  it("rolls back when the worker keeps restarting", () => {
    const r = run({ worker: `restarting 3 ${NEW}` });
    expect(r.code).toBe(ROLLED_BACK_EXIT);
    expect(r.out).toContain("worker did not stay up");
  });

  it("rolls back when compose cannot start the new version", () => {
    const r = run({ upFails: true });
    expect(r.code).toBe(ROLLED_BACK_EXIT);
    expect(r.env).toContain(`SERVE_IMAGE=${PREV}`);
    expect(fs.readFileSync(path.join(r.dir, "docker-compose.yml"), "utf8")).toBe("old: true\n");
  });

  it("quotes paths safely", () => {
    expect(updaterScript({ dir: "/data/it's", previousImage: PREV, image: NEW })).toContain(`D='/data/it'\\''s'`);
  });
});
