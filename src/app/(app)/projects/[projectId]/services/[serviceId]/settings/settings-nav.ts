/**
 * The settings sub-pages of a service, in nav order. Plain module so both the server
 * route (to 404 unknown sections) and the client nav use the same list.
 */
export type SettingsNavInput = {
  type: string;
  hasSource: boolean;
  gitSource: boolean;
  hasBuild: boolean;
  hasCompose: boolean;
  /** An app from Git that is not itself a preview: gets the Previews page. */
  previews?: boolean;
  db: { engine: string; initScripts: boolean; tls: boolean } | null;
};

export type SettingsNavItem = { id: string; label: string };

export function databaseNav(db: NonNullable<SettingsNavInput["db"]>): SettingsNavItem[] {
  return [
    { id: "details", label: "Details" },
    { id: "credentials", label: "Credentials" },
    ...(db.initScripts || ["postgres", "mysql", "mariadb"].includes(db.engine) ? [{ id: "initialization", label: "Initialization" }] : []),
    { id: "configuration", label: "Configuration" },
    { id: "network", label: "Runtime and network" },
    ...(db.tls ? [{ id: "tls", label: "TLS" }] : []),
    { id: "health", label: "Health check" },
    { id: "storage", label: "Persistent storage" },
  ];
}

export function settingsNav(s: SettingsNavInput): SettingsNavItem[] {
  return [
    { id: "general", label: "General" },
    { id: "server", label: "Server" },
    ...(s.type === "app" ? [{ id: "servers", label: "Servers & registry" }] : []),
    ...(s.hasSource ? [{ id: "source", label: "Source" }] : []),
    ...(s.previews ? [{ id: "previews", label: "Previews" }] : []),
    ...(s.hasBuild && s.gitSource ? [{ id: "build", label: "Build" }] : []),
    ...(s.hasCompose
      ? [
          { id: "compose", label: "Compose file" },
          { id: "networking", label: "Network" },
        ]
      : []),
    ...(s.type === "app"
      ? [
          { id: "deploy", label: "Deploy" },
          { id: "health", label: "Health check" },
          { id: "runtime", label: "Runtime" },
        ]
      : []),
    ...(s.db ? databaseNav(s.db) : []),
    ...(s.type === "app" || s.type === "compose" ? [{ id: "storage", label: "Persistent storage" }] : []),
    ...(s.type !== "compose" ? [{ id: "resources", label: "Resources" }] : []),
    ...(s.type !== "compose" ? [{ id: "advanced", label: "Advanced" }] : []),
    ...(s.type !== "database" ? [{ id: "webhooks", label: "Webhooks" }] : []),
    ...(s.type !== "database" ? [{ id: "maintenance", label: "Maintenance" }] : []),
    { id: "monitoring", label: "Monitoring" },
    { id: "danger", label: "Danger zone" },
  ];
}
