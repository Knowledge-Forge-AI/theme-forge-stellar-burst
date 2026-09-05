import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildProject,
  bundleBrandProject,
  importBrandProject,
  parseBrandPackageToml,
  type BrandPackageModel,
} from "../../src/index.js";
import { readRepoFile } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0, roots.length)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function setupProjectWithOptionalCompanion(companionPresent: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-opt-comp-"));
  roots.push(root);

  await mkdir(join(root, ".tfsb", "assets"), { recursive: true });
  await mkdir(join(root, ".tfsb", "companions"), { recursive: true });

  const projectToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/project.toml");
  const brandToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
  let pkgToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand-package.toml");
  // Set required = false
  pkgToml = pkgToml.replace("required = true", "required = false");

  const assetDark = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-dark.toml");
  const assetLight = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml");
  const guidanceMd = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/GUIDANCE.md");

  await writeFile(join(root, ".tfsb", "project.toml"), projectToml);
  await writeFile(join(root, ".tfsb", "brand.toml"), brandToml);
  await writeFile(join(root, ".tfsb", "brand-package.toml"), pkgToml);
  await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-dark.toml"), assetDark);
  await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-light.toml"), assetLight);

  if (companionPresent) {
    await writeFile(join(root, "GUIDANCE.md"), guidanceMd);
    await writeFile(join(root, ".tfsb", "companions", "GUIDANCE.md"), guidanceMd);
  }

  await buildProject(root);
  return root;
}

describe("ADR 0014 optional companion bundling and import semantics", () => {
  it("bundles and imports an absent optional companion cleanly, preserving declarations and omission", async () => {
    // 1. Source project has optional companion declared, but physical file is absent
    const sourceRoot = await setupProjectWithOptionalCompanion(false);
    const bundleFilename = "brand-bundle.zip";

    const bundleResult = await bundleBrandProject({
      root: sourceRoot,
      output: bundleFilename,
    });

    expect(bundleResult.entries.length).toBeGreaterThan(0);
    // Bundle entries should NOT contain companions/GUIDANCE.md
    expect(bundleResult.entries.some((e) => e.name.includes("GUIDANCE.md"))).toBe(false);

    // 2. Import into fresh target
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-opt-target-"));
    roots.push(targetRoot);

    const importPlan = await importBrandProject({
      archive: join(sourceRoot, bundleFilename),
      root: targetRoot,
    });

    expect(importPlan.companions).toEqual([]);
    expect(existsSync(join(targetRoot, ".tfsb", "companions", "GUIDANCE.md"))).toBe(false);

    // 3. Staged brand-package.toml still has the declaration with required = false
    const targetPkgText = await readFile(join(targetRoot, ".tfsb", "brand-package.toml"), "utf8");
    const parsedPkg = parseBrandPackageToml(targetPkgText);
    expect(parsedPkg.ok).toBe(true);
    if (parsedPkg.ok) {
      expect(parsedPkg.value.companions.length).toBe(1);
      expect(parsedPkg.value.companions[0]!.required).toBe(false);
      expect(parsedPkg.value.companions[0]!.id).toBe("fixture-guidance");
    }

    // 4. Staged provenance.json has zero companion records
    const provText = await readFile(join(targetRoot, ".tfsb", "provenance.json"), "utf8");
    const prov = JSON.parse(provText);
    expect(prov.records.some((r: any) => r.type === "companion")).toBe(false);

    // 5. Re-bundle from the imported project
    await buildProject(targetRoot);
    const rebundleFilename = "rebundle.zip";
    const rebundleResult = await bundleBrandProject({
      root: targetRoot,
      output: rebundleFilename,
    });

    expect(rebundleResult.entries.some((e) => e.name.includes("GUIDANCE.md"))).toBe(false);
  });

  it("bundles and imports a present optional companion cleanly with full provenance", async () => {
    const sourceRoot = await setupProjectWithOptionalCompanion(true);
    const bundleFilename = "brand-bundle.zip";

    const bundleResult = await bundleBrandProject({
      root: sourceRoot,
      output: bundleFilename,
    });

    expect(bundleResult.entries.some((e) => e.name === "companions/GUIDANCE.md")).toBe(true);

    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-opt-target-present-"));
    roots.push(targetRoot);

    const importPlan = await importBrandProject({
      archive: join(sourceRoot, bundleFilename),
      root: targetRoot,
    });

    expect(importPlan.companions.length).toBe(1);
    expect(existsSync(join(targetRoot, ".tfsb", "companions", "GUIDANCE.md"))).toBe(true);

    const provText = await readFile(join(targetRoot, ".tfsb", "provenance.json"), "utf8");
    const prov = JSON.parse(provText);
    expect(prov.records.some((r: any) => r.type === "companion" && r.canonicalPath === ".tfsb/companions/GUIDANCE.md")).toBe(true);
  });

  it("fails closed when a required companion is missing from source project at bundle time", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-req-missing-"));
    roots.push(root);

    await mkdir(join(root, ".tfsb", "assets"), { recursive: true });
    await mkdir(join(root, ".tfsb", "companions"), { recursive: true });

    const projectToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/project.toml");
    const brandToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
    const pkgToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand-package.toml"); // required = true
    const assetDark = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-dark.toml");
    const assetLight = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml");

    await writeFile(join(root, ".tfsb", "project.toml"), projectToml);
    await writeFile(join(root, ".tfsb", "brand.toml"), brandToml);
    await writeFile(join(root, ".tfsb", "brand-package.toml"), pkgToml);
    await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-dark.toml"), assetDark);
    await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-light.toml"), assetLight);
    // Do NOT write GUIDANCE.md

    await buildProject(root);

    await expect(
      bundleBrandProject({ root, output: "bundle.zip" }),
    ).rejects.toThrow(/Companion source.*is absent|COMPANION_SOURCE_MISSING/);
  });
});
