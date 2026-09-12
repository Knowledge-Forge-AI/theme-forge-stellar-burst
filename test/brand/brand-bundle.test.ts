import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import {
  BRAND_BUNDLE_MANIFEST_FILENAME,
  BUNDLE_MANIFEST_FILENAME,
  bundleBrandProject,
  parseBrandBundleManifest,
  parseBundleManifestV2,
  planBrandBundle,
  type BrandBundleResult,
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

async function setupCoreMinimalProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-brand-bundle-"));
  roots.push(root);

  await mkdir(join(root, ".tfsb", "assets"), { recursive: true });
  await mkdir(join(root, ".tfsb", "companions"), { recursive: true });

  const projectToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/project.toml");
  const brandToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
  const pkgToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand-package.toml");
  const assetDark = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-dark.toml");
  const assetLight = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml");
  const guidanceMd = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/GUIDANCE.md");

  await writeFile(join(root, ".tfsb", "project.toml"), projectToml);
  await writeFile(join(root, ".tfsb", "brand.toml"), brandToml);
  await writeFile(join(root, ".tfsb", "brand-package.toml"), pkgToml);
  await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-dark.toml"), assetDark);
  await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-light.toml"), assetLight);
  await writeFile(join(root, "GUIDANCE.md"), guidanceMd);
  await writeFile(join(root, ".tfsb", "companions", "GUIDANCE.md"), guidanceMd);

  // Build project so outputs are present
  await runCli(["build"], root, capture().io);

  return root;
}

describe("brand package bundling", () => {
  it("creates a byte-deterministic brand bundle matching golden vectors", async () => {
    const root = await setupCoreMinimalProject();
    const outputPath = "core-fixture.zip";

    const result = await bundleBrandProject({
      root,
      output: outputPath,
    });

    expect(result.written).toBe(true);
    expect(result.assetCount).toBe(2);
    expect(result.companionCount).toBe(1);
    expect(result.packageId).toBe("core-fixture-brand");
    expect(result.brandVersion).toBe("0.4.0-fixture.1");
    expect(result.genericManifestByteDigest).toBe("sha256:f937e53a25f2527db8db12a8bec302e9dc41a147949b0b7f56fb2783e73a8898");
    expect(result.brandPackageDigest).toBe("sha256:1c14df2cf73b282f366a5cef541cea1f3d9d08c1ab55c1ebbbf34e2f63ab9f23");
    expect(result.brandSystemDigest).toBe("sha256:4e10ef25161f37bdd137bcf85fcf1b842b4e0a6512f863d7f2fbba0d8a7e9c4d");
    expect(result.brandManifestDigest).toBe("sha256:e0c6ac8bc0d13f08e2f12d1306d73916e2786f79e64d31ba65aa96e57f4adb7e");

    // Read and unzip archive
    const zipBytes = await readFile(join(root, outputPath));
    const unzipped = unzipSync(zipBytes);

    const entryNames = Object.keys(unzipped);
    expect(entryNames).toEqual([
      "assets/fixture-mark-on-dark.svg",
      "assets/fixture-mark-on-light.svg",
      "brand/brand-package.toml",
      "brand/brand.toml",
      "companions/GUIDANCE.md",
      "tfsb-brand-manifest.json",
      "tfsb-manifest.json",
    ]);

    // Check generic manifest
    const genericManifestText = new TextDecoder("utf8").decode(unzipped[BUNDLE_MANIFEST_FILENAME]!);
    const parsedGeneric = parseBundleManifestV2(genericManifestText);
    expect(parsedGeneric.ok).toBe(true);

    // Check brand manifest
    const brandManifestText = new TextDecoder("utf8").decode(unzipped[BRAND_BUNDLE_MANIFEST_FILENAME]!);
    const parsedBrand = parseBrandBundleManifest(brandManifestText);
    expect(parsedBrand.ok).toBe(true);
    if (parsedBrand.ok) {
      expect(parsedBrand.value.brandManifestDigest).toBe("sha256:e0c6ac8bc0d13f08e2f12d1306d73916e2786f79e64d31ba65aa96e57f4adb7e");
    }
  });

  it("supports rebundling from an imported project when producer source is absent", async () => {
    const root = await setupCoreMinimalProject();

    // Remove producer source GUIDANCE.md from root
    await unlink(join(root, "GUIDANCE.md"));

    // Write valid schema-2 import provenance into .tfsb/provenance.json
    const provenance = {
      kind: "tfsb-import-provenance",
      schemaVersion: 2,
      records: [
        {
          type: "companion",
          canonicalPath: ".tfsb/companions/GUIDANCE.md",
          archive: {
            archiveDigestBasis: "tfsb-archive-bytes-v1",
            archiveDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            entryName: "companions/GUIDANCE.md",
            sourceBasis: "tfsb-archive-entry-bytes-v1",
            sourceDigest: "sha256:10a61401be21913c99086526840a27a24991815db9d7044ac1668787e737a9d3",
            archiveCanonicalBasis: "tfsb-companion-bytes-v1",
            archiveCanonicalDigest: "sha256:10a61401be21913c99086526840a27a24991815db9d7044ac1668787e737a9d3",
            canonicalBasis: "tfsb-companion-bytes-v1",
            canonicalState: "present",
            canonicalDigest: "sha256:10a61401be21913c99086526840a27a24991815db9d7044ac1668787e737a9d3",
            resolution: "aligned",
            toolVersion: "0.3.0",
          },
        },
      ],
    };
    await writeFile(join(root, ".tfsb", "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");

    const result = await bundleBrandProject({
      root,
      output: "rebundled.zip",
    });
    expect(result.written).toBe(true);
    expect(result.companionCount).toBe(1);
  });

  it("rejects subset flags --asset and --companion when --brand-package is set", async () => {
    const root = await setupCoreMinimalProject();

    await expect(
      bundleBrandProject({
        root,
        output: "subset.zip",
        assets: ["fixture-mark-on-dark"],
      }),
    ).rejects.toThrow();

    const cli = capture();
    expect(await runCli(["bundle", "--brand-package", "--output", "subset.zip", "--asset", "fixture-mark-on-dark"], root, cli.io)).toBe(1);
    expect(cli.stderr()).toContain("BUNDLE_SUBSET_UNSUPPORTED");
  });

  it("CLI outputs human and JSON results cleanly", async () => {
    const root = await setupCoreMinimalProject();

    // Human CLI
    const humanCli = capture();
    expect(await runCli(["bundle", "--brand-package", "--output", "cli-test.zip"], root, humanCli.io)).toBe(0);
    expect(humanCli.stdout()).toContain("Brand bundled: cli-test.zip");
    expect(humanCli.stdout()).toContain("package: core-fixture-brand (v0.4.0-fixture.1)");

    // JSON CLI
    const jsonCli = capture();
    expect(await runCli(["bundle", "--brand-package", "--output", "cli-test-2.zip", "--json"], root, jsonCli.io)).toBe(0);
    const parsed = JSON.parse(jsonCli.stdout());
    expect(parsed.status).toBe("ok");
    expect(parsed.exitCode).toBe(0);
    expect(parsed.data.packageId).toBe("core-fixture-brand");
    expect(parsed.data.brandManifestDigest).toBe("sha256:e0c6ac8bc0d13f08e2f12d1306d73916e2786f79e64d31ba65aa96e57f4adb7e");
  });
});
