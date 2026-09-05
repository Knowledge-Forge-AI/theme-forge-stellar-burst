import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import {
  BRAND_BUNDLE_MANIFEST_FILENAME,
  BUNDLE_MANIFEST_FILENAME,
  planBrandImport,
} from "../../src/index.js";
import { computeRawSha256 } from "../../src/digests.js";
import { readRepoFile } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0, roots.length)) {
    await rm(root, { recursive: true, force: true });
  }
});

interface ArchiveEntries {
  manifestJson?: string;
  brandManifestJson?: string;
  pkgToml?: string;
  brandToml?: string;
  darkSvg?: string;
  lightSvg?: string;
  guidanceMd?: string;
  extraFiles?: Record<string, string>;
}

async function buildArchive(custom?: ArchiveEntries): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "tfsb-cross-mani-test-"));
  roots.push(tmp);
  const archivePath = join(tmp, "test-bundle.zip");

  const manifestJson = custom?.manifestJson ?? readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/tfsb-manifest.json");
  const brandManifestJson = custom?.brandManifestJson ?? readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/tfsb-brand-manifest.json");
  const pkgToml = custom?.pkgToml ?? readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/brand/brand-package.toml");
  const brandToml = custom?.brandToml ?? readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/brand/brand.toml");
  const darkSvg = custom?.darkSvg ?? readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/assets/fixture-mark-on-dark.svg");
  const lightSvg = custom?.lightSvg ?? readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/assets/fixture-mark-on-light.svg");
  const guidanceMd = custom?.guidanceMd ?? readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/companions/GUIDANCE.md");

  const zipData: Record<string, [Uint8Array, { level: number }]> = {
    [BUNDLE_MANIFEST_FILENAME]: [Buffer.from(manifestJson, "utf8"), { level: 0 }],
    [BRAND_BUNDLE_MANIFEST_FILENAME]: [Buffer.from(brandManifestJson, "utf8"), { level: 0 }],
    "brand/brand-package.toml": [Buffer.from(pkgToml, "utf8"), { level: 0 }],
    "brand/brand.toml": [Buffer.from(brandToml, "utf8"), { level: 0 }],
    "assets/fixture-mark-on-dark.svg": [Buffer.from(darkSvg, "utf8"), { level: 0 }],
    "assets/fixture-mark-on-light.svg": [Buffer.from(lightSvg, "utf8"), { level: 0 }],
    "companions/GUIDANCE.md": [Buffer.from(guidanceMd, "utf8"), { level: 0 }],
  };

  if (custom?.extraFiles) {
    for (const [p, content] of Object.entries(custom.extraFiles)) {
      zipData[p] = [Buffer.from(content, "utf8"), { level: 0 }];
    }
  }

  const zipBytes = zipSync(zipData as any);
  await writeFile(archivePath, zipBytes);
  return archivePath;
}

describe("brand cross-manifest verification matrix", () => {
  it("rejects brand-package.toml with tampered brand_system_digest", async () => {
    const pkgToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/brand/brand-package.toml");
    const tamperedPkgToml = pkgToml.replace(
      /brand_system_digest = "sha256:[a-f0-9]+"/,
      'brand_system_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"',
    );

    const archive = await buildArchive({ pkgToml: tamperedPkgToml });
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-target-"));
    roots.push(targetRoot);

    await expect(planBrandImport({ archive, root: targetRoot })).rejects.toThrow(
      /Digest mismatch for entry 'brand\/brand-package\.toml'|Brand package digest mismatch/,
    );
  });

  it("rejects brand manifest with tampered brandSystemDigest", async () => {
    const brandManifestJson = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/tfsb-brand-manifest.json");
    const tamperedManifest = brandManifestJson.replace(
      /"brandSystemDigest": "sha256:[a-f0-9]+"/,
      '"brandSystemDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"',
    );

    const archive = await buildArchive({ brandManifestJson: tamperedManifest });
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-target-"));
    roots.push(targetRoot);

    await expect(planBrandImport({ archive, root: targetRoot })).rejects.toThrow(
      /Brand manifest self-digest mismatch/,
    );
  });

  it("rejects brand manifest declaring unsupported domains in domainDigests", async () => {
    const brandManifestJson = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/tfsb-brand-manifest.json");
    const parsed = JSON.parse(brandManifestJson);
    parsed.domainDigests.tokens = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

    const archive = await buildArchive({ brandManifestJson: JSON.stringify(parsed, null, 2) });
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-target-"));
    roots.push(targetRoot);

    await expect(planBrandImport({ archive, root: targetRoot })).rejects.toThrow(
      /Brand manifest self-digest mismatch|Domain 'tokens' is unavailable/,
    );
  });

  it("rejects generic manifest containing unclaimed payload entries", async () => {
    const manifestJson = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/tfsb-manifest.json");
    const parsed = JSON.parse(manifestJson);
    parsed.files.push({
      type: "companion",
      path: "companions/EXTRA.md",
      sha256: computeRawSha256(Buffer.from("extra content")),
    });
    parsed.files.sort((a: any, b: any) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

    const archive = await buildArchive({
      manifestJson: JSON.stringify(parsed, null, 2),
      extraFiles: { "companions/EXTRA.md": "extra content" },
    });
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-target-"));
    roots.push(targetRoot);

    await expect(planBrandImport({ archive, root: targetRoot })).rejects.toThrow(
      /Generic manifest raw byte digest mismatch|unclaimed payload entry/,
    );
  });

  it("rejects brand package with incomplete semantic requirements", async () => {
    const brandToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/brand/brand.toml");
    // Remove one of the required bindings from brand.toml
    const incompleteBrandToml = brandToml.replace(/\[\[bindings\]\]\nfamily = "core-fixture"\nrole = "mark"\nvariant = "standard-light"\nasset = "fixture-mark-on-light"\n/, "");

    const archive = await buildArchive({ brandToml: incompleteBrandToml });
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-target-"));
    roots.push(targetRoot);

    await expect(planBrandImport({ archive, root: targetRoot })).rejects.toThrow(
      /Digest mismatch for entry 'brand\/brand\.toml'|does not match brand\.toml bindings count/,
    );
  });
});
