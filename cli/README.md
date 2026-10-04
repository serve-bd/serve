# serve CLI

Deploy a folder to your Serve dashboard and manage its services from the terminal. No git
repository needed.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/serve-bd/serve/main/install-cli.sh | sh
```

It installs to `/usr/local/bin` when that is writable, else to `~/.local/bin`. Set
`SERVE_CLI_VERSION=v0.3.2` for a given release. On Windows, download the `.zip` for your
machine from the [releases](https://github.com/serve-bd/serve/releases) and put `serve.exe`
in your PATH.

From source (Go 1.26 or newer): `go install github.com/serve-bd/serve/cli/cmd/serve@latest`.

## Log in

```sh
serve login https://serve.example.com
```

This shows a code and opens the dashboard in your browser. Check that the code matches, pick
the organization and approve. The token appears on the Keys & tokens page, where you can
revoke it. Without a browser, pass `--no-browser` and open the link on any device, or make a
token on Keys & tokens and run `serve login <url> --token <token>`.

Each login is a context. `serve context ls` lists them, `serve context use <name>` switches,
and `--context <name>` picks one for a single command. A folder linked to a dashboard uses the
context for that dashboard.

In CI, set `SERVE_URL` and `SERVE_TOKEN` instead of logging in. Nothing ever prompts without a
terminal: where a choice is needed, the error names the flag to pass.

For a dashboard with a self-signed certificate, pass `--insecure` (or set `SERVE_INSECURE=1`).
`HTTPS_PROXY` is honored.

### On the server that runs Serve

There is no need to log in: run the CLI as root (`sudo serve status`) and it signs in by
itself with the token Serve keeps in `/data/serve/cli.json` (or `$SERVE_DATA_DIR/cli.json`,
for several installs on one machine). This is the `local` context.

To use another instance from that server, run `serve login <url>`; it becomes the current
context. `serve logout` while `local` is in use stops the automatic sign-in (the server's file
is never changed). `serve login --local` or `serve context use local` switches back.

## Deploy

```sh
cd my-app
serve deploy
```

The first time, `serve deploy` offers to create an app for the folder (`serve init`) or to
link an existing one (`serve link`). The link is saved in `.serve/project.json` (and `.serve/`
is added to `.gitignore`).

The folder is packed and uploaded, built on the server and the build log is streamed until the
deployment ends. Left out of the upload:

- what `.gitignore` files (nested ones too, `.git/info/exclude` and your global git ignore
  file) and `.dockerignore` name. A `.serveignore` (same format) replaces the `.gitignore`
  files, so build output that git ignores can still be sent. The deploy says which files it used;
- always `.git`, `.serve`, `node_modules` and `.env` files (pass `--include-env` to keep the
  `.env` files);
- symlinks that point outside the folder, and files that cannot be read (both with a warning).

A home folder, the root folder, or a folder with more than 5,000 files and no project file is
not uploaded without a yes (`--yes` without a terminal). For an app that deploys from git, an
upload is a one-off until the next push; the CLI warns, and asks once per folder.

In a monorepo, deploy a subfolder (`serve deploy apps/web`), or upload a wider folder with
`--root .` when the service builds from a base directory inside it.

In a git checkout, the deployment shows the commit, branch and message, and notes local
changes. Press Ctrl+C while it builds to cancel the deployment or detach from it.

Useful flags: `--message`, `--no-cache`, `--no-wait` (prints the deployment id), `--env
staging` (the service of the same name in another environment), `--service <name>`, `--git`
(deploy the app's own git source instead of the folder), `--yes`. A failed upload is tried
twice more.

Exit codes: 0 done, 1 error, 2 usage error, 3 the deployment failed or was cancelled.

## Commands

| Command | What it does |
| --- | --- |
| `serve login [url]`, `logout`, `whoami` | Log in, log out (revokes the token), show the login |
| `serve login --local` | Use this server's own Serve again |
| `serve context ls\|use\|rm` | List and switch logins (`local` is this server's Serve) |
| `serve init` | Create an app deployed from this folder, and link it |
| `serve link`, `unlink` | Link this folder to a service, or remove the link |
| `serve deploy [path]` | Upload, build and deploy the folder |
| `serve status` | The service, its URL, the running deployment and replicas |
| `serve open [--dashboard]` | Open the service's address, or its page in the dashboard |
| `serve logs [-f] [--tail N]` | The service's logs; `--build [id]` for a build log |
| `serve deployments` | The deployments, newest first |
| `serve redeploy [id]`, `rollback [id]` | Deploy a source again, or run an earlier image again |
| `serve cancel [id]`, `force-start [id]` | Cancel a deployment, or start a queued one now |
| `serve start\|stop\|restart` | Control the service |
| `serve env ls\|get\|set\|unset\|pull\|push` | Environment variables (values hidden unless `--reveal`) |
| `serve domains ls\|add\|rm` | Domains of the service |
| `serve db url [--public]` | The connection string of a database |
| `serve projects`, `services`, `servers` | Browse |
| `serve version` | The version, and whether a newer one is out |
| `serve completion bash\|zsh\|fish\|powershell` | Shell completion script |

Read commands take `--json` for scripts. Commands that work on a service use the linked one,
or `--service <name or id>`.

## Develop

```sh
cd cli
go test ./...
go build -o serve ./cmd/serve
```
