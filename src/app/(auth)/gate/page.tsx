import { connection } from "next/server";
import { redirect } from "next/navigation";
import { getSession } from "@/server/auth";
import { GATE_PATH, gateAllows, gateTarget, signGate } from "@/server/gate";
import { safeNextPath } from "@/lib/safe-next";
import { AuthCard } from "../_components/auth-card";
import { SwitchAccount } from "./switch-account";

export const metadata = { title: "Sign in to continue" };

/** The login wall's sign-in step: a member who may reach the app goes back to it with a ticket. */
export default async function GatePage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const q = await props.searchParams;
  const [s, h, p] = [q.s, q.h, q.p].map((v) => (typeof v === "string" ? v : ""));
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/gate?${new URLSearchParams({ s, h, p })}`)}`);
  const target = s && h ? await gateTarget(s, h) : null;
  if (!target) return <AuthCard title="Link not valid" description="This app does not ask for a sign-in here. Open the app again." />;
  if (!(await gateAllows(session.user.id, s)))
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
  const ticket = signGate({ k: "t", u: session.user.id, s, h, p: safeNextPath(p), x: target.https });
  redirect(`${target.https ? "https" : "http"}://${h}${GATE_PATH}?t=${ticket}`);
}
