import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import { getBrand } from "@/server/branding";
import "./globals.css";

// SF Pro is used on Apple devices; Inter is the fallback elsewhere.
const body = Inter({ variable: "--font-body", subsets: ["latin"] });
const code = JetBrains_Mono({ variable: "--font-code", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrand();
  return {
    // "<page> · <name>", or the bare name when a page has no title.
    title: { default: brand.name, template: `%s · ${brand.name}` },
    description: "Deploy apps, databases and services on your own servers.",
    // The URL carries the image hash, so a new icon shows without a hard reload.
    icons: { icon: brand.faviconUrl ?? "/favicon.ico" },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0d" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const brand = await getBrand();
  // next-themes (in Providers) sets data-theme before paint.
  return (
    <html lang="en" suppressHydrationWarning className={`${body.variable} ${code.variable} h-full`}>
      <body className="min-h-full">
        {/* Accent override: built only from a validated hex colour. */}
        {brand.accentCss && <style>{brand.accentCss}</style>}
        <div className="root min-h-full">
          <Providers brand={brand}>{children}</Providers>
        </div>
      </body>
    </html>
  );
}
