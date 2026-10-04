import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getSession } from "@/server/auth";
import { getSettings } from "@/server/settings";
import { pendingCliLogin, takeCodeLookup } from "@/server/cli-login";
import { normalizeUserCode } from "@/lib/cli-login";
import { buttonVariants } from "@/components/ui/button";
import { TimeAgo } from "@/components/ui/misc";
import { AuthCard } from "../../_components/auth-card";
import { memberAccess } from "@/server/permissions";
import { CliApproval, CodeForm } from "./cli-approval";

export const metadata = { title: "Sign in the CLI" };

export default async function CliLoginPage(props: PageProps<"/cli/login">) {
  const { code: raw } = await props.searchParams;
  const code = normalizeUserCode(raw);
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/cli/login${code ? `?code=${code}` : ""}`)}`);

  // No code, or one that cannot be a code: a form to type it.
  if (!code)
    return (
      <AuthCard
        eyebrow="Serve CLI"
        title="Sign in the CLI"
        description={raw ? "That code does not look right. Type the code your terminal shows." : "Type the code your terminal shows after serve login."}
      >
        <CodeForm />
      </AuthCard>
    );
  // Guessing codes is slowed down: the same limit as approving.
  if (!takeCodeLookup(session.user.id))
    return (
      <AuthCard eyebrow="Serve CLI" title="Too many codes tried" description="Wait a minute, then reload this page.">
        <CodeForm />
      </AuthCard>
    );
  const row = await pendingCliLogin(code);
  const done = (title: string, description: string) => (
    <AuthCard eyebrow="Serve CLI" title={title} description={description}>
      <Link href="/" className={buttonVariants({ variant: "secondary", size: "lg", className: "w-full" })}>
        Go to the dashboard
      </Link>
    </AuthCard>
  );
  // Unknown, used and expired codes read the same.
  if (!row || row.state === "expired" || row.state === "spent")
    return (
      <AuthCard
        eyebrow="Serve CLI"
        title="Code not valid"
        description="No sign-in waits for this code. Codes work once and for 10 minutes. Check the code, or run serve login again."
      >
        <CodeForm />
      </AuthCard>
    );
  if (row.state !== "pending") return done("Already answered", "This sign-in was already approved or denied. You can close this tab.");

  const orgs = await db
    .select({ id: schema.organization.id, name: schema.organization.name })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .where(eq(schema.member.userId, session.user.id))
    .orderBy(asc(schema.organization.name));
  const deploy = await Promise.all(orgs.map(async (o) => (await memberAccess(o.id, session.user.id))?.permissions.has("services.deploy") ?? false));
  const active = session.session.activeOrganizationId as string | null | undefined;
  const { apiEnabled } = await getSettings();

  return (
    <AuthCard
      eyebrow="Serve CLI"
      title="Sign in the CLI"
      description={
        <>
          The CLI on <span className="text-fg-2">{row.client}</span> (from <span className="text-fg-2">{row.ip ?? "an unknown address"}</span>, asked{" "}
          <TimeAgo date={row.createdAt} className="text-fg-2" />) asks to act as <span className="text-fg-2">{session.user.email}</span>. Only approve a code you see in your own
          terminal right now, after running <code className="font-mono text-[13px] text-fg-2">serve login</code> yourself.
        </>
      }
    >
      <CliApproval
        code={row.userCode}
        client={row.client}
        organizations={orgs.map((o, i) => ({ ...o, canDeploy: deploy[i] }))}
        defaultOrganization={orgs.find((o) => o.id === active)?.id ?? orgs[0]?.id ?? null}
        apiEnabled={apiEnabled}
      />
    </AuthCard>
  );
}
