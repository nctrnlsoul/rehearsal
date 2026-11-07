import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Both the db layer and the merchant logic take their dependencies by
    // injection, so no test here opens a socket.
    restoreMocks: true,
    // Several files start a real Postgres (PGlite) in process, and run in
    // parallel; the first test in each pays that start and can pass 5 s.
    testTimeout: 15_000,
  },
});
