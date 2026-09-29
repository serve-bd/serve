import { redirect } from "next/navigation";

/** The single-server pages moved to /servers/<id> and /settings. Old links keep working. */
const TARGETS: Record<string, string> = {
  "": "/servers/local",
  domains: "/servers/local/domains",
  proxy: "/servers/local/proxy",
  resources: "/servers/local/resources",
  terminal: "/servers/local/terminal",
  cleanup: "/servers/local/cleanup",
  metrics: "/servers/local/metrics",
  advanced: "/settings/advanced",
  security: "/settings/security",
};

export default async function LegacyServerPage(props: PageProps<"/server/[[...path]]">) {
  const { path } = await props.params;
  redirect(TARGETS[path?.[0] ?? ""] ?? "/servers/local");
}
