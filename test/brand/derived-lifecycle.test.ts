import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkProject,
  diffProject,
  listProject,
} from "../../src/index.js";
import { runCli } from "../../src/cli.js";
import { readRepoFile } from "../helpers.js";

function capture() {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: (s: string) => { out += s; },
      stderr: (s: string) => { err += s; },
    },
    stdout: () => out,
    stderr: () => err,
  };
}

async function setupProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-lifecycle-"));
  await mkdir(join(root, ".tfsb", "assets"), { recursive: true });

  const projectToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/project.toml");
  const assetLight = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml");

  await writeFile(join(root, ".tfsb", "project.toml"), projectToml);
  await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-light.toml"), assetLight);

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

[[colors]]
id = "unused-color"
value = "#FF0000FF"
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

  await writeFile(join(root, ".tfsb", "brand.toml"), brandToml);
  await writeFile(join(root, ".tfsb", "brand-tokens.toml"), tokensToml);
  await writeFile(join(root, ".tfsb", "brand-recipes.toml"), recipesToml);

  return root;
}

describe("Brand Derived Lifecycle CLI & Build Integration", () => {
  it("executes dry-run without writing, then executes real derivation with JSON output", async () => {
    const root = await setupProject();

    // 1. Dry run CLI
    const dryCli = capture();
    expect(await runCli(["derive", "--all", "--dry-run"], root, dryCli.io)).toBe(0);
    expect(dryCli.stdout()).toContain("Brand derivation dry-run: 1 created, 0 updated, 0 unchanged");

    // Target asset should not exist yet
    expect(existsSync(join(root, ".tfsb", "assets", "fixture-mark-derived-dark.toml"))).toBe(false);

    // 2. Real derivation JSON CLI
    const realCli = capture();
    expect(await runCli(["derive", "--all", "--json"], root, realCli.io)).toBe(0);
    const parsed = JSON.parse(realCli.stdout());
    expect(parsed.status).toBe("ok");
    expect(parsed.data.written).toBe(true);
    expect(parsed.data.createdCount).toBe(1);
    expect(parsed.data.targets[0].targetAssetId).toBe("fixture-mark-derived-dark");

    // 3. Check list reflects derived authority
    const listResult = await listProject(root);
    const derivedAsset = listResult.assets.find((a) => a.id === "fixture-mark-derived-dark");
    expect(derivedAsset).toBeDefined();
    expect(derivedAsset?.authority).toBe("derived");
    expect(derivedAsset?.recipeId).toBe("recipe-derived-dark");

    // 4. Check project reflects derived statistics and unused tokens warning
    const checkResult = await checkProject(root);
    expect(checkResult.brand?.derived).toBeDefined();
    expect(checkResult.brand?.derived?.total).toBe(1);
    expect(checkResult.brand?.derived?.unchanged).toBe(1);
    expect(checkResult.brand?.tokenWarnings).toHaveLength(1);

    // 5. Build succeeds
    const buildCli = capture();
    const buildExit = await runCli(["build"], root, buildCli.io);
    if (buildExit !== 0) {
      console.log("BUILD FAILED:", buildCli.stderr(), buildCli.stdout());
    }
    expect(buildExit).toBe(0);

    await rm(root, { recursive: true, force: true });
  });

  it("fails build when derived target is missing or stale", async () => {
    const root = await setupProject();

    // Before derive, build must fail closed on missing derived target
    const preBuildCli = capture();
    expect(await runCli(["build"], root, preBuildCli.io)).toBe(1);
    expect(preBuildCli.stderr()).toContain("DERIVED_TARGET_MISSING");
    const missingCheck = await checkProject(root);
    expect(missingCheck.brand?.derived).toMatchObject({ total: 1, missing: 1, unchanged: 0 });

    // Run derive
    await runCli(["derive", "--all"], root, capture().io);

    // Modify source asset -> derived target becomes stale
    const sourceTomlPath = join(root, ".tfsb", "assets", "fixture-mark-on-light.toml");
    const sourceContent = (await readFile(sourceTomlPath, "utf8")).replace("Core Fixture Mark on Light", "Updated Fixture Mark");
    await writeFile(sourceTomlPath, sourceContent);

    // Build must fail closed on stale authority
    const staleBuildCli = capture();
    expect(await runCli(["build"], root, staleBuildCli.io)).toBe(1);
    expect(staleBuildCli.stderr()).toContain("DERIVED_ASSET_STALE");

    await rm(root, { recursive: true, force: true });
  });

  it("supports selective recipe derivation via --recipe <id>", async () => {
    const root = await setupProject();

    const cli = capture();
    expect(await runCli(["derive", "--recipe", "recipe-derived-dark"], root, cli.io)).toBe(0);
    expect(cli.stdout()).toContain("Brand derived: 1 created, 0 updated, 0 unchanged");

    await rm(root, { recursive: true, force: true });
  });

  it("rejects the unauthorized derive --force option as usage error", async () => {
    const root = await setupProject();
    const cli = capture();
    expect(await runCli(["derive", "--all", "--force"], root, cli.io)).toBe(1);
    expect(cli.stderr()).toContain("USAGE_ERROR: Invalid command arguments.");
    await rm(root, { recursive: true, force: true });
  });

  it("keeps token, recipe, and receipt files visible to generic build-baseline diff", async () => {
    const root = await setupProject();
    await runCli(["derive", "--all"], root, capture().io);
    await runCli(["build"], root, capture().io);
    const tokenPath = join(root, ".tfsb", "brand-tokens.toml");
    const recipePath = join(root, ".tfsb", "brand-recipes.toml");
    const receiptPath = join(root, ".tfsb", "derived", "fixture-mark-derived-dark.receipt.json");
    await writeFile(tokenPath, (await readFile(tokenPath, "utf8")).replace("#0066CCFF", "#0066CDFF"));
    await writeFile(recipePath, (await readFile(recipePath, "utf8")).replace('source_asset = "fixture-mark-on-light"', 'source_asset = "fixture-mark-on-light"\nrationale = "diff evidence"'));
    await writeFile(receiptPath, (await readFile(receiptPath, "utf8")) + " ");
    const diff = await diffProject({ root, baseline: "build" });
    if (diff.baseline !== "build") throw new Error("Expected build diff baseline.");
    expect(diff.canonicalSources.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      ".tfsb/brand-tokens.toml",
      ".tfsb/brand-recipes.toml",
      ".tfsb/derived/fixture-mark-derived-dark.receipt.json",
    ]));
    await rm(root, { recursive: true, force: true });
  });
});
