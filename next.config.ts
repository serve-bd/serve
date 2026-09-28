import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets a second dev instance (e2e tests) run next to the main one.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  serverExternalPackages: ["dockerode", "ssh2", "cpu-features", "postgres"],
  poweredByHeader: false,
};

export default nextConfig;
