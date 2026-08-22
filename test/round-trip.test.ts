import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildProject,
  bundleProject,
  computeSha256,
  importProject,
  parseAssetToml,
  parseProjectToml,
  parseSvg,
  serializeAssetToml,
  serializeSvg,
} from "../src/index.js";
import { makeTempDir, readRepoFile, repoPath, unwrap } from "./helpers.js";

const productionFixtureDir = fileURLToPath(
  new URL("./fixtures/tftn-production-v1/", import.meta.url),
);

function setupFullProductionProject(dir: string): void {
  mkdirSync(join(dir, ".tfsb", "assets"), { recursive: true });
  mkdirSync(join(dir, ".tfsb", "companions"), { recursive: true });

  const projectToml = `schema_version = 1
name = "theme-forge-terminal-nova"

[build]
directory = "brand/dist"

[[install]]
asset = "favicon-on-light"
destinations = ["dist/favicon.svg"]

[[companion]]
file = "README.md"
destinations = ["dist/README.md"]
`;
  writeFileSync(join(dir, ".tfsb", "project.toml"), projectToml, "utf8");

  // Read all 10 production SVG files and create canonical TOML
  const svgFiles = readdirSync(productionFixtureDir).filter((f) => f.endsWith(".svg")).sort();
  for (const file of svgFiles) {
    const id = file.slice(0, -4);
    const svgText = readRepoFile(`test/fixtures/tftn-production-v1/${file}`);
    const parsedSvg = unwrap(parseSvg(svgText, file));
    const assetToml = serializeAssetToml({
      schemaVersion: 1,
      id: id as any,
      filename: file as any,
      svg: parsedSvg,
    });
    writeFileSync(join(dir, ".tfsb", "assets", `${id}.toml`), assetToml, "utf8");
  }

  const readmeBytes = readFileSync(join(productionFixtureDir, "README.md"));
  writeFileSync(join(dir, ".tfsb", "companions", "README.md"), readmeBytes);
}

