import { connection } from "next/server";
import { DatabaseBackup, GitBranch, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/brand";
import { getSettings } from "@/server/settings";
import pkg from "../../../package.json";

const points = [
  { icon: GitBranch, title: "Push to deploy", body: "Build from Git, Docker images or Compose, with zero-downtime rollouts." },
  { icon: ShieldCheck, title: "HTTPS by default", body: "Certificates, domains and tunnels handled for every service." },
  { icon: DatabaseBackup, title: "Databases with backups", body: "Scheduled backups to S3, one-click restore and import." },
];

export default async function AuthLayout({ children }: LayoutProps<"/">) {
  await connection();
  const { instanceName } = await getSettings().catch(() => ({ instanceName: "Serve" }));
  const name = instanceName || "Serve";
  return (
    <div className="grid min-h-dvh grid-cols-1 bg-bg lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* Brand panel: always dark, only on wide screens. */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-[#0b0b0d] p-10 text-white lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(#fff_1px,transparent_1px),linear-gradient(90deg,#fff_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_at_30%_40%,#000,transparent_70%)]"
        />
        <div className="relative flex items-center gap-2.5">
          <Logo withText={false} className="[&_svg]:size-8" />
          <span className="text-[15px] font-semibold tracking-tight">{name}</span>
        </div>
        <div className="relative flex max-w-md flex-col gap-8">
          <h2 className="text-[28px] leading-tight font-semibold tracking-tight">Deploy apps, databases and services on your own servers.</h2>
          <ul className="flex flex-col gap-5">
            {points.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3.5">
                <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/10">
                  <Icon className="size-4 text-white/90" />
                </span>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[14px] font-medium">{title}</span>
                  <span className="text-[13px] leading-relaxed text-white/60">{body}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/40">Self-hosted with Serve · v{pkg.version}</p>
      </aside>

      <main className="flex flex-col px-4 py-10 sm:px-8">
        <div className="flex items-center gap-2.5 lg:hidden">
          <Logo withText={false} className="[&_svg]:size-7" />
          <span className="text-[15px] font-semibold tracking-tight text-fg">{name}</span>
        </div>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[360px] animate-rise">{children}</div>
        </div>
        <p className="text-center text-xs text-faint lg:hidden">Self-hosted with Serve · v{pkg.version}</p>
      </main>
    </div>
  );
}
