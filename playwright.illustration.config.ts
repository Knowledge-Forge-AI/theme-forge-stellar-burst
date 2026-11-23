import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

export default defineConfig({
  ...base,
  webServer: undefined,
  outputDir: ".test-reports/playwright/illustration",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  testMatch: "cloe-webp.spec.ts",
});
