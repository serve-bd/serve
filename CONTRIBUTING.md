# Contributing to Serve

Thanks for helping. Bug fixes, templates, docs and features are all welcome. For a larger
change, open an issue or a discussion first, so the approach can be agreed before you spend
time on it.

## Set up

You need Node.js 22, pnpm and Docker.

```sh
git clone https://github.com/serve-bd/serve.git
cd serve
pnpm install
docker compose -f dev/docker-compose.yml up -d   # Postgres for Serve itself, on port 5436
cp .env.example .env
pnpm db:migrate
```

In `.env`, fill in `BETTER_AUTH_SECRET` and `SERVE_ENCRYPTION_KEY` (`openssl rand -hex 32` each)
and change these for a development machine:

```sh
SERVE_DATA_DIR=/absolute/path/to/serve/.data   # a folder you can write to
SERVE_PROXY_HTTP_PORT=8080                       # keep 80 and 443 free
SERVE_PROXY_HTTPS_PORT=8443
SERVE_DASHBOARD_UPSTREAM=host.docker.internal:3000
```

Run the dashboard and the worker in two terminals:

```sh
pnpm dev          # http://localhost:3000
pnpm dev:worker   # deploys, backups, checks
```

## Before a pull request

```sh
pnpm lint
pnpm typecheck
pnpm test
```

CI runs the same checks. Also:

- **Database changes:** edit `src/server/db/schema.ts`, then run `pnpm db:generate` and commit
  the migration with it.
- **Templates:** see [templates/README.md](templates/README.md). Run `pnpm templates:build` and
  commit `templates/index.json` with the template folder. A new template needs no release.
- **Visible changes:** add screenshots in light and dark mode.

## Style

- Code follows the code around it: names, comment density and idiom. Biome formats it.
- Text in the dashboard is plain and specific: say what a control does, name things the way
  users see them, active voice, sentence case.
- Commit messages say what changed and why, in plain sentences.

## License

Serve is under the [Apache License 2.0](LICENSE). By contributing, you agree that your
contribution is licensed the same way.
