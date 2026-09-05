import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { disposeBrandImportPlan, getRetainedBrandImportDiffSnapshot, planBrandImport } from "../../src/brand/brand-import.js";
import type { DiagnosticError } from "../../src/diagnostics.js";
import * as publicApi from "../../src/index.js";
import { createConsumerBundle } from "../brand/consumer-test-helper.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function expectInvalid(action: () => unknown): void {
  try { action(); throw new Error("expected retained plan rejection"); }
  catch (error) { expect((error as DiagnosticError).diagnostic.code).toBe("IMPORT_INVALID_PLAN"); }
}

describe("retained brand import diff snapshot seam", () => {
  it("returns the exact immutable retained snapshot without private path data", async () => {
    const producer = await createConsumerBundle();
    const target = await mkdtemp(join(tmpdir(), "tfsb-retained-diff-"));
    roots.push(producer.root, target);
    const plan = await planBrandImport({ archive: producer.archive, root: target });
    const first = getRetainedBrandImportDiffSnapshot(plan);
    const second = getRetainedBrandImportDiffSnapshot(plan);
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(JSON.stringify(first)).not.toContain(producer.archive);
    expect(JSON.stringify(first)).not.toContain(target);
    expect(() => { (first as any).brandDigest = `sha256:${"0".repeat(64)}`; }).toThrow();
    expect(getRetainedBrandImportDiffSnapshot(plan)).toBe(first);
    await disposeBrandImportPlan(plan);
    expectInvalid(() => getRetainedBrandImportDiffSnapshot(plan));
  });

  it("rejects copied, forged, and prototype-forged plans and is not public", async () => {
    const producer = await createConsumerBundle();
    const target = await mkdtemp(join(tmpdir(), "tfsb-retained-forge-"));
    roots.push(producer.root, target);
    const plan = await planBrandImport({ archive: producer.archive, root: target });
    for (const forged of [{ ...plan }, Object.create(plan), Object.create(Object.getPrototypeOf(plan))]) {
      expectInvalid(() => getRetainedBrandImportDiffSnapshot(forged));
    }
    expect(publicApi).not.toHaveProperty("getRetainedBrandImportDiffSnapshot");
    await disposeBrandImportPlan(plan);
  });
});
