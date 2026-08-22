import { readFile, writeFile } from "node:fs/promises";

import { expect, test, type TestInfo } from "@playwright/test";

import {
  createVisualFixture,
  PRODUCTION_FIXTURE_DIRECTORY,
  PRODUCTION_VISUAL_CASES,
  renderCase,
  VISUAL_CASES,
  type VisualFixture,
} from "./harness.js";

async function expectExactScreenshot(
  actual: Buffer,
  expected: Buffer,
  testInfo: TestInfo,
  labels: readonly [string, string],
): Promise<void> {
  if (!actual.equals(expected)) {
    await testInfo.attach(`${labels[0]}.png`, { body: actual, contentType: "image/png" });
    await testInfo.attach(`${labels[1]}.png`, { body: expected, contentType: "image/png" });
  }
  expect(actual.equals(expected)).toBe(true);
}

test.describe("Terminal Nova complete-pipeline visual equivalence", () => {
  let fixture: VisualFixture;

  test.beforeAll(async () => {
    fixture = await createVisualFixture();
  });

  test.afterAll(async () => {
    await fixture.close();
  });

  for (const visualCase of VISUAL_CASES) {
    test(visualCase.name, async ({ page }, testInfo) => {
      const original = await renderCase(page, fixture, "original", visualCase);
      const rebuilt = await renderCase(page, fixture, "rebuilt", visualCase);
      const installed = await renderCase(page, fixture, "installed", visualCase);
      expect(original.status).toBe(200);
      expect(rebuilt.status).toBe(200);
      expect(installed.status).toBe(200);
      expect([...original.errors, ...rebuilt.errors, ...installed.errors]).toEqual([]);
      await expectExactScreenshot(original.screenshot, rebuilt.screenshot, testInfo, ["original", "rebuilt"]);
      await expectExactScreenshot(rebuilt.screenshot, installed.screenshot, testInfo, ["rebuilt", "installed"]);
      if (process.platform === "linux") {
        expect(rebuilt.screenshot).toMatchSnapshot(`${visualCase.name}.png`, {
          maxDiffPixels: 0,
          threshold: 0,
        });
      }
    });
  }

  test("same-run comparator detects a deliberate installed visual change", async ({ page }, testInfo) => {
    const visualCase = VISUAL_CASES.find((candidate) => candidate.name === "mark-full-color-128x128-white");
    expect(visualCase).toBeDefined();
    const installedPath = fixture.installedPath("theme-forge-terminal-nova-mark.svg");
    const originalBytes = await readFile(installedPath, "utf8");
    const changedBytes = originalBytes.replace(
      'stop-color="#FF8A3D"',
      'stop-color="#00FF00"',
    );
    expect(changedBytes).not.toBe(originalBytes);
    const before = await renderCase(page, fixture, "rebuilt", visualCase!);
    try {
      await writeFile(installedPath, changedBytes);
      const after = await renderCase(page, fixture, "installed", visualCase!);
      if (before.screenshot.equals(after.screenshot)) {
        await testInfo.attach("before.png", { body: before.screenshot, contentType: "image/png" });
        await testInfo.attach("after.png", { body: after.screenshot, contentType: "image/png" });
      }
      expect(before.screenshot.equals(after.screenshot)).toBe(false);
    } finally {
      await writeFile(installedPath, originalBytes);
    }
  });
});

test.describe("Terminal Nova current production visual equivalence", () => {
  let fixture: VisualFixture;

  test.beforeAll(async () => {
    fixture = await createVisualFixture(PRODUCTION_FIXTURE_DIRECTORY);
  });

  test.afterAll(async () => {
    await fixture.close();
  });

  for (const visualCase of PRODUCTION_VISUAL_CASES) {
    test(visualCase.name, async ({ page }, testInfo) => {
      const original = await renderCase(page, fixture, "original", visualCase);
      const rebuilt = await renderCase(page, fixture, "rebuilt", visualCase);
      const installed = await renderCase(page, fixture, "installed", visualCase);
      expect(original.status).toBe(200);
      expect(rebuilt.status).toBe(200);
      expect(installed.status).toBe(200);
      expect([...original.errors, ...rebuilt.errors, ...installed.errors]).toEqual([]);
      await expectExactScreenshot(original.screenshot, rebuilt.screenshot, testInfo, ["original", "rebuilt"]);
      await expectExactScreenshot(rebuilt.screenshot, installed.screenshot, testInfo, ["rebuilt", "installed"]);
    });
  }
});
