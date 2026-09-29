import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { env } from "@/server/env";
import { getSettings, type Settings } from "@/server/settings";

export type SecurityCheck = {
  id: string;
  title: string;
  status: "ok" | "warn" | "info";
  detail: string;
  href?: string;
  action?: string;
};

/** Plain-language security review of this server's configuration. */
export async function securityChecks(settings?: Settings): Promise<SecurityCheck[]> {
  const s = settings ?? (await getSettings());
  const checks: SecurityCheck[] = [];

  if (!s.dashboardDomain) {
    checks.push({
      id: "dashboard-domain",
      title: "Dashboard has no domain",
      status: "warn",
      detail: "The dashboard is reached over plain HTTP on its port. Give it a domain so sign-ins travel over HTTPS.",
      href: "/settings/dashboard",
      action: "Set domain",
    });
  } else if (!s.dashboardHttps) {
    checks.push({
      id: "dashboard-https",
      title: "Dashboard domain is not using HTTPS",
      status: "warn",
      detail: `${s.dashboardDomain} is served without TLS. Passwords and sessions can be read on the network.`,
      href: "/settings/dashboard",
      action: "Turn on HTTPS",
    });
  } else {
    checks.push({ id: "dashboard-https", title: "Dashboard uses HTTPS", status: "ok", detail: `Served at https://${s.dashboardDomain}.` });
  }

  if (!s.acmeEmail) {
    checks.push({
      id: "acme",
      title: "Let's Encrypt is not set up",
      status: "warn",
      detail: "Without an account email, Serve cannot issue or renew certificates automatically.",
      href: "/settings/dashboard",
      action: "Add email",
    });
  } else if (s.acmeStaging) {
    checks.push({
      id: "acme",
      title: "Let's Encrypt staging is on",
      status: "warn",
      detail: "New certificates are test certificates that browsers do not trust.",
      href: "/settings/dashboard",
      action: "Turn off",
    });
  } else {
    checks.push({ id: "acme", title: "Certificates renew automatically", status: "ok", detail: `Let's Encrypt account: ${s.acmeEmail}.` });
  }

  if (s.rootOrganizationId) {
    const admins = await db
      .select({ name: schema.user.name, twoFactor: schema.user.twoFactorEnabled })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
      .where(and(eq(schema.member.organizationId, s.rootOrganizationId), inArray(schema.member.role, ["owner", "admin"])));
    const without = admins.filter((a) => !a.twoFactor);
    checks.push(
      without.length
        ? {
            id: "two-factor",
            title: `${without.length} server admin${without.length === 1 ? "" : "s"} without two-factor`,
            status: "warn",
            detail: `Root admins control every organization and the host. Missing: ${without.map((a) => a.name).join(", ")}.`,
            href: "/account",
            action: "Set up yours",
          }
        : { id: "two-factor", title: "All server admins use two-factor", status: "ok", detail: `${admins.length} Root admin${admins.length === 1 ? "" : "s"} protected.` },
    );
  }

  checks.push(
    s.dashboardAllowlist.length
      ? { id: "allowlist", title: "Dashboard access is limited by IP", status: "ok", detail: `${s.dashboardAllowlist.length} allowed address${s.dashboardAllowlist.length === 1 ? "" : "es"} or range${s.dashboardAllowlist.length === 1 ? "" : "s"}.` }
      : {
          id: "allowlist",
          title: "Anyone can open the dashboard sign-in",
          status: "info",
          detail: s.dashboardDomain ? "Limit the dashboard domain to office or VPN addresses below." : "Set a dashboard domain to limit access by IP.",
        },
  );

  checks.push({
    id: "port",
    title: `Close the dashboard port once the domain works`,
    status: "info",
    detail: `The dashboard also listens on its own port (${env.appUrl.replace(/^https?:\/\//, "")}). After the domain works, block that port in your firewall and keep 80 and 443 open.`,
  });

  checks.push({
    id: "docker",
    title: "Serve controls Docker on this host",
    status: "info",
    detail: "The worker uses the Docker socket, which equals root access. Run Serve on a server dedicated to it and give admin roles carefully.",
  });

  return checks;
}
