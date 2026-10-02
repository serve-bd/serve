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
  const page = path?.[0] ?? "";
  // Own keys only: "/server/constructor" must not find Object.prototype.constructor.
  redirect(Object.hasOwn(TARGETS, page) ? TARGETS[page] : "/servers/local");
}
