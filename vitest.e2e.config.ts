import path from "node:path";
import { defineConfig } from "vitest/config";

// Live end-to-end tests against a running Serve (see tests/e2e/flows.e2e.ts).
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { include: ["tests/e2e/**/*.e2e.ts"], environment: "node", testTimeout: 600_000, hookTimeout: 120_000, fileParallelism: false },
});
