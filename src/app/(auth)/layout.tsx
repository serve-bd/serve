import { Logo } from "@/components/brand";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="relative flex min-h-screen flex-col">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(60%_60%_at_50%_0%,var(--accent-soft),transparent)]" />
      <header className="relative flex h-16 items-center px-6">
        <Logo />
      </header>
      <main className="relative flex flex-1 items-start justify-center px-4 pt-[6vh] pb-16">
        <div className="w-full max-w-[400px] animate-rise">{children}</div>
      </main>
    </div>
  );
}
