import { headers } from "next/headers";
import { getBrand } from "@/server/branding";
import { DEFAULT_PRODUCT_NAME } from "@/lib/branding";
import { pageBySlug } from "./data";
import { pageAccess } from "./access";
import { requestHost } from "./hosts";

/** "" when the visitor came on the page's own domain, else /status/<slug> on the dashboard's. */
export async function basePathFor(page: { slug: string; domain: string | null }) {
  const host = requestHost(await headers());
  return page.domain && host === page.domain.toLowerCase() ? "" : `/status/${page.slug}`;
}

/** The page for a public request, with what this visitor may see. */
export async function publicPage(slug: string) {
  const page = await pageBySlug(slug);
  if (!page) return null;
  const { access, member } = await pageAccess(page);
  if (access === "hidden") return null;
  return { page, access, member, base: await basePathFor(page) };
}

export async function poweredBy() {
  const brand = await getBrand();
  return brand.name === DEFAULT_PRODUCT_NAME ? { name: DEFAULT_PRODUCT_NAME, url: "https://serve.bd" } : { name: brand.name, url: null };
}
