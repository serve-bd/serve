# Templates

The one-click services in Serve's **New service** catalog. Every Serve instance reads
`templates/index.json` from the `main` branch on GitHub (refreshed every few minutes, in the
background), so a template added here shows up without a new release. The copy inside each
release's image is the fallback when GitHub cannot be reached.

## Add a template

1. Make a folder named after the template's id (lowercase letters, numbers and hyphens):

   ```
   templates/my-app/
     template.json   details shown in the catalog
     compose.yml     the stack
     logo.svg        optional: a white glyph on a transparent background
   ```

2. `template.json`:

   ```json
   {
     "name": "My App",
     "description": "One short sentence.",
     "category": "Productivity",
     "website": "https://example.com",
     "color": "#2563EB",
     "expose": { "service": "app", "port": 8080 },
     "vars": [
       { "key": "DB_PASSWORD", "generate": "password" },
       { "key": "APP_URL", "publicUrl": true },
       { "key": "ADMIN_EMAIL", "value": "admin@example.com", "label": "Admin email" }
     ]
   }
   ```

   - `expose`: the compose service and port that get the generated domain.
   - `vars`: every `${VAR}` in `compose.yml` without a default. A var has one of
     `generate` (`password`, `secret`, `hex32` = 64 hex characters, `hex16` = exactly 32 hex characters,
     `base64key`), `publicUrl` (https://domain),
     `publicHost` (domain only) or `value`. `label` shows it on the configure step.
   - Optional: `popular` (shown first), `note` (shown before creating: first login, extra ports),
     `hostAccess` (mounts the Docker socket or host paths: only Root admins may create it),
     `minVersion` (the oldest Serve version that can run it).
   - `hex16` needs Serve 0.1.9 or newer; older versions leave such a template out on their own.

3. `compose.yml`: pin a major version where the project publishes one, add `restart: unless-stopped`,
   health checks on databases and `depends_on: { condition: service_healthy }` on what needs them.
   Use named volumes and declare them. No `ports:` unless the app needs a non-HTTP port.

4. Run `pnpm templates:build` and commit the folder and `templates/index.json` together.
   `pnpm test` checks every template and that `index.json` is up to date.
