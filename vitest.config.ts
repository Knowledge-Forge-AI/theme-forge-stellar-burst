import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/**/*.test.ts",
      "tools/public-composition/**/*.test.mjs",
    ],
    exclude: [
      ...configDefaults.exclude,
      "test/visual/**",
      ".outbox/**",
      "packages/**",
      "apps/**",
      "themes/**",
    ],
    testTimeout: 60000,
  },
});
