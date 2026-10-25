import { defineConfig } from "vitest/config";

/**
 * The browser suite: real Chromium against the real `next build` output, served
 * by `next start`. Kept apart from `npm test` because it needs the build first.
 */
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    environment: "node",
    // One server and one browser for the whole file, and the gate tests share
    // one attempt count on it, so they must run in order.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
