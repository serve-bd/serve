import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

// SF Pro is used on Apple devices; Inter is the fallback elsewhere.
const body = Inter({ variable: "--font-body", subsets: ["latin"] });
const code = JetBrains_Mono({ variable: "--font-code", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Serve", template: "%s · Serve" },
  description: "Deploy apps, databases and services on your own servers.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0d" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // next-themes (in Providers) sets data-theme before paint.
  return (
    <html lang="en" suppressHydrationWarning className={`${body.variable} ${code.variable} h-full`}>
      <body className="min-h-full">
        <div className="root min-h-full">
          <Providers>{children}</Providers>
        </div>
      </body>
    </html>
  );
}
