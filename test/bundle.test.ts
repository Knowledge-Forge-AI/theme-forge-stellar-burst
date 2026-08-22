import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bundleProject,
  computeAssetSemanticDigest,
  importProject,
  planBundle,
  type BundleOptions,
} from "../src/index.js";
import { makeTempDir, repoPath } from "./helpers.js";

const productionFixtureZip = fileURLToPath(
  new URL("./fixtures/tftn-production-v1/theme-forge-terminal-nova-production-v1.zip", import.meta.url),
);

// Helper to make a mini zip if needed, or import from fixture directory
function setupCanonicalProject(dir: string, fixtureFiles: string[] = []): void {
  mkdirSync(join(dir, ".tfsb", "assets"), { recursive: true });
  mkdirSync(join(dir, ".tfsb", "companions"), { recursive: true });
  const projectToml = `schema_version = 1
name = "test-project"

[build]
directory = "brand/dist"
`;
  writeFileSync(join(dir, ".tfsb", "project.toml"), projectToml, "utf8");
}

describe("bundle planner and execution determinism", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("tfsb-bundle-test-");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("produces byte-identical ZIP output across multiple runs", async () => {
    // Setup project with sample asset and companion
    setupCanonicalProject(tempDir);
    const assetToml = `schema_version = 1
id = "sample-icon"
filename = "sample-icon.svg"

[canvas]
width = 100
height = 100
view_box = "0 0 100 100"

[accessibility]
title = "Sample Icon"
title_id = "sample-icon-title"
description = "Sample icon."
description_id = "sample-icon-desc"

[[elements]]
type = "path"
d = "M 10 10 H 90 V 90 H 10 Z"
`;
    writeFileSync(join(tempDir, ".tfsb", "assets", "sample-icon.toml"), assetToml, "utf8");
    writeFileSync(join(tempDir, ".tfsb", "companions", "README.md"), "# Test Readme\n", "utf8");

    const result1 = await bundleProject({
      root: tempDir,
      output: "out1.zip",
      generator: { name: "test-gen", version: "1.0.0" },
    });
    const bytes1 = readFileSync(join(tempDir, "out1.zip"));

    const result2 = await bundleProject({
      root: tempDir,
      output: "out2.zip",
      generator: { name: "test-gen", version: "1.0.0" },
    });
    const bytes2 = readFileSync(join(tempDir, "out2.zip"));

    expect(bytes1).toEqual(bytes2);
    expect(result1.totalBytes).toBe(result2.totalBytes);
  });

  it("verifies exact store-only canonical ZIP headers and attributes", async () => {
    setupCanonicalProject(tempDir);
    const assetToml = `schema_version = 1
id = "favicon"
filename = "favicon.svg"

[canvas]
width = 32
height = 32
view_box = "0 0 32 32"

[accessibility]
title = "Favicon"
title_id = "fav-title"
description = "Favicon."
description_id = "fav-desc"

[[elements]]
type = "path"
d = "M 0 0 H 32 V 32 H 0 Z"
`;
    writeFileSync(join(tempDir, ".tfsb", "assets", "favicon.toml"), assetToml, "utf8");
    writeFileSync(join(tempDir, ".tfsb", "companions", "README.md"), "# Hello\n", "utf8");

    await bundleProject({
      root: tempDir,
      output: "bundle.zip",
      generator: { name: "test", version: "1.0" },
    });

    const buf = readFileSync(join(tempDir, "bundle.zip"));

    // 1. Local Header for first entry
    expect(buf.readUInt32LE(0)).toBe(0x04034b50); // Signature
    expect(buf.readUInt16LE(4)).toBe(20); // Version needed (2.0)
    expect(buf.readUInt16LE(8)).toBe(0); // Method 0 (Stored)
    expect(buf.readUInt16LE(10)).toBe(0); // DOS time (00:00:00)
    expect(buf.readUInt16LE(12)).toBe(0x0021); // DOS date (1980-01-01)
    expect(buf.readUInt16LE(28)).toBe(0); // Extra field length = 0

    // Find EOCD
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    expect(eocd).toBeGreaterThan(0);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const cdEntries = buf.readUInt16LE(eocd + 10);
    expect(cdEntries).toBe(3); // README.md, favicon.svg, tfsb-manifest.json

    // Inspect Central Directory headers
    let offset = cdOffset;
    for (let i = 0; i < cdEntries; i++) {
      expect(buf.readUInt32LE(offset)).toBe(0x02014b50); // CD signature
      const madeBy = buf.readUInt16LE(offset + 4);
      expect(madeBy >>> 8).toBe(3); // Unix origin
      expect(buf.readUInt16LE(offset + 10)).toBe(0); // Method 0
      expect(buf.readUInt16LE(offset + 12)).toBe(0); // DOS time
      expect(buf.readUInt16LE(offset + 14)).toBe(0x0021); // DOS date 1980-01-01
      expect(buf.readUInt16LE(offset + 30)).toBe(0); // Extra field len = 0
      expect(buf.readUInt16LE(offset + 32)).toBe(0); // Comment len = 0

      const externalAttrs = buf.readUInt32LE(offset + 38);
      // Unix mode 0100644 (0x81a4) in upper 16, DOS archive bit (0x20) in lower 16
      expect(externalAttrs).toBe(0x81a40020);

      const nameLen = buf.readUInt16LE(offset + 28);
      const extraLen = buf.readUInt16LE(offset + 30);
      const commentLen = buf.readUInt16LE(offset + 32);
      offset += 46 + nameLen + extraLen + commentLen;
    }
  });

  it("produces identical ZIP bytes across different timezones in child processes", () => {
    setupCanonicalProject(tempDir);
    const assetToml = `schema_version = 1
id = "icon"
filename = "icon.svg"

[canvas]
width = 10
height = 10
view_box = "0 0 10 10"

[accessibility]
title = "Icon"
title_id = "icon-title"
description = "Icon."
description_id = "icon-desc"

[[elements]]
type = "path"
d = "M 0 0 H 10 V 10 H 0 Z"
`;
    writeFileSync(join(tempDir, ".tfsb", "assets", "icon.toml"), assetToml, "utf8");

    const script = `
      import { bundleProject } from "${repoPath("dist/index.js")}";
      await bundleProject({
        root: "${tempDir}",
        output: process.argv[1],
        generator: { name: "test-gen", version: "1.0.0" }
      });
    `;

    execFileSync("node", ["--input-type=module", "-e", script, "utc.zip"], {
      cwd: tempDir,
      env: { ...process.env, TZ: "UTC" },
    });

    execFileSync("node", ["--input-type=module", "-e", script, "ny.zip"], {
      cwd: tempDir,
      env: { ...process.env, TZ: "America/New_York" },
    });

    execFileSync("node", ["--input-type=module", "-e", script, "tokyo.zip"], {
      cwd: tempDir,
      env: { ...process.env, TZ: "Asia/Tokyo" },
    });

    const utcBytes = readFileSync(join(tempDir, "utc.zip"));
    const nyBytes = readFileSync(join(tempDir, "ny.zip"));
    const tokyoBytes = readFileSync(join(tempDir, "tokyo.zip"));

    expect(utcBytes).toEqual(nyBytes);
    expect(utcBytes).toEqual(tokyoBytes);
  });
});

