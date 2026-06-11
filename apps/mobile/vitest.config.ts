import { defineConfig } from "vitest/config";

// Scoped to pure modules only (e.g. the Ledger). These have no React Native
// imports, so they run in a plain node environment with no Expo/RN transform.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
