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

describe("fresh packed consumer qualification for derive/tokens/recipes", () => {
  it("packs and executes a clean consumer verifying public exports, CLI derive, and ownership validation", async () => {
    const consumerRoot = await mkdtemp(join(tmpdir(), "tfsb-derive-packed-"));
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

    const projectDir = join(consumerRoot, "branded-project");
    await mkdir(join(projectDir, ".tfsb", "assets"), { recursive: true });

    const projectToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/project.toml");
    const assetLight = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml");

    await writeFile(join(projectDir, ".tfsb", "project.toml"), projectToml);
    await writeFile(join(projectDir, ".tfsb", "assets", "fixture-mark-on-light.toml"), assetLight);

    const brandToml = `schema = "tfsb.brand"
schema_version = 1
enabled_domains = { tokens = true, recipes = true, qa = false, consumer_profiles = false, package = false, exports = false }

[[families]]
id = "fixture-fam"
name = "Fixture Family"
required_roles = []
optional_roles = ["mark"]

[[variants]]
family = "fixture-fam"
id = "light"
backgrounds = ["light"]
color_mode = "full-color"
scale = "standard"
status = "primary"

[[variants]]
family = "fixture-fam"
id = "derived-dark"
backgrounds = ["dark"]
color_mode = "reversed"
scale = "standard"
status = "primary"

[[bindings]]
family = "fixture-fam"
role = "mark"
variant = "light"
asset = "fixture-mark-on-light"
authority = "source"

[[bindings]]
family = "fixture-fam"
role = "mark"
variant = "derived-dark"
asset = "fixture-mark-derived-dark"
authority = "derived"
`;

    const tokensToml = `schema = "tfsb.brand-tokens"
schema_version = 1

[[colors]]
id = "brand-blue"
value = "#0066CCFF"
`;

    const recipesToml = `schema = "tfsb.brand-recipes"
schema_version = 1

[[recipes]]
id = "recipe-derived-dark"
target_asset = "fixture-mark-derived-dark"
source_asset = "fixture-mark-on-light"

[[recipes.operations]]
operation = "replace-paint"
channel = "fill"
source_color = "#000000FF"
replacement_token = "brand-blue"
expected_occurrences = 1

[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"
`;

    await writeFile(join(projectDir, ".tfsb", "brand.toml"), brandToml);
    await writeFile(join(projectDir, ".tfsb", "brand-tokens.toml"), tokensToml);
    await writeFile(join(projectDir, ".tfsb", "brand-recipes.toml"), recipesToml);

    const cliBin = join(nodeModulesDir, "dist", "cli.js");
    const execEnv = { ...process.env, NODE_PATH: join(process.cwd(), "node_modules") };

    // 1. Run CLI derive in consumer project
    const deriveOutput = execFileSync(process.execPath, [cliBin, "derive", "--all"], {
      cwd: projectDir,
      encoding: "utf8",
      env: execEnv,
    });
    expect(deriveOutput).toContain("Brand derived: 1 created, 0 updated, 0 unchanged");

    // 2. Run CLI build in consumer project
    const buildOutput = execFileSync(process.execPath, [cliBin, "build"], {
      cwd: projectDir,
      encoding: "utf8",
      env: execEnv,
    });
    expect(buildOutput).toContain("Built: 2 SVG(s)");

    const installOutput = execFileSync(process.execPath, [cliBin, "install"], {
      cwd: projectDir,
      encoding: "utf8",
      env: execEnv,
    });
    expect(installOutput).toContain("Installed: 0 destination(s)");

    // 3. Test programmatic consumer module
    const consumerCode = [
      "import assert from \"node:assert/strict\";",
      "import { mkdtemp, readFile, rm, writeFile } from \"node:fs/promises\";",
      "import { tmpdir } from \"node:os\";",
      "import { join } from \"node:path\";",
      "import {",
      "  BRAND_TOKENS_SCHEMA_ID,",
      "  BRAND_TOKENS_SCHEMA_VERSION,",
      "  BRAND_RECIPES_SCHEMA_ID,",
      "  BRAND_RECIPES_SCHEMA_VERSION,",
      "  DERIVED_RECEIPT_SCHEMA_ID,",
      "  DERIVED_RECEIPT_SCHEMA_VERSION,",
      "  parseBrandTokensToml,",
      "  serializeBrandTokensToml,",
      "  computeBrandTokensDigest,",
      "  parseBrandRecipesToml,",
      "  serializeBrandRecipesToml,",
      "  computeBrandRecipesDigest,",
      "  createBrandDerivedReceipt,",
      "  parseBrandDerivedReceipt,",
      "  deriveBrandProject,",
      "  planBrandDerivation,",
      "  checkProject,",
      "  listProject,",
      "  loadCanonicalProject,",
      "  computeAssetSemanticDigest,",
      "  computeSha256,",
      "  bundleBrandProject,",
      "  importBrandProject,",
      "  buildProject,",
      "  installProject,",
      "} from \"@knowledge-forge-ai/theme-forge-stellar-burst\";",
      "",
      "assert.equal(BRAND_TOKENS_SCHEMA_ID, \"tfsb.brand-tokens\");",
      "assert.equal(BRAND_TOKENS_SCHEMA_VERSION, 1);",
      "assert.equal(BRAND_RECIPES_SCHEMA_ID, \"tfsb.brand-recipes\");",
      "assert.equal(BRAND_RECIPES_SCHEMA_VERSION, 1);",
      "assert.equal(DERIVED_RECEIPT_SCHEMA_ID, \"tfsb.derived-receipt\");",
      "assert.equal(DERIVED_RECEIPT_SCHEMA_VERSION, 1);",
      "",
      "const projectDir = " + JSON.stringify(projectDir) + ";",
      "const listRes = await listProject(projectDir);",
      "assert.equal(listRes.assets.length, 2);",
      "const derived = listRes.assets.find((a) => a.id === \"fixture-mark-derived-dark\");",
      "assert.equal(derived.authority, \"derived\");",
      "assert.equal(derived.recipeId, \"recipe-derived-dark\");",
      "",
      "const checkRes = await checkProject(projectDir);",
      "assert.equal(checkRes.valid, true);",
      "assert.ok(checkRes.brand.tokensDigest);",
      "assert.ok(checkRes.brand.recipesDigest);",
      "assert.equal(checkRes.brand.derived.total, 1);",
      "assert.equal(checkRes.brand.derived.unchanged, 1);",
      "",
      "const brandPath = join(projectDir, \".tfsb\", \"brand.toml\");",
      "await writeFile(brandPath, (await readFile(brandPath, \"utf8\")).replace(\"package = false\", \"package = true\"));",
      "const packagePath = join(projectDir, \".tfsb\", \"brand-package.toml\");",
      "const zero = \"sha256:\" + \"0\".repeat(64);",
      "await writeFile(packagePath, `schema = \"tfsb.brand-package\"\nschema_version = 1\npackage_id = \"fixture-brand-pkg\"\nname = \"Fixture Brand Package\"\nbrand_version = \"1.0.0\"\nfamilies = [\"fixture-fam\"]\ncompatible_profiles = []\nbrand_system_digest = \"${zero}\"\n\n[[inventory]]\nfamily = \"fixture-fam\"\nrole = \"mark\"\nvariant = \"light\"\nasset = \"fixture-mark-on-light\"\ncanonical_asset_digest = \"${zero}\"\nsvg_digest = \"${zero}\"\n`);",
      "const digestCheck = await checkProject(projectDir);",
      "const loaded = await loadCanonicalProject(projectDir, \"check\");",
      "const inventory = [{ variant: \"light\", id: \"fixture-mark-on-light\" }, { variant: \"derived-dark\", id: \"fixture-mark-derived-dark\" }].map(({ variant, id }) => { const asset = loaded.assets.find((item) => item.id === id); return { variant, id, model: computeAssetSemanticDigest(asset), svg: computeSha256(loaded.outputs.get(asset.filename)) }; });",
      "await writeFile(packagePath, `schema = \"tfsb.brand-package\"\nschema_version = 1\npackage_id = \"fixture-brand-pkg\"\nname = \"Fixture Brand Package\"\nbrand_version = \"1.0.0\"\nfamilies = [\"fixture-fam\"]\ncompatible_profiles = []\nbrand_system_digest = \"${digestCheck.brand.brandSystemDigest}\"\n${inventory.map((item) => `\n[[inventory]]\nfamily = \"fixture-fam\"\nrole = \"mark\"\nvariant = \"${item.variant}\"\nasset = \"${item.id}\"\ncanonical_asset_digest = \"${item.model}\"\nsvg_digest = \"${item.svg}\"\n`).join(\"\")}`);",
      "const firstBundle = await bundleBrandProject({ root: projectDir, output: \"derived-bundle.zip\" });",
      "assert.equal(firstBundle.written, true);",
      "const importedRoot = await mkdtemp(join(tmpdir(), \"tfsb-packed-import-\"));",
      "await importBrandProject({ archive: join(projectDir, \"derived-bundle.zip\"), root: importedRoot });",
      "const importedCheck = await checkProject(importedRoot);",
      "assert.equal(importedCheck.brand.derived.unchanged, 1);",
      "await buildProject(importedRoot);",
      "await installProject(importedRoot);",
      "assert.equal((await listProject(importedRoot)).assets.find((item) => item.id === \"fixture-mark-derived-dark\").derivedState, \"unchanged\");",
      "await bundleBrandProject({ root: importedRoot, output: \"rebundle.zip\" });",
      "assert.deepEqual(await readFile(join(importedRoot, \"rebundle.zip\")), await readFile(join(projectDir, \"derived-bundle.zip\")));",
      "await rm(importedRoot, { recursive: true, force: true });",
      "",
      "console.log(\"DERIVE_PACKED_CONSUMER_OK\");",
    ].join("\n");

    await writeFile(join(consumerRoot, "consumer.mjs"), consumerCode);
    await writeFile(join(consumerRoot, "package.json"), JSON.stringify({ type: "module" }));

    const consumerOutput = execFileSync(process.execPath, [join(consumerRoot, "consumer.mjs")], {
      cwd: consumerRoot,
      encoding: "utf8",
      env: execEnv,
    });
    expect(consumerOutput).toContain("DERIVE_PACKED_CONSUMER_OK");
  }, 30000);
});
