import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import {
  BRAND_BUNDLE_MANIFEST_FILENAME,
  BUNDLE_MANIFEST_FILENAME,
  checkProject,
  importBrandProject,
  listProject,
  planBrandImport,
} from "../../src/index.js";
import { runCli } from "../../src/cli.js";
import { readRepoFile } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0, roots.length)) {
    await rm(root, { recursive: true, force: true });
  }
});

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (text: string) => { stdout += text; },
      stderr: (text: string) => { stderr += text; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function createGoldenArchive(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "tfsb-archive-dir-"));
  roots.push(tmp);
  const archivePath = join(tmp, "core-fixture.zip");

  const manifestJson = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/tfsb-manifest.json");
  const brandManifestJson = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/tfsb-brand-manifest.json");
  const pkgToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/brand/brand-package.toml");
  const brandToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/brand/brand.toml");
  const darkSvg = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/assets/fixture-mark-on-dark.svg");
  const lightSvg = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/assets/fixture-mark-on-light.svg");
  const guidanceMd = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/companions/GUIDANCE.md");

  const zipData = {
    [BUNDLE_MANIFEST_FILENAME]: [Buffer.from(manifestJson, "utf8"), { level: 0 }],
    [BRAND_BUNDLE_MANIFEST_FILENAME]: [Buffer.from(brandManifestJson, "utf8"), { level: 0 }],
    "brand/brand-package.toml": [Buffer.from(pkgToml, "utf8"), { level: 0 }],
    "brand/brand.toml": [Buffer.from(brandToml, "utf8"), { level: 0 }],
    "assets/fixture-mark-on-dark.svg": [Buffer.from(darkSvg, "utf8"), { level: 0 }],
    "assets/fixture-mark-on-light.svg": [Buffer.from(lightSvg, "utf8"), { level: 0 }],
    "companions/GUIDANCE.md": [Buffer.from(guidanceMd, "utf8"), { level: 0 }],
  };

  const zipBytes = zipSync(zipData as any);
  await writeFile(archivePath, zipBytes);
  return archivePath;
}

describe("brand package import", () => {
  it("imports a golden brand package bundle executing 12-step verification sequence", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-import-target-"));
    roots.push(targetRoot);

    const plan = await importBrandProject({
      archive: archivePath,
      root: targetRoot,
    });

    expect(plan.assets.length).toBe(2);
    expect(plan.companions.length).toBe(1);
    expect(plan.packageModel.packageId).toBe("core-fixture-brand");
    expect(plan.packageModel.brandVersion).toBe("0.4.0-fixture.1");
    expect(plan.brandManifest.brandManifestDigest).toBe("sha256:9ac4ecc30676224eba1d044fbce94345906b5ca76e12a932fad16a26eb480585");

    // Verify files created under .tfsb
    expect(existsSync(join(targetRoot, ".tfsb", "project.toml"))).toBe(true);
    expect(existsSync(join(targetRoot, ".tfsb", "brand.toml"))).toBe(true);
    expect(existsSync(join(targetRoot, ".tfsb", "brand-package.toml"))).toBe(true);
    expect(existsSync(join(targetRoot, ".tfsb", "assets", "fixture-mark-on-dark.toml"))).toBe(true);
    expect(existsSync(join(targetRoot, ".tfsb", "assets", "fixture-mark-on-light.toml"))).toBe(true);
    expect(existsSync(join(targetRoot, ".tfsb", "companions", "GUIDANCE.md"))).toBe(true);
    expect(existsSync(join(targetRoot, ".tfsb", "provenance.json"))).toBe(true);

    // Verify nothing is written outside .tfsb
    expect(existsSync(join(targetRoot, "GUIDANCE.md"))).toBe(false);

    // Build project so check is clean
    await runCli(["build"], targetRoot, capture().io);

    // Check project passes cleanly
    const checkResult = await checkProject(targetRoot);
    expect(checkResult.valid).toBe(true);
    expect(checkResult.brand).toBeDefined();
    expect(checkResult.brand?.valid).toBe(true);
    expect(checkResult.brand?.brandSystemDigest).toBe("sha256:4e10ef25161f37bdd137bcf85fcf1b842b4e0a6512f863d7f2fbba0d8a7e9c4d");

    // List project includes brand section
    const listResult = await listProject(targetRoot);
    expect(listResult.brand).toBeDefined();
    expect(listResult.assets.length).toBe(2);
    expect(listResult.companions.length).toBe(1);
  });

  it("fails closed when generic import without --brand-package encounters a brand bundle", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-import-fail-"));
    roots.push(targetRoot);

    const cli = capture();
    expect(await runCli(["import", archivePath, "--root", targetRoot, "--manifest"], targetRoot, cli.io)).toBe(1);
    expect(cli.stderr()).toContain("BRAND_MANIFEST_PRESENT");
  });

  it("fails closed when target .tfsb already exists", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-import-init-"));
    roots.push(targetRoot);
    await mkdir(join(targetRoot, ".tfsb"));

    await expect(
      importBrandProject({
        archive: archivePath,
        root: targetRoot,
      }),
    ).rejects.toThrow();

    const cli = capture();
    expect(await runCli(["import", archivePath, "--root", targetRoot, "--manifest", "--brand-package"], targetRoot, cli.io)).toBe(1);
    expect(cli.stderr()).toContain("ROOT_ALREADY_INITIALIZED");
  });

  it("CLI outputs human and JSON import results cleanly", async () => {
    const archivePath = await createGoldenArchive();

    // Human CLI
    const targetRoot1 = await mkdtemp(join(tmpdir(), "tfsb-import-cli1-"));
    roots.push(targetRoot1);
    const humanCli = capture();
    expect(await runCli(["import", archivePath, "--root", targetRoot1, "--manifest", "--brand-package"], targetRoot1, humanCli.io)).toBe(0);
    expect(humanCli.stdout()).toContain("Brand imported: core-fixture-brand (v0.4.0-fixture.1)");
    expect(humanCli.stdout()).toContain("brand manifest: sha256:9ac4ecc30676224eba1d044fbce94345906b5ca76e12a932fad16a26eb480585");

    // JSON CLI
    const targetRoot2 = await mkdtemp(join(tmpdir(), "tfsb-import-cli2-"));
    roots.push(targetRoot2);
    const jsonCli = capture();
    expect(await runCli(["import", archivePath, "--root", targetRoot2, "--manifest", "--brand-package", "--json"], targetRoot2, jsonCli.io)).toBe(0);
    const parsed = JSON.parse(jsonCli.stdout());
    expect(parsed.status).toBe("ok");
    expect(parsed.exitCode).toBe(0);
    expect(parsed.data.brand.packageId).toBe("core-fixture-brand");
    expect(parsed.data.brand.brandManifestDigest).toBe("sha256:9ac4ecc30676224eba1d044fbce94345906b5ca76e12a932fad16a26eb480585");
  });
});
