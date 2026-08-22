import { expect, test } from "@playwright/test";

import {
  createVisualFixture,
  NATURAL_DIMENSIONS,
  renderCase,
  SMOKE_CASES,
  type VisualFixture,
} from "./harness.js";

test.describe("Terminal Nova cross-browser render smoke", () => {
  let fixture: VisualFixture;

  test.beforeAll(async () => {
    fixture = await createVisualFixture();
  });

  test.afterAll(async () => {
    await fixture.close();
  });

  for (const visualCase of SMOKE_CASES) {
    test(visualCase.name, async ({ page }) => {
      const blank = await renderCase(page, fixture, "original", visualCase, true);
      const original = await renderCase(page, fixture, "original", visualCase);
      const rebuilt = await renderCase(page, fixture, "rebuilt", visualCase);
      const expectedNatural = NATURAL_DIMENSIONS[visualCase.asset];
      expect(expectedNatural).toBeDefined();
      for (const rendered of [original, rebuilt]) {
        expect(rendered.status).toBe(200);
        expect(rendered.errors).toEqual([]);
        expect([rendered.naturalWidth, rendered.naturalHeight]).toEqual(expectedNatural);
        expect([rendered.renderedWidth, rendered.renderedHeight]).toEqual([
          visualCase.width,
          visualCase.height,
        ]);
        expect(rendered.screenshot.length).toBeGreaterThan(0);
        expect(rendered.screenshot.equals(blank.screenshot)).toBe(false);
      }
      expect(original.screenshot.equals(rebuilt.screenshot)).toBe(true);
    });
  }
});
