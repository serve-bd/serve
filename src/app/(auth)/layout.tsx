import { connection } from "next/server";
import { Logo } from "@/components/brand";
import { getSettings } from "@/server/settings";
import pkg from "../../../package.json";

export default async function AuthLayout({ children }: LayoutProps<"/">) {
  await connection();
  const { instanceName } = await getSettings().catch(() => ({ instanceName: "Serve" }));
  return (
    <div className="relative flex min-h-dvh flex-col overflow-x-hidden bg-bg">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(40rem_28rem_at_50%_42%,var(--accent-soft),transparent_70%)] opacity-40"
      />
      <main className="relative flex flex-1 flex-col items-center justify-center px-4 py-12">
        <div className="flex w-full max-w-[380px] animate-rise flex-col items-center gap-7">
          <div className="flex flex-col items-center gap-2.5">
            <Logo withText={false} className="[&_svg]:size-11" />
            <span className="text-[13px] font-medium tracking-tight text-muted">{instanceName || "Serve"}</span>
          </div>
          {children}
        </div>
      </main>
      <footer className="relative pb-6 text-center text-xs text-faint">
        Self-hosted with Serve · v{pkg.version}
      </footer>
    </div>
  );
}
