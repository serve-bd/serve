import { notFound } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { isEmailConfigured } from "@/server/email/send";
import { defaultChannelEvents, providerDefaults, providerInfo } from "@/lib/notifications";
import { ChannelEditor } from "../../editor";
import { scopeTree } from "../../editor-data";

export const metadata = { title: "Add notification channel" };

export default async function NewChannelPage(props: PageProps<"/integrations/notifications/new/[provider]">) {
  const { provider } = await props.params;
  const info = providerInfo(provider);
  if (!info) notFound();
  const ctx = await requireOrg();
  const [tree, emailReady] = await Promise.all([scopeTree(ctx.org.id), provider === "email" ? isEmailConfigured() : true]);
  return (
    <ChannelEditor
      channelId={null}
      kind={info.id}
      isAdmin={ctx.isAdmin}
      isRoot={ctx.isRoot}
      emailReady={emailReady}
      tree={tree}
      savedSecrets={[]}
      initial={{
        name: info.label,
        config: providerDefaults(info.id),
        events: ctx.isRoot ? defaultChannelEvents : defaultChannelEvents.filter((e) => !e.startsWith("instance.") && !e.startsWith("server.")),
        scope: null,
        minSeverity: "info",
        quietHours: null,
        throttleMinutes: 0,
        template: null,
      }}
    />
  );
}
