import { connection } from "next/server";
import { Logo } from "@/components/brand";
import { getBrand } from "@/server/branding";

/** The login wall's page: the brand over a card with the form (visitors here came for an app, not for Serve). */
export default async function GateLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const { name } = await getBrand();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-10">
      <div className="flex w-full max-w-[400px] animate-rise flex-col gap-6">
        <Logo className="gap-2.5 self-center" logoClassName="h-9" textClassName="text-[17px]" />
        <div className="rounded-2xl border border-line bg-surface p-7 [&_h1]:text-[21px] [&_header]:mb-6 shadow-[0_1px_0_rgb(255_255_255/0.03)_inset,0_24px_48px_-24px_rgb(0_0_0/0.5)] sm:p-8">
          {children}
        </div>
        <p className="text-center text-xs text-faint">Protected by {name}</p>
      </div>
    </main>
  );
}