describe("bundle selection semantics", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("tfsb-bundle-select-");
    setupCanonicalProject(tempDir);
    const makeAsset = (id: string) => `schema_version = 1
id = "${id}"
filename = "${id}.svg"
[canvas]
width = 10
height = 10
view_box = "0 0 10 10"
[accessibility]
title = "${id}"
title_id = "${id}-t"
description = "${id}"
description_id = "${id}-d"
[[elements]]
type = "path"
d = "M 0 0 H 10 V 10 H 0 Z"
`;
    writeFileSync(join(tempDir, ".tfsb", "assets", "asset-a.toml"), makeAsset("asset-a"), "utf8");
    writeFileSync(join(tempDir, ".tfsb", "assets", "asset-b.toml"), makeAsset("asset-b"), "utf8");
    writeFileSync(join(tempDir, ".tfsb", "companions", "README.md"), "readme", "utf8");
    writeFileSync(join(tempDir, ".tfsb", "companions", "LICENSE.txt"), "license", "utf8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("bundles all canonical assets and companions by default", async () => {
    const plan = await planBundle({
      root: tempDir,
      output: "all.zip",
    });
    expect(plan.assetCount).toBe(2);
    expect(plan.companionCount).toBe(2);
    expect(plan.entries.map((e) => e.name)).toEqual([
      "LICENSE.txt",
      "README.md",
      "asset-a.svg",
      "asset-b.svg",
      "tfsb-manifest.json",
    ]);
  });

  it("selects subset with --asset and contributes zero unmentioned companions", async () => {
    const plan = await planBundle({
      root: tempDir,
      output: "subset.zip",
      assets: ["asset-a"],
    });
    expect(plan.assetCount).toBe(1);
    expect(plan.companionCount).toBe(0);
    expect(plan.entries.map((e) => e.name)).toEqual(["asset-a.svg", "tfsb-manifest.json"]);
  });

  it("selects subset with --companion and contributes zero unmentioned assets", async () => {
    const plan = await planBundle({
      root: tempDir,
      output: "comp.zip",
      companions: ["LICENSE.txt"],
    });
    expect(plan.assetCount).toBe(0);
    expect(plan.companionCount).toBe(1);
    expect(plan.entries.map((e) => e.name)).toEqual(["LICENSE.txt", "tfsb-manifest.json"]);
  });

  it("rejects unknown asset or companion selectors", async () => {
    await expect(
      planBundle({ root: tempDir, output: "out.zip", assets: ["nonexistent"] }),
    ).rejects.toThrow(/does not exist in canonical project/);

    await expect(
      planBundle({ root: tempDir, output: "out.zip", companions: ["nonexistent.txt"] }),
    ).rejects.toThrow(/does not exist in canonical project/);
  });

  it("rejects duplicate selectors", async () => {
    await expect(
      planBundle({ root: tempDir, output: "out.zip", assets: ["asset-a", "asset-a"] }),
    ).rejects.toThrow(/Duplicate asset selector/);

    await expect(
      planBundle({ root: tempDir, output: "out.zip", companions: ["README.md", "README.md"] }),
    ).rejects.toThrow(/Duplicate companion selector/);
  });

  it("rejects empty explicit selection", async () => {
    await expect(
      planBundle({ root: tempDir, output: "out.zip", assets: [], companions: [] }),
    ).rejects.toThrow(/Explicit bundle selection matched zero/);
  });
});
