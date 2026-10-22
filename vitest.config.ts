import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The core is pure. Any test that opens a socket is a bug in the test,
    // so there is deliberately no network mocking layer to lean on.
    restoreMocks: true,
  },
});
