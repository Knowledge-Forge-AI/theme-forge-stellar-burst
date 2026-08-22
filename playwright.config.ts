import { defineConfig } from "@playwright/test";

const isUpdateRequested = process.argv.some((arg) => {
  if (arg === "-u" || arg === "--update-snapshots") {
    return true;
  }
  if (arg.startsWith("-u=") && arg !== "-u=none") {
    return true;
  }
  if (arg.startsWith("--update-snapshots=") && arg !== "--update-snapshots=none") {
    return true;
  }
  return false;
});

if (process.platform !== "linux" && isUpdateRequested) {
  throw new Error("Chromium visual baselines may only be updated in the pinned Linux environment.");
}

export default defineConfig({
  testDir: "./test/visual",
  outputDir: ".test-reports/playwright/results",
  snapshotPathTemplate: "{testDir}/baselines/{projectName}/{arg}{ext}",
  updateSnapshots: isUpdateRequested ? "all" : "none",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI
    ? [
        ["line"],
        ["html", { outputFolder: ".test-reports/playwright/html", open: "never" }],
      ]
    : "line",
  expect: {
    timeout: 5_000,
    toMatchSnapshot: {
      maxDiffPixels: 0,
      threshold: 0,
    },
  },
  use: {
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testMatch: ["visual-equivalence.spec.ts", "preview.spec.ts"],
      use: { browserName: "chromium" },
    },
    {
      name: "firefox",
      testMatch: ["cross-browser-smoke.spec.ts", "preview.spec.ts"],
      use: { browserName: "firefox" },
    },
    {
      name: "webkit",
      testMatch: ["cross-browser-smoke.spec.ts", "preview.spec.ts"],
      use: { browserName: "webkit" },
    },
  ],
});
