"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Laptop, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader, TimeAgo, Badge } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import useSWR from "swr";
import { authClient } from "@/lib/auth-client";

type SessionRow = { id: string; token: string; userAgent?: string | null; ipAddress?: string | null; createdAt: Date; updatedAt: Date };

function device(ua?: string | null) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return `${browser}${os ? ` on ${os}` : ""}`;
}

export function AccountView({ user }: { user: { name: string; email: string } }) {
  const router = useRouter();
  const [name, setName] = React.useState(user.name);
  const [saving, setSaving] = React.useState(false);
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [changing, setChanging] = React.useState(false);
  const { data, mutate } = useSWR("account-sessions", async () => {
    const [list, me] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
    return { sessions: (list.data ?? []) as SessionRow[], currentToken: me.data?.session.token ?? null };
  });
  const sessions = data?.sessions ?? [];
  const currentToken = data?.currentToken ?? null;
  const load = () => void mutate();

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            const { error } = await authClient.updateUser({ name });
            setSaving(false);
            if (error) return toast.error(error.message ?? "Could not save");
            toast.success("Profile updated");
            router.refresh();
          }}
        >
          <CardHeader title="Profile" />
          <CardBody className="flex flex-col gap-4 py-5">
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
            <Field label="Email"><Input value={user.email} disabled /></Field>
          </CardBody>
          <CardFooter className="justify-end"><Button type="submit" size="sm" variant="primary" disabled={name === user.name} loading={saving}>Save</Button></CardFooter>
        </form>
      </Card>

      <Card>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setChanging(true);
            const { error } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
            setChanging(false);
            if (error) return toast.error(error.message ?? "Could not change password");
            toast.success("Password changed. Other devices were signed out.");
            setCurrent("");
            setNext("");
            void load();
          }}
        >
          <CardHeader title="Password" />
          <CardBody className="grid gap-4 py-5 sm:grid-cols-2">
            <Field label="Current password"><Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" /></Field>
            <Field label="New password" description="At least 8 characters."><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} autoComplete="new-password" /></Field>
          </CardBody>
          <CardFooter className="justify-end"><Button type="submit" size="sm" variant="primary" loading={changing} disabled={!current || next.length < 8}>Change password</Button></CardFooter>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Sessions" description="Devices signed in to your account." actions={sessions.length > 1 && <Button size="sm" onClick={async () => { await authClient.revokeOtherSessions(); toast.success("Signed out other devices"); void load(); }}>Sign out others</Button>} />
        <div className="divide-y divide-line">
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-5 py-3">
              <Laptop className="size-4 text-muted" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 text-[13px] font-medium text-fg">{device(s.userAgent)} {s.token === currentToken && <Badge tone="ok">This device</Badge>}</span>
                <span className="text-xs text-muted">{s.ipAddress ?? "Unknown IP"} · active <TimeAgo date={s.updatedAt} /></span>
              </div>
              {s.token !== currentToken && (
                <Button size="icon-sm" variant="ghost" aria-label="Sign out" onClick={async () => { await authClient.revokeSession({ token: s.token }); void load(); }}>
                  <LogOut />
                </Button>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
