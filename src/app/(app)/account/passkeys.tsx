"use client";

import * as React from "react";
import { Fingerprint, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardHeader, TimeAgo } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { showError } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import { authClient } from "@/lib/auth-client";

export type PasskeyRow = { id: string; name: string | null; createdAt: string | null; backedUp: boolean };

/** A name for a new passkey from the device it is made on, like "Chrome on macOS". */
function deviceName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return `${browser}${os ? ` on ${os}` : ""}`;
}

export function PasskeysCard({ passkeys, hostname, allowed }: { passkeys: PasskeyRow[]; hostname: string; allowed: boolean }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [adding, setAdding] = React.useState(false);
  const [rename, setRename] = React.useState<PasskeyRow | null>(null);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  // Passkeys need a secure page (https, or localhost) in a browser that has them.
  const [supported, setSupported] = React.useState(true);
  React.useEffect(() => setSupported(window.isSecureContext && typeof window.PublicKeyCredential !== "undefined"), []);

  async function add() {
    setAdding(true);
    const { error } = await authClient.passkey.addPasskey({ name: deviceName() });
    setAdding(false);
    // Closing the browser's prompt is not an error worth showing.
    if (error && !/cancel|abort|not allowed/i.test(error.message ?? "")) return showError(error.message ?? "Could not add the passkey.");
    if (!error) router.refresh();
  }

  return (
    <Card>
      <CardHeader
        title="Passkeys"
        description={`Sign in with your fingerprint, face or device PIN instead of a password. Passkeys made here work at ${hostname}.`}
        actions={
          allowed &&
          supported && (
            <Button size="sm" onClick={() => void add()} loading={adding}>
              <Plus /> Add passkey
            </Button>
          )
        }
      />
      {!allowed ? (
        <CardBody>
          <p className="text-[13px] leading-relaxed text-muted">Passkey sign-in is off while only single sign-on is allowed.</p>
        </CardBody>
      ) : !supported ? (
        <CardBody>
          <p className="text-[13px] leading-relaxed text-muted">Passkeys need the dashboard on https (or localhost). Open it at its domain to add one.</p>
        </CardBody>
      ) : passkeys.length === 0 ? (
        <CardBody>
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <Fingerprint className="size-4" /> No passkeys yet.
          </p>
        </CardBody>
      ) : null}
      {passkeys.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {passkeys.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-5 py-3">
              <KeyRound className="size-4 flex-none text-muted" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 truncate text-[13px] font-medium text-fg">
                  {p.name || "Passkey"} {p.backedUp && <Badge tone="info">Synced</Badge>}
                </span>
                {p.createdAt && (
                  <span className="text-xs text-muted">
                    Added <TimeAgo date={p.createdAt} />
                  </span>
                )}
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Rename"
                onClick={() => {
                  setName(p.name ?? "");
                  setRename(p);
                }}
              >
                <Pencil />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Remove"
                loading={busy === p.id}
                onClick={async () => {
                  if (!(await confirm({ title: "Remove this passkey?", description: "It can no longer sign in to your account.", confirmLabel: "Remove", danger: true }))) return;
                  setBusy(p.id);
                  const { error } = await authClient.passkey.deletePasskey({ id: p.id });
                  setBusy(null);
                  if (error) return showError(error.message ?? "Could not remove the passkey.");
                  router.refresh();
                }}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
      <Dialog open={!!rename} onOpenChange={(o) => !o && setRename(null)}>
        <DialogContent>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!rename) return;
              setBusy("rename");
              const { error } = await authClient.passkey.updatePasskey({ id: rename.id, name: name.trim() || "Passkey" });
              setBusy(null);
              if (error) return showError(error.message ?? "Could not rename the passkey.");
              setRename(null);
              router.refresh();
            }}
          >
            <DialogHeader title="Rename passkey" />
            <DialogBody>
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
              </Field>
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" size="sm" type="button" />}>Cancel</DialogClose>
              <Button type="submit" variant="primary" size="sm" loading={busy === "rename"}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
