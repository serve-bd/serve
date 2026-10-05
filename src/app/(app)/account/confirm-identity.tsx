"use client";

import * as React from "react";
import useSWR from "swr";
import { SsoMark } from "@/components/sso-mark";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { clearError, showError } from "@/hooks/use-action";
import { useLatest } from "@/hooks/use-client";
import { authClient } from "@/lib/auth-client";
import { DELETE_REAUTH, needsFreshSession, REAUTH_ERROR_RETURN, REAUTH_RETURN } from "@/lib/reauth";
import type { ActionResult } from "@/server/action";
import { ssoErrorMessage } from "@/lib/sso-errors";
import { confirmPassword, identityMethods } from "@/server/actions/reauth";

/*
 * A provider confirmation leaves the page. What was being done is kept here for the way back,
 * with the user it was for: a different account signing in does not pick it up.
 */
const RESUME_KEY = "serve:confirm-identity";
const RESUME_MAX_AGE = 10 * 60_000;
type Resume = { key: string; userId: string; data?: string; at: number };

function saveResume(entry: Resume) {
  try {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify(entry));
  } catch {}
}

/** The saved entry, removed, when it is for `prefix` (all entries with none) and recent enough. */
function takeResume(prefix?: string): Resume | null {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    const entry = raw ? (JSON.parse(raw) as Resume) : null;
    if (!entry) return null;
    if (prefix && entry.key !== prefix && !entry.key.startsWith(`${prefix}:`)) return null;
    sessionStorage.removeItem(RESUME_KEY);
    return Date.now() - entry.at < RESUME_MAX_AGE ? entry : null;
  } catch {
    return null;
  }
}

function useIdentityMethods() {
  return useSWR("identity-methods", async () => {
    const res = await identityMethods();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  });
}

/** Picks up what a provider confirmation for `prefix` left unfinished, once the Account page is back. */
export function useResumeAfterConfirm(prefix: string, handler: (data: string | undefined) => void) {
  const handlerRef = useLatest(handler);
  React.useEffect(() => {
    if (new URLSearchParams(window.location.search).get("reauth") === "failed") return;
    const entry = takeResume(prefix);
    if (!entry) return;
    void identityMethods().then((res) => {
      if (res.ok && res.data.userId === entry.userId) handlerRef.current(entry.data);
    });
  }, [prefix, handlerRef]);
}

/** A failed provider confirmation (`?reauth=failed&error=…`): says why, and drops what was waiting. */
export function useConfirmFailure(code: string | null) {
  React.useEffect(() => {
    if (code === null) return;
    takeResume();
    showError("Could not confirm it's you.", ssoErrorMessage(code));
    // Out of the address, so a reload does not show it again.
    window.history.replaceState(null, "", window.location.pathname);
  }, [code]);
}

/**
 * The "Confirm it's you" step, as the contents of a dialog: the password, or a sign-in with a
 * linked provider for accounts without one. `resume` is what to pick up after a provider sign-in,
 * which leaves the page.
 */
