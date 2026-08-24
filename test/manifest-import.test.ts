import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bundleProject,
  importProject,
  parseAssetToml,
  parseProjectToml,
  serializeBundleManifest,
  unwrapBundleManifest,
  type BundleManifestV1,
} from "../src/index.js";
import { makeTempDir, unwrap } from "./helpers.js";

describe("manifest-assisted import", () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = makeTempDir("tfsb-manifest-import-src-");
    targetDir = makeTempDir("tfsb-manifest-import-dest-");

    mkdirSync(join(sourceDir, ".tfsb", "assets"), { recursive: true });
    mkdirSync(join(sourceDir, ".tfsb", "companions"), { recursive: true });
    writeFileSync(
      join(sourceDir, ".tfsb", "project.toml"),
      `schema_version = 1\nname = "source-brand"\n[build]\ndirectory = "brand/dist"\n`,
      "utf8",
    );
    const assetToml = `schema_version = 1
id = "brand-mark"
filename = "brand-mark.svg"

[canvas]
width = 50
height = 50
view_box = "0 0 50 50"

[accessibility]
title = "Brand Mark"
title_id = "mark-title"
description = "Brand mark."
description_id = "mark-desc"

[[elements]]
type = "path"
d = "M 0 0 H 50 V 50 H 0 Z"
`;
    writeFileSync(join(sourceDir, ".tfsb", "assets", "brand-mark.toml"), assetToml, "utf8");
    writeFileSync(join(sourceDir, ".tfsb", "companions", "README.md"), "# Brand Readme\n", "utf8");
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("imports a bundle with --manifest, preserves asset IDs, and ignores build/install policies", async () => {
    await bundleProject({
      root: sourceDir,
      output: "bundle.zip",
    });

    const bundlePath = join(sourceDir, "bundle.zip");
    const plan = await importProject({
      archive: bundlePath,
      root: targetDir,
      schema: 1,
      manifest: true,
    });

    expect(plan.assets).toHaveLength(1);
    expect(plan.assets[0]?.id).toBe("brand-mark");
    expect(plan.assets[0]?.filename).toBe("brand-mark.svg");
    expect(plan.companions).toHaveLength(1);
    expect(plan.companions[0]?.filename).toBe("README.md");

    // Canonical files created
    expect(existsSync(join(targetDir, ".tfsb", "project.toml"))).toBe(true);
    expect(existsSync(join(targetDir, ".tfsb", "assets", "brand-mark.toml"))).toBe(true);
    expect(existsSync(join(targetDir, ".tfsb", "companions", "README.md"))).toBe(true);

    const project = unwrap(parseProjectToml(readFileSync(join(targetDir, ".tfsb", "project.toml"), "utf8")));
    expect(project.name).toBe("source-brand");
    expect(project.installs).toEqual([]);
    expect(project.companions).toEqual([]);
  });

  it("preserves explicit manifest assetId when different from filename stem", async () => {
    // Manually craft a ZIP with custom manifest where assetId = "custom-id" and filename = "logo.svg"
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 10 10" aria-labelledby="t d">
  <title id="t">Title</title>
  <desc id="d">Desc</desc>
  <path d="M 0 0 H 10 V 10 H 0 Z"/>
</svg>`;
    const svgBytes = Buffer.from(svgContent, "utf8");
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(svgBytes).digest("hex");

    const manifest: BundleManifestV1 = {
      kind: "tfsb-bundle-manifest",
      schemaVersion: 1,
      generator: { name: "test", version: "1.0" },
      projectName: "explicit-brand",
      files: [
        {
          type: "asset",
          name: "logo.svg",
          assetId: "custom-id" as any,
          sha256: sha,
        },
      ],
    };
    const manifestBytes = Buffer.from(serializeBundleManifest(manifest), "utf8");

    const zipData = {
      "logo.svg": [svgBytes, { level: 0, mtime: new Date(1980, 0, 1) }],
      "tfsb-manifest.json": [manifestBytes, { level: 0, mtime: new Date(1980, 0, 1) }],
    };
    const zipBytes = zipSync(zipData as any);
    const customZipPath = join(sourceDir, "custom.zip");
    writeFileSync(customZipPath, zipBytes);

    const plan = await importProject({
      archive: customZipPath,
      root: targetDir,
      schema: 1,
      manifest: true,
      recordProvenance: true,
    });

    expect(plan.assets[0]?.id).toBe("custom-id");
    expect(plan.assets[0]?.filename).toBe("logo.svg");
    expect(existsSync(join(targetDir, ".tfsb", "assets", "custom-id.toml"))).toBe(true);
    expect(existsSync(join(targetDir, ".tfsb", "provenance.json"))).toBe(true);

    const prov = JSON.parse(readFileSync(join(targetDir, ".tfsb", "provenance.json"), "utf8"));
    expect(prov.records[0].assetId).toBe("custom-id");
    expect(prov.records[0].entryName).toBe("logo.svg");
  });

  it("fails if manifest is missing from archive", async () => {
    const zipData = {
      "icon.svg": [Buffer.from("<svg></svg>"), { level: 0 }],
    };
    const zipBytes = zipSync(zipData as any);
    const badZip = join(sourceDir, "no-manifest.zip");
    writeFileSync(badZip, zipBytes);

    await expect(
      importProject({ archive: badZip, root: targetDir, schema: 1, manifest: true }),
    ).rejects.toThrow(/Archive lacks required root tfsb-manifest\.json/);

    expect(existsSync(join(targetDir, ".tfsb"))).toBe(false);
  });

  it("fails if archive contains undeclared extra entry", async () => {
    const manifest: BundleManifestV1 = {
      kind: "tfsb-bundle-manifest",
      schemaVersion: 1,
      generator: { name: "test", version: "1.0" },
      files: [],
    };
    const manifestBytes = Buffer.from(serializeBundleManifest(manifest), "utf8");

    const zipData = {
      "extra.txt": [Buffer.from("extra"), { level: 0 }],
      "tfsb-manifest.json": [manifestBytes, { level: 0 }],
    };
    const badZip = join(sourceDir, "extra.zip");
    writeFileSync(badZip, zipSync(zipData as any));

    await expect(
      importProject({ archive: badZip, root: targetDir, schema: 1, manifest: true }),
    ).rejects.toThrow(/Archive contains undeclared entry/);
  });

  it("fails if entry digest mismatches manifest", async () => {
    const manifest: BundleManifestV1 = {
      kind: "tfsb-bundle-manifest",
      schemaVersion: 1,
      generator: { name: "test", version: "1.0" },
      files: [
        {
          type: "companion",
          name: "README.md",
          sha256: "0".repeat(64), // Mismatched SHA
        },
      ],
    };
    const manifestBytes = Buffer.from(serializeBundleManifest(manifest), "utf8");

    const zipData = {
      "README.md": [Buffer.from("actual content"), { level: 0 }],
      "tfsb-manifest.json": [manifestBytes, { level: 0 }],
    };
    const badZip = join(sourceDir, "tampered.zip");
    writeFileSync(badZip, zipSync(zipData as any));

    await expect(
      importProject({ archive: badZip, root: targetDir, schema: 1, manifest: true }),
    ).rejects.toThrow(/Digest mismatch for entry/);
  });

  it("supports partial manifest import with --select and --companion", async () => {
    await bundleProject({
      root: sourceDir,
      output: "bundle.zip",
    });

    const plan = await importProject({
      archive: join(sourceDir, "bundle.zip"),
      root: targetDir,
      schema: 1,
      manifest: true,
      selections: ["brand-mark.svg"],
    });

    expect(plan.assets).toHaveLength(1);
    expect(plan.companions).toHaveLength(0);
    expect(existsSync(join(targetDir, ".tfsb", "assets", "brand-mark.toml"))).toBe(true);
    expect(existsSync(join(targetDir, ".tfsb", "companions", "README.md"))).toBe(false);
  });

  it("fails with ARCHIVE_UNSAFE_TYPE when directory entry exists and manifest is present", async () => {
    const manifest: BundleManifestV1 = {
      kind: "tfsb-bundle-manifest",
      schemaVersion: 1,
      generator: { name: "test", version: "1.0" },
      files: [],
    };
    const manifestBytes = Buffer.from(serializeBundleManifest(manifest), "utf8");
    const zipData = {
      "folder/": [new Uint8Array(0), { level: 0 }],
      "tfsb-manifest.json": [manifestBytes, { level: 0 }],
    };
    const zipPath = join(sourceDir, "dir-with-manifest.zip");
    writeFileSync(zipPath, zipSync(zipData as any));

    await expect(
      importProject({ archive: zipPath, root: targetDir, schema: 1, manifest: true }),
    ).rejects.toThrow(/Directory entry 'folder\/' is not allowed in manifest-assisted archives/);
  });

  it("fails with ARCHIVE_MANIFEST_MISSING when directory entry exists and manifest is absent", async () => {
    const zipData = {
      "folder/": [new Uint8Array(0), { level: 0 }],
      "icon.svg": [Buffer.from("<svg></svg>"), { level: 0 }],
    };
    const zipPath = join(sourceDir, "dir-no-manifest.zip");
    writeFileSync(zipPath, zipSync(zipData as any));

    await expect(
      importProject({ archive: zipPath, root: targetDir, schema: 1, manifest: true }),
    ).rejects.toThrow(/Archive lacks required root tfsb-manifest\.json/);
  });
});
