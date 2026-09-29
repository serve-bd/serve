import { connection } from "next/server";
import { DatabaseBackup, GitBranch, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/brand";
import { getBrand } from "@/server/branding";
import pkg from "../../../package.json";

const points = [
  { icon: GitBranch, title: "Push to deploy", body: "Build from Git, Docker images or Compose, with zero-downtime rollouts." },
  { icon: ShieldCheck, title: "HTTPS by default", body: "Certificates, domains and tunnels handled for every service." },
  { icon: DatabaseBackup, title: "Databases with backups", body: "Scheduled backups to S3, one-click restore and import." },
];

export default async function AuthLayout({ children }: LayoutProps<"/">) {
  await connection();
  const { name } = await getBrand();
  return (
    <div className="grid min-h-dvh grid-cols-1 bg-bg lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* Brand panel: always dark, only on wide screens. */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-white/10 bg-[#07070a] p-10 text-white lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(#fff_1px,transparent_1px),linear-gradient(90deg,#fff_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_at_30%_40%,#000,transparent_70%)]"
        />
        <div className="relative flex items-center">
          <Logo onDark className="gap-2.5" markClassName="size-8" logoClassName="h-8" textClassName="text-[15px] text-white" />
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
        <p className="relative text-xs text-white/40">
          {name} · v{pkg.version}
        </p>
      </aside>

      <main className="flex flex-col bg-surface px-4 py-10 sm:px-8">
        <div className="flex items-center lg:hidden">
          <Logo className="gap-2.5" textClassName="text-[15px]" />
        </div>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[360px] animate-rise">{children}</div>
        </div>
        <p className="text-center text-xs text-faint lg:hidden">
          {name} · v{pkg.version}
        </p>
      </main>
    </div>
  );
}
