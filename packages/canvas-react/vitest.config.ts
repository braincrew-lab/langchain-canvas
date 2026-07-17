import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // jsdom so the reconciler's DOMParser-based HTML patching runs under test.
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    globals: true,
  },
});
