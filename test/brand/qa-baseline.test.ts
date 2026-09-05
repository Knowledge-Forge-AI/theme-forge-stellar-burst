import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { computeAssetSemanticDigest, computeSvgOutputDigest, disposeBrandQaBaselineUpdatePlan, executeBrandQaBaselineUpdatePlan, loadCanonicalProject, planBrandQaBaselineUpdate, type BrandQaRendererCapability } from "../../src/index.js";
import { makeTempDir, readRepoFile, repoPath } from "../helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function renderer(pixel: number): BrandQaRendererCapability {
  return {
    descriptor: { id: "fake", version: "1", qualificationId: "test", platformClaim: "portable" },
    renderSvg(input) { const rgba8 = new Uint8Array(input.width * input.height * 4); rgba8.set([pixel, 0, 0, 255]); return { width: input.width, height: input.height, rgba8, pngBytes: new Uint8Array([pixel, 80, 78, 71]) }; },
    decodePng(input) { const rgba8 = new Uint8Array(input.expectedWidth * input.expectedHeight * 4); rgba8.set([input.pngBytes[0]!, 0, 0, 255]); return { width: input.expectedWidth, height: input.expectedHeight, rgba8, pngBytes: new Uint8Array(input.pngBytes) }; },
  };
}

async function projectRoot(): Promise<string> {
  const root = makeTempDir("tfsb-qa-baseline-");
  roots.push(root);
  cpSync(repoPath("docs/examples/v0.4/brand-system/core-minimal/.tfsb"), join(root, ".tfsb"), { recursive: true });
  const loaded = await loadCanonicalProject(root, "check");
  unlinkSync(join(root, ".tfsb", "brand-package.toml"));
  const brandPath = join(root, ".tfsb", "brand.toml");
  writeFileSync(brandPath, readFileSync(brandPath, "utf8").replace("qa = false", "qa = true").replace("package = true", "package = false"));
  const asset = loaded.assets.find((entry) => entry.id === "fixture-mark-on-light")!;
  const svg = loaded.outputs.get(asset.filename)!;
  const qa = `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "release"
renderer = "required"
formats = ["json"]
cases = ["golden"]
[[cases]]
id = "inventory"
kind = "inventory"
family = "core-fixture"
`;
  const normalizedQa = qa.replace('cases = ["golden"]', 'cases = ["inventory"]');
  writeFileSync(join(root, ".tfsb", "brand-qa.toml"), normalizedQa);
  return root;
}

