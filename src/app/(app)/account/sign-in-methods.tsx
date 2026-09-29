"use client";

import * as React from "react";
import { KeyRound, Link2, Unlink } from "lucide-react";
import useSWR from "swr";
import { SsoMark } from "@/components/sso-mark";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Badge, Card, CardHeader, TimeAgo } from "@/components/ui/misc";
import { toast } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";
import { ssoErrorMessage } from "@/lib/sso-errors";

type Linked = { id: string; providerId: string; accountId: string; createdAt: string | Date };

const names: Record<string, string> = { credential: "Email and password", github: "GitHub", google: "Google", oidc: "Company login" };

/** Ways the user can sign in: password and linked providers, with link and unlink. */
export function SignInMethods({ providers, error }: { providers: { id: string; label: string }[]; error: string | null }) {
  const confirm = useConfirm();
  const [busy, setBusy] = React.useState<string | null>(null);
  const { data, mutate } = useSWR("account-links", async () => ((await authClient.listAccounts()).data ?? []) as Linked[]);
  const linked = data ?? [];

  React.useEffect(() => {
    if (error) toast.error("Could not link the account", ssoErrorMessage(error));
  }, [error]);

  const rows = [
    ...linked.map((a) => ({ id: a.providerId, linked: a })),
    ...providers.filter((p) => !linked.some((a) => a.providerId === p.id)).map((p) => ({ id: p.id, linked: null as Linked | null })),
  ];

  const link = async (id: string) => {
    setBusy(id);
    const { error } = await authClient.linkSocial({ provider: id as "github", callbackURL: "/account", errorCallbackURL: "/account" });
    if (error) {
      setBusy(null);
      toast.error("Could not link the account", error.message);
    }
  };

  const unlink = async (id: string, accountId: string) => {
    if (
      !(await confirm({
        title: `Unlink ${names[id] ?? id}?`,
        description: "You can no longer sign in with it until you link it again.",
        confirmLabel: "Unlink",
        danger: true,
      }))
    )
      return;
    setBusy(id);
    const { error } = await authClient.unlinkAccount({ accountId });
    setBusy(null);
    if (error) return toast.error("Could not unlink", error.message);
    toast.success(`${names[id] ?? id} unlinked`);
    void mutate();
  };

  if (rows.length <= 1 && !providers.length) return null;

  return (
    <Card className="overflow-hidden">
      <CardHeader title="Sign-in methods" description="Ways you can sign in to your account. Keep at least one." />
      <div className="divide-y divide-line">
        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-3 px-5 py-3.5">
            <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-fg/[0.05] text-fg-2">
              {r.id === "credential" ? <KeyRound className="size-4" /> : <SsoMark provider={r.id} />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[13px] font-medium text-fg">{names[r.id] ?? providers.find((p) => p.id === r.id)?.label ?? r.id}</span>
              <span className="text-xs text-muted">
                {r.linked ? (
                  <>
                    Linked <TimeAgo date={r.linked.createdAt} />
                  </>
                ) : (
                  "Not linked"
                )}
              </span>
            </div>
            {r.linked ? (
              r.id === "credential" ? (
                <Badge>Password</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void unlink(r.id, r.linked!.id)}
                  loading={busy === r.id}
                  disabled={linked.length <= 1}
                  title={linked.length <= 1 ? "Your only sign-in method" : undefined}
                >
                  <Unlink /> Unlink
                </Button>
              )
            ) : (
              <Button size="sm" onClick={() => void link(r.id)} loading={busy === r.id}>
                <Link2 /> Link
              </Button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
