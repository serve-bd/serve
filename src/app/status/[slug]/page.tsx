import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { designOf } from "@/lib/status-page";
import { pageIconUrl, statusView } from "@/server/status-pages/data";
import { subscribeOptions } from "@/server/status-pages/subscribers";
import { poweredBy, publicPage } from "@/server/status-pages/public";
import { StatusView } from "@/components/status-page/status-view";
import { LockedPage } from "./locked-page";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/status/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const found = await publicPage(slug);
  if (!found) return { title: { absolute: "Not found" }, robots: { index: false } };
  const { page, base } = found;
  const design = designOf(page.design);
  // Always the page's own icon route: on its own domain the dashboard's icon paths do not answer.
  const icon = await pageIconUrl(page.id, base);
  return {
    title: { absolute: `${page.name} status` },
    description: design.description ?? `Current status of ${page.name}.`,
    robots: design.noindex || page.visibility !== "public" ? { index: false, follow: false } : undefined,
    icons: { icon, apple: icon },
    alternates: { types: { "application/rss+xml": `${base}/feed.xml` } },
  };
}

export default async function StatusPage(props: PageProps<"/status/[slug]">) {
  const { slug } = await props.params;
  const { wrong } = await props.searchParams;
  const found = await publicPage(slug);
  if (!found) notFound();
  const { page, access, member, base } = found;
  const design = designOf(page.design);
  if (access === "locked") return <LockedPage name={page.name} action={`${base}/unlock`} wrong={wrong === "1"} design={design} />;
  const view = await statusView(page, base, design);
  const note =
    member && page.visibility === "draft"
      ? "Draft: only members of your organization can see this page."
      : member && page.visibility === "password"
        ? "Visitors need the password. You see the page because you are signed in."
        : null;
  return <StatusView view={view} design={design} base={base} live note={note} poweredBy={await poweredBy()} subscribe={await subscribeOptions(page)} />;
}
