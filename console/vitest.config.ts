import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    environment: "node",
    // The gate takes its clock, environment and attempt store by injection, so
    // no test here opens a socket or reads the real environment.
    restoreMocks: true,
    // The gate tests hash real passcodes with scrypt. Under a loaded machine a
    // few of those can approach the 5 s default, which once read as a failure.
    testTimeout: 15_000,
  },
});
