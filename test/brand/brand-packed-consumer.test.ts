import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readRepoFile } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0, roots.length)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("fresh packed consumer qualification", () => {
  it("packs and executes a clean consumer verifying public exports, list/check, and CLI surface", async () => {
    const consumerRoot = await mkdtemp(join(tmpdir(), "tfsb-packed-consumer-"));
    roots.push(consumerRoot);
    const packDestination = join(consumerRoot, "pack");
    await mkdir(packDestination, { recursive: true });

    const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", packDestination], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const [packResult] = JSON.parse(packOutput) as [{ filename: string }];
    const tarballFilename = packResult?.filename;
    const tarballPath = join(packDestination, tarballFilename!);

    const nodeModulesDir = join(consumerRoot, "node_modules", "@knowledge-forge-ai", "theme-forge-stellar-burst");
    await mkdir(nodeModulesDir, { recursive: true });
    execFileSync("tar", ["-xzf", tarballPath, "--strip-components=1", "-C", nodeModulesDir]);

    // Link dependencies into consumer node_modules so runtime resolution succeeds
    const rootNodeModules = join(process.cwd(), "node_modules");
    for (const dep of ["@xmldom", "fflate", "smol-toml"]) {
      const srcDep = join(rootNodeModules, dep);
      const dstDep = join(consumerRoot, "node_modules", dep);
      if (existsSync(srcDep) && !existsSync(dstDep)) {
        await symlink(srcDep, dstDep);
      }
    }

    const unbrandedDir = join(consumerRoot, "unbranded");
    await mkdir(join(unbrandedDir, ".tfsb", "assets"), { recursive: true });
    const projectToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/project.toml");
    const assetDark = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-dark.toml");
    const assetLight = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml");
    await writeFile(join(unbrandedDir, ".tfsb", "project.toml"), projectToml);
    await writeFile(join(unbrandedDir, ".tfsb", "assets", "fixture-mark-on-dark.toml"), assetDark);
    await writeFile(join(unbrandedDir, ".tfsb", "assets", "fixture-mark-on-light.toml"), assetLight);

    const cliBin = join(nodeModulesDir, "dist", "cli.js");
    const execEnv = { ...process.env, NODE_PATH: join(process.cwd(), "node_modules") };
    execFileSync(process.execPath, [cliBin, "build"], { cwd: unbrandedDir, env: execEnv });

    const brandedCoreDir = join(consumerRoot, "branded-core");
    await mkdir(join(brandedCoreDir, ".tfsb", "assets"), { recursive: true });
    await writeFile(join(brandedCoreDir, ".tfsb", "project.toml"), projectToml);
    await writeFile(join(brandedCoreDir, ".tfsb", "assets", "fixture-mark-on-dark.toml"), assetDark);
    await writeFile(join(brandedCoreDir, ".tfsb", "assets", "fixture-mark-on-light.toml"), assetLight);
    const coreBrandToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml").replace("package = true", "package = false");
    await writeFile(join(brandedCoreDir, ".tfsb", "brand.toml"), coreBrandToml);
    execFileSync(process.execPath, [cliBin, "build"], { cwd: brandedCoreDir, env: execEnv });

    const brandedPkgDir = join(consumerRoot, "branded-package");
    await mkdir(join(brandedPkgDir, ".tfsb", "assets"), { recursive: true });
    await writeFile(join(brandedPkgDir, ".tfsb", "project.toml"), projectToml);
    await writeFile(join(brandedPkgDir, ".tfsb", "assets", "fixture-mark-on-dark.toml"), assetDark);
    await writeFile(join(brandedPkgDir, ".tfsb", "assets", "fixture-mark-on-light.toml"), assetLight);
    const pkgBrandToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
    const pkgToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand-package.toml");
    const guidance = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/GUIDANCE.md");
    await writeFile(join(brandedPkgDir, ".tfsb", "brand.toml"), pkgBrandToml);
    await writeFile(join(brandedPkgDir, ".tfsb", "brand-package.toml"), pkgToml);
    await writeFile(join(brandedPkgDir, "GUIDANCE.md"), guidance);
    execFileSync(process.execPath, [cliBin, "build"], { cwd: brandedPkgDir, env: execEnv });

    const sampleToml = [
      "schema = \"tfsb.brand\"",
      "schema_version = 1",
      "enabled_domains = { tokens = false, recipes = false, qa = false, consumer_profiles = false, package = false, exports = false }",
      "[[families]]",
      "id = \"fam\"",
      "name = \"Fam\"",
      "required_roles = []",
      "optional_roles = [\"mark\"]",
      "[[variants]]",
      "family = \"fam\"",
      "id = \"std\"",
      "backgrounds = [\"any\"]",
      "color_mode = \"full-color\"",
      "scale = \"standard\"",
      "status = \"primary\"",
      "[[bindings]]",
      "family = \"fam\"",
      "role = \"mark\"",
      "variant = \"std\"",
      "asset = \"fixture-mark-on-dark\"",
      "authority = \"source\"",
      "",
    ].join("\n");

    const consumerCode = [
      "import assert from \"node:assert/strict\";",
      "import { join } from \"node:path\";",
      "import { mkdir } from \"node:fs/promises\";",
      "import {",
      "  BRAND_SCHEMA_ID,",
      "  BRAND_SCHEMA_VERSION,",
      "  BRAND_TOML_MAX_BYTES,",
      "  BRAND_MAX_FAMILIES,",
      "  BRAND_MAX_ROLES,",
      "  BRAND_MAX_VARIANTS,",
      "  BRAND_MAX_BINDINGS,",
      "  BRAND_MAX_BINDINGS_PER_ASSET,",
      "  BRAND_MAX_REQUIREMENTS,",
      "  BRAND_FILE_INVENTORY,",
      "  parseBrandToml,",
      "  serializeBrandToml,",
      "  computeBrandDigest,",
      "  computeBrandSystemDigest,",
      "  encodeCanonicalJson,",
      "  validateBrandSemantics,",
      "  checkProject,",
      "  listProject,",
      "} from \"@knowledge-forge-ai/theme-forge-stellar-burst\";",
      "",
      "assert.equal(BRAND_SCHEMA_ID, \"tfsb.brand\");",
      "assert.equal(BRAND_SCHEMA_VERSION, 1);",
      "assert.equal(BRAND_TOML_MAX_BYTES, 1048576);",
      "assert.equal(BRAND_MAX_FAMILIES, 32);",
      "assert.equal(BRAND_MAX_ROLES, 64);",
      "assert.equal(BRAND_MAX_VARIANTS, 256);",
      "assert.equal(BRAND_MAX_BINDINGS, 1024);",
      "assert.equal(BRAND_MAX_BINDINGS_PER_ASSET, 8);",
      "assert.equal(BRAND_MAX_REQUIREMENTS, 256);",
      "assert.equal(BRAND_FILE_INVENTORY.length, 7);",
      "",
      "const sampleToml = " + JSON.stringify(sampleToml) + ";",
      "const parseResult = parseBrandToml(sampleToml);",
      "assert.equal(parseResult.ok, true);",
      "const model = parseResult.value;",
      "const serialized = serializeBrandToml(model);",
      "assert.equal(typeof serialized, \"string\");",
      "assert.ok(serialized.endsWith(\"\\n\"));",
      "",
      "const digest = computeBrandDigest(model);",
      "assert.ok(digest.startsWith(\"sha256:\"));",
      "",
      "const json = encodeCanonicalJson(model);",
      "assert.equal(typeof json, \"string\");",
      "",
      "const unbrandedList = await listProject(" + JSON.stringify(unbrandedDir) + ");",
      "assert.equal(unbrandedList.brand, undefined);",
      "assert.equal(unbrandedList.assets.length, 2);",
      "",
      "const unbrandedCheck = await checkProject(" + JSON.stringify(unbrandedDir) + ");",
      "assert.equal(unbrandedCheck.brand, undefined);",
      "assert.equal(unbrandedCheck.drift, false);",
      "",
      "const coreList = await listProject(" + JSON.stringify(brandedCoreDir) + ");",
      "assert.ok(coreList.brand !== undefined);",
      "assert.equal(coreList.brand.schemaVersion, 1);",
      "assert.equal(coreList.brand.completeness.satisfied, true);",
      "assert.equal(coreList.brand.brandDigest, \"sha256:d69829ae3f45ef2d79f11b9a0b0097fbd61a9342aa5c53a607de762eccf21ee2\");",
      "assert.equal(coreList.brand.brandSystemDigest, \"sha256:0d399a54375f952fc75a31e1ca59c99df4699dd3b665b99e30998470203a5980\");",
      "",
      "const coreCheck = await checkProject(" + JSON.stringify(brandedCoreDir) + ");",
      "assert.ok(coreCheck.brand !== undefined);",
      "assert.equal(coreCheck.brand.valid, true);",
      "assert.equal(coreCheck.brand.completenessSatisfied, true);",
      "assert.equal(coreCheck.brand.brandDigest, \"sha256:d69829ae3f45ef2d79f11b9a0b0097fbd61a9342aa5c53a607de762eccf21ee2\");",
      "assert.equal(coreCheck.brand.brandSystemDigest, \"sha256:0d399a54375f952fc75a31e1ca59c99df4699dd3b665b99e30998470203a5980\");",
      "",
      "const pkgCheck = await checkProject(" + JSON.stringify(brandedPkgDir) + ");",
      "assert.ok(pkgCheck.brand !== undefined);",
      "assert.equal(pkgCheck.brand.valid, true);",
      "assert.equal(pkgCheck.brand.brandSystemDigest, \"sha256:4e10ef25161f37bdd137bcf85fcf1b842b4e0a6512f863d7f2fbba0d8a7e9c4d\");",
      "const pkgDomain = pkgCheck.brand.domains.find((d) => d.domain === \"package\");",
      "assert.ok(pkgDomain !== undefined);",
      "assert.equal(pkgDomain.state, \"available\");",
      "const allExports = await import(\"@knowledge-forge-ai/theme-forge-stellar-burst\");",
      "assert.equal(\"discoverBrandState\" in allExports, false, \"discoverBrandState must not be exported\");",
      "assert.equal(\"loadBrandProject\" in allExports, false, \"loadBrandProject must not be exported\");",
      "assert.equal(\"BrandDiscoveryResult\" in allExports, false, \"BrandDiscoveryResult must not be exported\");",
      "assert.equal(\"LoadedBrandProject\" in allExports, false, \"LoadedBrandProject must not be exported\");",
      "",
      "// Verify bundle and import APIs work cleanly in packed consumer",
      "const { bundleBrandProject, importBrandProject } = allExports;",
      "const bundleResult = await bundleBrandProject({ root: " + JSON.stringify(brandedPkgDir) + ", output: \"consumer-bundle.zip\" });",
      "assert.ok(bundleResult.projectRelativeOutputPath);",
      "assert.ok(bundleResult.brandManifestDigest.startsWith(\"sha256:\"));",
      "assert.equal(bundleResult.written, true);",
      "",
      "const importedDir = " + JSON.stringify(join(consumerRoot, "imported-brand")) + ";",
      "await mkdir(importedDir, { recursive: true });",
      "const importPlan = await importBrandProject({ archive: join(" + JSON.stringify(brandedPkgDir) + ", \"consumer-bundle.zip\"), root: importedDir });",
      "assert.ok(importPlan.root);",
      "assert.ok(importPlan.archiveDigest.startsWith(\"sha256:\"));",
      "assert.equal(Array.isArray(importPlan.files), true);",
      "assert.equal(Array.isArray(importPlan.companions), true);",
      "",
      "const importedCheck = await checkProject(importedDir);",
      "assert.ok(importedCheck.brand !== undefined);",
      "assert.equal(importedCheck.brand.valid, true);",
      "assert.equal(importedCheck.brand.brandSystemDigest, \"sha256:4e10ef25161f37bdd137bcf85fcf1b842b4e0a6512f863d7f2fbba0d8a7e9c4d\");",
      "",
      "console.log(\"PACKED_CONSUMER_OK\");",
    ].join("\n");

    await writeFile(join(consumerRoot, "consumer.mjs"), consumerCode);
    await writeFile(join(consumerRoot, "package.json"), JSON.stringify({ type: "module" }));

    const consumerOutput = execFileSync(process.execPath, [join(consumerRoot, "consumer.mjs")], {
      cwd: consumerRoot,
      encoding: "utf8",
      env: execEnv,
    });
    expect(consumerOutput).toContain("PACKED_CONSUMER_OK");

    const cliHelp = execFileSync(process.execPath, [cliBin, "--help"], {
      encoding: "utf8",
      env: execEnv,
    });
    expect(cliHelp).not.toContain("tfsb brand-bundle");
    expect(cliHelp).not.toContain("tfsb brand-import");
    expect(cliHelp).not.toContain("tfsb brand-package");
  }, 30000);
});
