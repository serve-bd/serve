import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets a second dev instance (e2e tests) run next to the main one.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  serverExternalPackages: ["dockerode", "ssh2", "cpu-features", "postgres"],
  poweredByHeader: false,
  // Keep the dev tools badge away from the account menu in the sidebar.
  devIndicators: { position: "bottom-right" },
  // Development only: domains that may load dev assets (e.g. the dashboard domain through a tunnel).
  allowedDevOrigins: (process.env.SERVE_DEV_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

export default nextConfig;
