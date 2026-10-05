import { LockKeyhole } from "lucide-react";
import type { StatusDesign } from "@/lib/status-page";

/** A password page before the visitor gave the password: a plain form, no script needed. */
export function LockedPage({ name, action, wrong, design }: { name: string; action: string; wrong: boolean; design: StatusDesign }) {
  const dark = design.theme === "dark";
  return (
    <main
      className="flex min-h-dvh items-center justify-center px-4"
      style={{ background: dark ? "#0c0d10" : "#f6f7f9", color: dark ? "#f2f3f5" : "#14161a", colorScheme: dark ? "dark" : "light" }}
    >
      <form method="post" action={action} className="flex w-full max-w-[340px] flex-col items-center gap-4 text-center">
        <LockKeyhole className="size-7 opacity-60" aria-hidden />
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">{name}</h1>
          <p className="mt-1 text-[14px] opacity-70">Enter the password to see this status page.</p>
        </div>
        <input
          type="password"
          name="password"
          required
          autoComplete="current-password"
          aria-label="Password"
          aria-invalid={wrong || undefined}
          className="h-10 w-full rounded-lg border border-current/15 bg-transparent px-3 text-[15px] outline-none focus:border-current/40"
        />
        {wrong && <p className="text-[13px] text-[#d9342b]">That password is not right.</p>}
        <button
          type="submit"
          className="h-10 w-full rounded-lg text-[14px] font-medium"
          style={{ background: design.accent ?? (dark ? "#f2f3f5" : "#14161a"), color: dark && !design.accent ? "#0c0d10" : "#ffffff" }}
        >
          Open
        </button>
      </form>
    </main>
  );
}
