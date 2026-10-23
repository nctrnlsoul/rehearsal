import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Both the db layer and the merchant logic take their dependencies by
    // injection, so no test here opens a socket.
    restoreMocks: true,
  },
});
