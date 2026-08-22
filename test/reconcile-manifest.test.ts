import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bundleProject,
  importProject,
  parseAssetToml,
  reconcileProject,
  serializeBundleManifest,
  type BundleManifestV1,
} from "../src/index.js";
import { makeTempDir, unwrap } from "./helpers.js";

function makeSvg(text: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 100 100" aria-labelledby="t d">
  <title id="t">${text}</title>
  <desc id="d">${text}</desc>
  <path d="M 0 0 H 100 V 100 H 0 Z"/>
</svg>`;
}

function makeZipWithManifest(
  filePath: string,
  entries: { name: string; assetId?: string; type: "asset" | "companion"; content: string }[],
  projectName = "manifest-test",
): void {
  const zipFiles: Record<string, [Uint8Array, any]> = {};
  const manifestRecords: any[] = [];

  for (const entry of entries) {
    const bytes = Buffer.from(entry.content, "utf8");
    const sha = createHash("sha256").update(bytes).digest("hex");
    zipFiles[entry.name] = [bytes, { level: 0, mtime: new Date(1980, 0, 1) }];
    if (entry.type === "asset") {
      manifestRecords.push({
        type: "asset",
        name: entry.name,
        assetId: entry.assetId ?? entry.name.replace(/\.svg$/, ""),
        sha256: sha,
      });
    } else {
      manifestRecords.push({
        type: "companion",
        name: entry.name,
        sha256: sha,
      });
    }
  }

  const manifest: BundleManifestV1 = {
    kind: "tfsb-bundle-manifest",
    schemaVersion: 1,
    generator: { name: "test", version: "1.0" },
    projectName,
    files: manifestRecords,
  };
  const manifestBytes = Buffer.from(serializeBundleManifest(manifest), "utf8");
  zipFiles["tfsb-manifest.json"] = [manifestBytes, { level: 0, mtime: new Date(1980, 0, 1) }];

  writeFileSync(filePath, zipSync(zipFiles as any));
}

describe("manifest identity and reconciliation integration", () => {
  let projDir: string;
  let workDir: string;

  beforeEach(() => {
    projDir = makeTempDir("tfsb-reconcile-manifest-proj-");
    workDir = makeTempDir("tfsb-reconcile-manifest-work-");
  });

  afterEach(() => {
    rmSync(projDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it("reconciles identical bundle to UNCHANGED, preserving manifest assetId and filename", async () => {
    const bundlePath = join(workDir, "v1.zip");
    makeZipWithManifest(bundlePath, [
      { type: "asset", name: "logo.svg", assetId: "brand-primary", content: makeSvg("Brand Primary") },
      { type: "companion", name: "README.md", content: "# Readme\n" },
    ]);

    // 1. Initial import with provenance
    await importProject({
      archive: bundlePath,
      root: projDir,
      manifest: true,
      recordProvenance: true,
    });

    // Verify canonical state
    expect(existsSync(join(projDir, ".tfsb", "assets", "brand-primary.toml"))).toBe(true);

    // 2. Reconcile identical bundle
    const result = await reconcileProject({
      archive: bundlePath,
      root: projDir,
      apply: true,
    });

    expect(result.changed).toBe(false);
    expect(result.pending).toBe(false);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]?.classification).toBe("UNCHANGED");
    expect(result.records[1]?.classification).toBe("UNCHANGED");

    // Canonical file still named brand-primary.toml
    expect(existsSync(join(projDir, ".tfsb", "assets", "brand-primary.toml"))).toBe(true);
  });

  it("reconciles changed SVG under same entry to ARCHIVE_CHANGED, preserving manifest ID", async () => {
    const bundleV1 = join(workDir, "v1.zip");
    makeZipWithManifest(bundleV1, [
      { type: "asset", name: "logo.svg", assetId: "brand-primary", content: makeSvg("V1 Logo") },
    ]);

    await importProject({
      archive: bundleV1,
      root: projDir,
      manifest: true,
      recordProvenance: true,
    });

    const bundleV2 = join(workDir, "v2.zip");
    makeZipWithManifest(bundleV2, [
      { type: "asset", name: "logo.svg", assetId: "brand-primary", content: makeSvg("V2 Logo Changed") },
    ]);

    const result = await reconcileProject({
      archive: bundleV2,
      root: projDir,
      apply: true,
    });

    expect(result.applied).toBe(true);
    expect(result.records[0]?.key).toBe("brand-primary");
    expect(result.records[0]?.classification).toBe("ARCHIVE_CHANGED");

    // Canonical asset remains under brand-primary.toml with updated content
    const tomlContent = readFileSync(join(projDir, ".tfsb", "assets", "brand-primary.toml"), "utf8");
    const asset = unwrap(parseAssetToml(tomlContent, "brand-primary.toml"));
    expect(asset.id).toBe("brand-primary");
    expect(asset.filename).toBe("logo.svg");
    expect(asset.svg.accessibility.title).toBe("V2 Logo Changed");
  });

  it("restores accepted absence (tombstone) to original manifest assetId on archive restoration", async () => {
    const bundleV1 = join(workDir, "v1.zip");
    makeZipWithManifest(bundleV1, [
      { type: "asset", name: "logo.svg", assetId: "brand-primary", content: makeSvg("Initial Logo") },
    ]);

    await importProject({
      archive: bundleV1,
      root: projDir,
      manifest: true,
      recordProvenance: true,
    });

    // Remove asset explicitly to create tombstone
    await reconcileProject({
      archive: bundleV1,
      root: projDir,
      removals: ["brand-primary"],
      apply: true,
    });
    expect(existsSync(join(projDir, ".tfsb", "assets", "brand-primary.toml"))).toBe(false);

    // Reconcile archive containing logo.svg again
    const restoreResult = await reconcileProject({
      archive: bundleV1,
      root: projDir,
      resolutions: ["brand-primary=archive"],
      apply: true,
    });

    expect(restoreResult.applied).toBe(true);
    expect(existsSync(join(projDir, ".tfsb", "assets", "brand-primary.toml"))).toBe(true);

    const restoredAsset = unwrap(
      parseAssetToml(readFileSync(join(projDir, ".tfsb", "assets", "brand-primary.toml"), "utf8")),
    );
    expect(restoredAsset.id).toBe("brand-primary");
    expect(restoredAsset.filename).toBe("logo.svg");
  });

  it("assigns basename ID to genuinely new unmanifested archive entry", async () => {
    const bundleV1 = join(workDir, "v1.zip");
    makeZipWithManifest(bundleV1, [
      { type: "asset", name: "logo.svg", assetId: "brand-primary", content: makeSvg("Initial Logo") },
    ]);

    await importProject({
      archive: bundleV1,
      root: projDir,
      manifest: true,
      recordProvenance: true,
    });

    // Archive V2 includes a new file "icon.svg"
    const bundleV2 = join(workDir, "v2.zip");
    makeZipWithManifest(bundleV2, [
      { type: "asset", name: "logo.svg", assetId: "brand-primary", content: makeSvg("Initial Logo") },
      { type: "asset", name: "icon.svg", assetId: "icon", content: makeSvg("New Icon") },
    ]);

    const result = await reconcileProject({
      archive: bundleV2,
      root: projDir,
      apply: true,
    });

    expect(result.records.find((r) => r.key === "icon")?.classification).toBe("NEW_ASSET");
    expect(existsSync(join(projDir, ".tfsb", "assets", "icon.toml"))).toBe(true);
    expect(existsSync(join(projDir, ".tfsb", "assets", "brand-primary.toml"))).toBe(true);
  });
});
