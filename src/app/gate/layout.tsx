import { connection } from "next/server";
import { Logo } from "@/components/brand";

/** The login wall's page: the brand over the form, nothing else (visitors here came for an app, not for Serve). */
export default async function GateLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-4 py-10 sm:px-8">
      <div className="flex w-full max-w-[360px] animate-rise flex-col gap-8 [&_header]:items-center [&_header]:text-center">
        <Logo className="gap-2.5 self-center" logoClassName="h-10" textClassName="text-[18px]" />
        {children}
      </div>
    </main>
  );
}