export function ConfirmIdentity({
  description = "This change needs a recent sign-in.",
  resume,
  onConfirmed,
  cancel,
  returnTo = REAUTH_RETURN,
}: {
  description?: string;
  resume: { key: string; data?: string };
  /** Where a provider sign-in comes back to (the Account page, else the page that asked). */
  returnTo?: string;
  onConfirmed: () => void | Promise<void>;
  /** The way back: a Cancel button that closes the dialog, or another one. */
  cancel?: React.ReactNode;
}) {
  const { data: methods, error: loadError } = useIdentityMethods();
  const [password, setPassword] = React.useState("");
  const [pending, setPending] = React.useState<string | null>(null);

  React.useEffect(() => clearError(), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    setPending("password");
    clearError();
    try {
      const res = await confirmPassword(password);
      if (!res.ok) {
        setPassword("");
        return showError(res.error);
      }
      await onConfirmed();
    } catch {
      showError("Could not reach the server. Check your connection and try again.");
    } finally {
      setPending(null);
    }
  }

  async function withProvider(id: string) {
    if (!methods) return;
    setPending(id);
    clearError();
    saveResume({ key: resume.key, data: resume.data, userId: methods.userId, at: Date.now() });
    const { error } = await authClient.signIn.social({
      provider: id as "github",
      callbackURL: returnTo,
      errorCallbackURL: returnTo === REAUTH_RETURN ? REAUTH_ERROR_RETURN : returnTo,
    });
    // Success leaves the page; only a failure to start comes back here.
    if (error) {
      takeResume();
      setPending(null);
      showError("Could not start the sign-in.", error.message ?? undefined);
    }
  }

  const signedOut = !!loadError;
  const footerCancel = cancel ?? <DialogClose render={<Button variant="ghost" size="sm" type="button" />}>Cancel</DialogClose>;

  return (
    <form method="post" onSubmit={submit}>
      <DialogHeader
        title="Confirm it's you"
        description={
          signedOut
            ? undefined
            : methods?.password
              ? `${description} Enter your password to continue.`
              : methods?.providers.length
                ? `${description} Sign in again with ${methods.providers.length === 1 ? methods.providers[0].label : "one of your linked accounts"} to continue. You come back here after.`
                : description
        }
      />
      <DialogBody>
        {signedOut ? (
          <p className="text-[13px] leading-relaxed text-fg-2">{loadError instanceof Error ? loadError.message : "You were signed out. Sign in again to continue."}</p>
        ) : !methods ? (
          <p className="text-[13px] text-muted">Checking how you sign in…</p>
        ) : methods.password ? (
          <Field label="Password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus autoComplete="current-password" />
          </Field>
        ) : methods.providers.length ? (
          <div className="flex flex-col gap-2">
            {methods.providers.map((p) => (
              <Button
                key={p.id}
                type="button"
                className="w-full justify-center"
                loading={pending === p.id}
                disabled={!!pending && pending !== p.id}
                onClick={() => void withProvider(p.id)}
              >
                <SsoMark provider={p.id} /> Continue with {p.label}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-[13px] leading-relaxed text-fg-2">
            None of the sign-in methods linked to your account is turned on right now. Sign out and sign in again, then try once more.
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        {footerCancel}
        {signedOut || (methods && !methods.password && !methods.providers.length) ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            loading={pending === "signout"}
            onClick={async () => {
              setPending("signout");
              await authClient.signOut().catch(() => {});
              window.location.href = `/login?next=${encodeURIComponent(returnTo)}`;
            }}
          >
            Sign in again
          </Button>
        ) : methods?.password ? (
          <Button type="submit" variant="primary" size="sm" loading={pending === "password"} disabled={!password}>
            Continue
          </Button>
        ) : null}
      </DialogFooter>
    </form>
  );
}

/**
 * For changes started outside a dialog: `fresh(call, resume)` runs the call, and when better-auth
 * wants a recent sign-in, asks the user to confirm it is them and runs it once more. Returns null
 * when they cancel. Render `dialog` once.
 */
export function useFreshSession() {
  const [asking, setAsking] = React.useState<{ resume: { key: string; data?: string }; description?: string; returnTo?: string; done: (ok: boolean) => void } | null>(null);

  const ask = React.useCallback(
    (resume: { key: string; data?: string }, description?: string, returnTo?: string) => new Promise<boolean>((done) => setAsking({ resume, description, returnTo, done })),
    [],
  );

  const fresh = React.useCallback(
    async <T extends { error: { code?: string | null } | null }>(call: () => Promise<T>, resume: { key: string; data?: string }, description?: string) => {
      const first = await call();
      if (!needsFreshSession(first.error)) return first;
      if (!(await ask(resume, description))) return null;
      return call();
    },
    [ask],
  );

  const dialog = (
    <Dialog
      open={!!asking}
      onOpenChange={(open) => {
        if (open || !asking) return;
        asking.done(false);
        setAsking(null);
      }}
    >
      <DialogContent size="sm">
        {asking && (
          <ConfirmIdentity
            resume={asking.resume}
            description={asking.description}
            returnTo={asking.returnTo}
            onConfirmed={() => {
              asking.done(true);
              setAsking(null);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );

  return { fresh, ask, dialog };
}

/**
 * Deleting servers, services and projects: an account without a password needs a recent sign-in.
 * `guard(call)` runs the delete, and when the server asks for that, has the user sign in again
 * with their provider (they come back to this page and delete again), then tries once more.
 */
export function useDeleteGuard() {
  const { ask, dialog } = useFreshSession();
  const guard = React.useCallback(
    async <T,>(call: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> => {
      const first = await call();
      if (first.ok || first.error !== DELETE_REAUTH) return first;
      if (!(await ask({ key: "delete" }, "Deleting needs a sign-in from the last few minutes.", window.location.pathname))) {
        return { ok: false, error: "Nothing was deleted. Confirm it's you to delete." };
      }
      return call();
    },
    [ask],
  );
  return { guard, dialog };
}
