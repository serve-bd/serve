import { connection } from "next/server";
import { redirect } from "next/navigation";
import { getSession } from "@/server/auth";
import { GATE_PATH, gateAllows, gateTarget, signGate } from "@/server/gate";
import { safeNextPath } from "@/lib/safe-next";
import { AuthCard } from "../(auth)/_components/auth-card";
import { GuestForm } from "./guest-form";
import { SwitchAccount } from "./switch-account";

export const metadata = { title: "Sign in to continue" };

/**
 * The login wall's sign-in step. A member who may reach the app goes straight back to it with a
 * ticket; guests sign in with the email and password the app lists. Public: guests have no
 * Serve account, so the team's sign-in is a link from here.
 */
export default async function GatePage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const q = await props.searchParams;
  const [s, h, p] = [q.s, q.h, q.p].map((v) => (typeof v === "string" ? v : ""));
  const target = s && h ? await gateTarget(s, h) : null;
  if (!target) return <AuthCard title="Link not valid" description="This app does not ask for a sign-in here. Open the app again." />;
  const session = await getSession();
  if (session && target.team && (await gateAllows(session.user.id, session.session.id, s))) {
    const ticket = signGate({ k: "t", u: session.user.id, i: session.session.id, s, h, p: safeNextPath(p), x: target.https });
    redirect(`${target.https ? "https" : "http"}://${h}${GATE_PATH}?t=${ticket}`);
  }
  const login = `/login?next=${encodeURIComponent(`/gate?${new URLSearchParams({ s, h, p })}`)}`;
  if (target.guests.length)
    return (
      <AuthCard title={`Sign in to ${target.name}`} description="This app is private. Sign in with the email and password you were given.">
        <GuestForm s={s} h={h} p={p} teamHref={target.team && !session ? login : null} />
      </AuthCard>
    );
  if (!session) redirect(login);
  return (
    <AuthCard
      title="No access"
      description={
        <>
          You are signed in as <span className="text-fg-2">{session.user.email}</span>, who cannot open {target.name}. Ask an admin to add you to its project.
        </>
      }
    >
      <SwitchAccount />
    </AuthCard>
  );
}
