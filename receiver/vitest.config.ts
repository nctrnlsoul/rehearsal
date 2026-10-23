import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The ledger takes fetch by injection, so no test here opens a socket.
    restoreMocks: true,
  },
});
