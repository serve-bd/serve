import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { isEmailConfigured } from "@/server/email/send";
import { providerInfo } from "@/lib/notifications";
import { ChannelEditor } from "../editor";
import { scopeTree } from "../editor-data";
import { orgHasServers } from "@/server/servers/access";

export const metadata = { title: "Notification channel" };

export default async function ChannelPage(props: PageProps<"/integrations/notifications/[channelId]">) {
  const { channelId } = await props.params;
  const ctx = await requireOrg();
  const [channel] = await db
    .select()
    .from(schema.notificationChannel)
    .where(and(eq(schema.notificationChannel.id, channelId), eq(schema.notificationChannel.organizationId, ctx.org.id)));
  if (!channel) notFound();
  const info = providerInfo(channel.kind);
  const stored = JSON.parse(decryptOrNull(channel.config) ?? "{}") as Record<string, string>;
  // Secrets never go back to the browser; the form shows that one is saved.
  const secretKeys = new Set((info?.fields ?? []).filter((f) => f.secret).map((f) => f.key));
  const config = ctx.can("integrations.manage") ? Object.fromEntries(Object.entries(stored).filter(([k]) => !secretKeys.has(k))) : {};
  const [tree, emailReady] = await Promise.all([scopeTree(ctx.org.id), channel.kind === "email" ? isEmailConfigured() : true]);
  return (
    <ChannelEditor
      channelId={channel.id}
      kind={channel.kind}
      isAdmin={ctx.can("integrations.manage")}
      isRoot={ctx.isRoot}
      hasServers={await orgHasServers(ctx.org.id)}
      emailReady={emailReady}
      tree={tree}
      savedSecrets={Object.keys(stored).filter((k) => secretKeys.has(k) && !!stored[k])}
      initial={{
        name: channel.name,
        config,
        events: channel.events,
        scope: channel.scope,
        minSeverity: channel.minSeverity,
        quietHours: channel.quietHours,
        throttleMinutes: channel.throttleMinutes,
        template: channel.template,
      }}
    />
  );
}