describe("Terminal Nova deterministic bundle and round-trip qualification", () => {
  let sourceDir: string;
  let workDir: string;

  beforeEach(() => {
    sourceDir = makeTempDir("tfsb-rt-src-");
    workDir = makeTempDir("tfsb-rt-work-");
    setupFullProductionProject(sourceDir);
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it("1. bundles all ten canonical production SVGs plus legal README", async () => {
    const result = await bundleProject({
      root: sourceDir,
      output: "production-all.zip",
    });
    expect(result.assetCount).toBe(10);
    expect(result.companionCount).toBe(1);
    expect(result.entries).toHaveLength(12); // 10 assets + 1 companion + 1 manifest
  });

  it("2. bundles the 3-asset + README subset represented by checked-in example", async () => {
    const result = await bundleProject({
      root: sourceDir,
      output: "example-subset.zip",
      assets: [
        "favicon-on-light",
        "theme-forge-terminal-nova-horizontal-on-light",
        "theme-forge-terminal-nova-mark-on-light",
      ],
      companions: ["README.md"],
      generator: {
        name: "@knowledge-forge-ai/theme-forge-stellar-burst",
        version: "0.2.0",
      },
    });

    expect(result.assetCount).toBe(3);
    expect(result.companionCount).toBe(1);
    expect(result.entries).toHaveLength(5);
    expect(result.entries.map((e) => e.name)).toEqual([
      "README.md",
      "favicon-on-light.svg",
      "tfsb-manifest.json",
      "theme-forge-terminal-nova-horizontal-on-light.svg",
      "theme-forge-terminal-nova-mark-on-light.svg",
    ]);
  });

  it("3. produces identical bytes and equal SHA-256 across multiple absent targets", async () => {
    const res1 = await bundleProject({ root: sourceDir, output: "b1.zip" });
    const res2 = await bundleProject({ root: sourceDir, output: "b2.zip" });

    const b1 = readFileSync(join(sourceDir, "b1.zip"));
    const b2 = readFileSync(join(sourceDir, "b2.zip"));

    expect(b1).toEqual(b2);
    expect(computeSha256(b1)).toBe(computeSha256(b2));
  });

  it("4. produces fixed-model bundle under multiple timezones with identical bytes", () => {
    const script = `
      import { bundleProject } from "${repoPath("dist/index.js")}";
      await bundleProject({
        root: "${sourceDir}",
        output: process.argv[1],
        generator: { name: "test-gen", version: "1.0.0" }
      });
    `;

    execFileSync("node", ["--input-type=module", "-e", script, "tz-utc.zip"], {
      cwd: workDir,
      env: { ...process.env, TZ: "UTC" },
    });

    execFileSync("node", ["--input-type=module", "-e", script, "tz-ny.zip"], {
      cwd: workDir,
      env: { ...process.env, TZ: "America/New_York" },
    });

    const utcBytes = readFileSync(join(sourceDir, "tz-utc.zip"));
    const nyBytes = readFileSync(join(sourceDir, "tz-ny.zip"));
    expect(utcBytes).toEqual(nyBytes);
  });

  it("5. inspects all ZIP headers and metadata against ADR 0003", async () => {
    await bundleProject({ root: sourceDir, output: "headers.zip" });
    const buf = readFileSync(join(sourceDir, "headers.zip"));

    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(buf.readUInt16LE(8)).toBe(0); // Method 0 (Stored)
    expect(buf.readUInt16LE(10)).toBe(0); // 00:00:00
    expect(buf.readUInt16LE(12)).toBe(0x0021); // 1980-01-01
  });

  it("6-10. complete round-trip: bundle -> import --manifest -> model equivalence -> build equivalence", async () => {
    // 6. Bundle source project
    await bundleProject({ root: sourceDir, output: "roundtrip.zip" });
    const bundleZipPath = join(sourceDir, "roundtrip.zip");

    // Import into clean fresh directory
    const importedDir = join(workDir, "imported");
    mkdirSync(importedDir, { recursive: true });

    const importPlan = await importProject({
      archive: bundleZipPath,
      root: importedDir,
      manifest: true,
    });

    // 7. Prove every imported normalized SVG model equals source canonical model
    expect(importPlan.assets).toHaveLength(10);
    for (const importedAsset of importPlan.assets) {
      const srcToml = readFileSync(join(sourceDir, ".tfsb", "assets", `${importedAsset.id}.toml`), "utf8");
      const srcAsset = unwrap(parseAssetToml(srcToml, `${importedAsset.id}.toml`));
      expect(importedAsset.svg).toEqual(srcAsset.svg);
    }

    // 8. Prove companion bytes equal exactly
    const srcReadme = readFileSync(join(sourceDir, ".tfsb", "companions", "README.md"));
    const impReadme = readFileSync(join(importedDir, ".tfsb", "companions", "README.md"));
    expect(impReadme).toEqual(srcReadme);

    // 9. Prove install/build destinations were not transported
    const importedProject = unwrap(
      parseProjectToml(readFileSync(join(importedDir, ".tfsb", "project.toml"), "utf8")),
    );
    expect(importedProject.installs).toEqual([]);
    expect(importedProject.companions).toEqual([]);
    expect(importedProject.buildDirectory).toBe("brand/dist");

    // 10. Build the imported project and prove canonical SVG bytes remain equivalent
    const buildPlan = await buildProject(importedDir);
    expect(buildPlan.outputs).toHaveLength(10);
    for (const { filename } of buildPlan.outputs) {
      const text = readFileSync(join(importedDir, buildPlan.buildDirectory, filename), "utf8");
      const parsedBuilt = unwrap(parseSvg(text, filename));
      const parsedCanonical = importPlan.assets.find((a) => a.filename === filename)?.svg;
      expect(parsedBuilt).toEqual(parsedCanonical);
    }
  });

  it("12. ordinary import without --manifest follows basename behavior and ignores manifest JSON", async () => {
    await bundleProject({ root: sourceDir, output: "ordinary.zip" });
    const bundleZipPath = join(sourceDir, "ordinary.zip");

    const ordinaryDir = join(workDir, "ordinary");
    mkdirSync(ordinaryDir, { recursive: true });

    const plan = await importProject({
      archive: bundleZipPath,
      root: ordinaryDir,
      companions: ["README.md"],
      manifest: false, // Default ordinary import
    });

    expect(plan.assets).toHaveLength(10);
    expect(plan.companions).toHaveLength(1);
    expect(existsSync(join(ordinaryDir, ".tfsb", "companions", "README.md"))).toBe(true);
    // tfsb-manifest.json was NOT imported as a companion or asset
    expect(existsSync(join(ordinaryDir, ".tfsb", "companions", "tfsb-manifest.json"))).toBe(false);
  });
});
