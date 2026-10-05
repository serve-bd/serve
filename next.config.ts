import type { NextConfig } from "next";
import pkg from "./package.json" with { type: "json" };

const nextConfig: NextConfig = {
  // Each release is its own deployment: a tab opened before an update reloads instead of calling
  // actions the new version no longer has ("Failed to find Server Action").
  deploymentId: `serve-${pkg.version.replace(/[^A-Za-z0-9_-]/g, "_")}`,
  // Lets a second dev instance (e2e tests) run next to the main one.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  serverExternalPackages: ["dockerode", "ssh2", "cpu-features", "postgres"],
  poweredByHeader: false,
  // No other site may frame the dashboard (clickjacking).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // Template logos come from the catalog on GitHub: opened on their own they may not run anything.
        source: "/api/templates/:id/logo",
        headers: [{ key: "Content-Security-Policy", value: "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox" }],
      },
    ];
  },
  // Keep the dev tools badge away from the account menu in the sidebar.
  // Bottom right holds the deployments pill and toasts.
  devIndicators: { position: "bottom-left" },
  // Development only: domains that may load dev assets (e.g. the dashboard domain through a tunnel).
  allowedDevOrigins: (process.env.SERVE_DEV_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

export default nextConfig;