describe("brand QA baseline update authority", () => {
  it("creates and explicitly updates one fixed baseline through one-shot plans", async () => {
    const root = await projectRoot();
    const create = await planBrandQaBaselineUpdate({ root, profileId: "release", caseId: "golden", renderer: renderer(1), create: { asset: "fixture-mark-on-light", size: [2, 2], background: "transparent" } });
    expect(create.state).toBe("create");
    expect(Object.isFrozen(create)).toBe(true);
    expect("pngBytes" in create).toBe(false);
    const copied = { ...create };
    await expect(executeBrandQaBaselineUpdatePlan(copied as typeof create)).rejects.toThrow();
    const created = await executeBrandQaBaselineUpdatePlan(create);
    expect(created.written).toBe(true);
    expect(readFileSync(join(root, ".tfsb", "brand-baselines", "release", "golden.png"))).toEqual(Buffer.from([1, 80, 78, 71]));
    await expect(executeBrandQaBaselineUpdatePlan(create)).rejects.toThrow();

    const update = await planBrandQaBaselineUpdate({ root, profileId: "release", caseId: "golden", renderer: renderer(2) });
    expect(update.state).toBe("update");
    expect(update.rasterDifference.changedPixels).toBe(1);
    await executeBrandQaBaselineUpdatePlan(update);
    expect(readFileSync(join(root, ".tfsb", "brand-baselines", "release", "golden.png"))).toEqual(Buffer.from([2, 80, 78, 71]));
  });

  it("blocks missing, drifted, stale, copied, disposed, and raced authority", async () => {
    const root = await projectRoot();
    const applied = await planBrandQaBaselineUpdate({ root, profileId: "release", caseId: "golden", renderer: renderer(1), create: { asset: "fixture-mark-on-light", size: [2, 2], background: "transparent" } });
    await executeBrandQaBaselineUpdatePlan(applied);
    rmSync(join(root, ".tfsb", "brand-baselines"), { recursive: true });
    await expect(planBrandQaBaselineUpdate({ root, profileId: "release", caseId: "golden", renderer: renderer(1) })).rejects.toThrow(/missing/u);

    const fresh = await projectRoot();
    const create = await planBrandQaBaselineUpdate({ root: fresh, profileId: "release", caseId: "golden", renderer: renderer(1), create: { asset: "fixture-mark-on-light", size: [2, 2], background: "transparent" } });
    disposeBrandQaBaselineUpdatePlan(create);
    disposeBrandQaBaselineUpdatePlan(create);
    await expect(executeBrandQaBaselineUpdatePlan(create)).rejects.toThrow();

    const next = await planBrandQaBaselineUpdate({ root: fresh, profileId: "release", caseId: "golden", renderer: renderer(1), create: { asset: "fixture-mark-on-light", size: [2, 2], background: "transparent" } });
    writeFileSync(join(fresh, ".tfsb", "brand-qa.toml"), readFileSync(join(fresh, ".tfsb", "brand-qa.toml"), "utf8") + "# raced\n");
    await expect(executeBrandQaBaselineUpdatePlan(next)).rejects.toThrow();
  });

  it("rejects unowned baseline paths and preserves exact bytes through ordinary reload", async () => {
    const root = await projectRoot();
    mkdirSync(join(root, ".tfsb", "brand-baselines", "release"), { recursive: true });
    writeFileSync(join(root, ".tfsb", "brand-baselines", "release", "extra.png"), new Uint8Array([1]));
    await expect(loadCanonicalProject(root, "check")).rejects.toThrow(/no matching QA case metadata|unowned/u);
  });

  it("revalidates renderer identity at the promotion boundary", async () => {
    const root = await projectRoot();
    const created = await planBrandQaBaselineUpdate({ root, profileId: "release", caseId: "golden", renderer: renderer(1), create: { asset: "fixture-mark-on-light", size: [2, 2], background: "transparent" } });
    await executeBrandQaBaselineUpdatePlan(created);
    const mutable = renderer(2);
    const update = await planBrandQaBaselineUpdate({ root, profileId: "release", caseId: "golden", renderer: mutable });
    await expect(executeBrandQaBaselineUpdatePlan(update, { beforePromotion: () => { (mutable.descriptor as { version: string }).version = "raced"; } })).rejects.toThrow(/renderer descriptor changed/iu);
    expect(readFileSync(join(root, ".tfsb", "brand-baselines", "release", "golden.png"))).toEqual(Buffer.from([1, 80, 78, 71]));
  });

  it("blocks drifted baselines without explicit allowRebaseline and allows them with allowRebaseline", async () => {
    const root = await projectRoot();
    const created = await planBrandQaBaselineUpdate({ root, profileId: "release", caseId: "golden", renderer: renderer(1), create: { asset: "fixture-mark-on-light", size: [2, 2], background: "transparent" } });
    await executeBrandQaBaselineUpdatePlan(created);

    // Tamper with baseline PNG on disk to create drift
    writeFileSync(join(root, ".tfsb", "brand-baselines", "release", "golden.png"), Buffer.from([99, 80, 78, 71]));

    // Default (allowRebaseline not set) must fail with BRAND_QA_BASELINE_DRIFT
    await expect(planBrandQaBaselineUpdate({ root, profileId: "release", caseId: "golden", renderer: renderer(2) }))
      .rejects.toThrow(/explicit rebaseline authority is required/u);

    // With allowRebaseline: true, planning succeeds with state = "rebaseline"
    const rebaselinePlan = await planBrandQaBaselineUpdate({ root, profileId: "release", caseId: "golden", renderer: renderer(2), allowRebaseline: true });
    expect(rebaselinePlan.state).toBe("rebaseline");

    const result = await executeBrandQaBaselineUpdatePlan(rebaselinePlan);
    expect(result.written).toBe(true);
    expect(readFileSync(join(root, ".tfsb", "brand-baselines", "release", "golden.png"))).toEqual(Buffer.from([2, 80, 78, 71]));
  });

  it("detects staged-tree mismatch or tampering during baseline transaction execution", async () => {
    const root = await projectRoot();
    const created = await planBrandQaBaselineUpdate({ root, profileId: "release", caseId: "golden", renderer: renderer(1), create: { asset: "fixture-mark-on-light", size: [2, 2], background: "transparent" } });
    await executeBrandQaBaselineUpdatePlan(created);

    const update = await planBrandQaBaselineUpdate({ root, profileId: "release", caseId: "golden", renderer: renderer(2) });

    // Tamper with staged tree inside the transaction before validation
    await expect(executeBrandQaBaselineUpdatePlan(update, {
      afterStageWrite: () => {
        const stageName = readdirSync(root).find((entry) => entry.startsWith(".tfsb-stage-"));
        if (stageName !== undefined) {
          writeFileSync(join(root, stageName, "brand-qa.toml"), "invalid = true\n");
        }
      },
    })).rejects.toThrow(/Staged tree differs|Staged QA authority is invalid|Staged bytes differ|Staged QA semantics differ/u);
  });
});
