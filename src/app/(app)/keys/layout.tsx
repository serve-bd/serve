import { requireOrg } from "@/server/auth";
import { PageHeader } from "@/components/shell/page-header";
import { SectionNav } from "@/components/shell/section-nav";

export default async function KeysLayout({ children }: LayoutProps<"/keys">) {
  const ctx = await requireOrg();
  return (
    <>
      <PageHeader title="Keys & tokens" description="Credentials Serve uses and hands out: API tokens for automation and SSH keys for servers." />
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 pt-4 pb-16 sm:px-8 lg:flex-row lg:gap-10 lg:pt-6">
        <SectionNav
          groups={[
            {
              title: ctx.org.name,
              items: [{ href: "/keys/api-tokens", label: "API tokens", icon: "KeyRound" }],
            },
            ...(ctx.isInstanceAdmin ? [{ title: "Instance", items: [{ href: "/keys/ssh", label: "SSH keys", icon: "LockKeyhole" as const }] }] : []),
          ]}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
      </div>
    </>
  );
}
