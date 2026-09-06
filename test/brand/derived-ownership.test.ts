import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkProject,
  deriveBrandProject,
  disposeBrandDerivationPlan,
  executeBrandDerivationPlan,
  computeDerivedReceiptDigest,
  computeSha256,
  encodeCanonicalJson,
  BRAND_RECIPE_OPERATIONS_DIGEST_BASIS,
  applyRecipeOperations,
  parseAssetTomlV2,
  parseBrandRecipesToml,
  parseBrandTokensToml,
  serializeAssetTomlV2,
  planBrandDerivation,
} from "../../src/index.js";
import { readRepoFile } from "../helpers.js";

const DERIVE_FILE_LIMIT = 8 * 1024 * 1024;
const DERIVE_AGGREGATE_LIMIT = 32 * 1024 * 1024;

function assetWithExactBytes(base: string, assetId: string, exactBytes: number): string {
  const renamed = base
    .replace('id = "fixture-mark-on-light"', `id = "${assetId}"`)
    .replace('filename = "fixture-mark-on-light.svg"', `filename = "${assetId}.svg"`);
  const empty = renamed.replace("\n\n[canvas]", '\nmetadata_text = ""\n\n[canvas]');
  const padding = exactBytes - Buffer.byteLength(empty, "utf8");
  if (padding < 0) throw new Error("Requested asset byte size is too small.");
  const result = renamed.replace("\n\n[canvas]", `\nmetadata_text = "${"x".repeat(padding)}"\n\n[canvas]`);
  if (Buffer.byteLength(result, "utf8") !== exactBytes) throw new Error("Failed to generate exact asset byte fixture.");
  return result;
}

async function setupProjectWithTokensAndRecipes(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-ownership-"));
  await mkdir(join(root, ".tfsb", "assets"), { recursive: true });

  const projectToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/project.toml");
  const assetDark = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-dark.toml");
  const assetLight = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml");

  await writeFile(join(root, ".tfsb", "project.toml"), projectToml);
  await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-dark.toml"), assetDark);
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
id = "brand-white"
value = "#FFFFFFFF"
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

describe("Brand Derived Ownership State Machine", () => {
  it("State 1 (create): derives and creates asset and receipt when target does not exist", async () => {
    const root = await setupProjectWithTokensAndRecipes();

    const plan = await planBrandDerivation({ root, all: true });
    expect(plan.createdCount).toBe(1);
    expect(plan.updatedCount).toBe(0);
    expect(plan.unchangedCount).toBe(0);
    expect(plan.targetStates[0]!.state).toBe("create");

    const result = await deriveBrandProject({ root, all: true });
    expect(result.written).toBe(true);
    expect(result.createdCount).toBe(1);

    const assetExists = await readFile(join(root, ".tfsb", "assets", "fixture-mark-derived-dark.toml"), "utf8");
    expect(assetExists).toContain("id = \"fixture-mark-derived-dark\"");

    const receiptExists = await readFile(join(root, ".tfsb", "derived", "fixture-mark-derived-dark.receipt.json"), "utf8");
    expect(receiptExists).toContain("\"targetAssetId\": \"fixture-mark-derived-dark\"");

    await rm(root, { recursive: true, force: true });
  });

  it("State 2 (unchanged): returns unchanged with zero writes when derived asset is up-to-date", async () => {
    const root = await setupProjectWithTokensAndRecipes();
    await deriveBrandProject({ root, all: true });

    const plan = await planBrandDerivation({ root, all: true });
    expect(plan.createdCount).toBe(0);
    expect(plan.updatedCount).toBe(0);
    expect(plan.unchangedCount).toBe(1);
    expect(plan.targetStates[0]!.state).toBe("unchanged");

    const result = await deriveBrandProject({ root, all: true });
    expect(result.written).toBe(false);
    expect(result.unchangedCount).toBe(1);

    await rm(root, { recursive: true, force: true });
  });

  it("State 3 (update): updates derived asset when token authority changes", async () => {
    const root = await setupProjectWithTokensAndRecipes();
    await deriveBrandProject({ root, all: true });

    // Modify token value
    const tokensToml = (await readFile(join(root, ".tfsb", "brand-tokens.toml"), "utf8")).replace("#0066CCFF", "#0088FFFF");
    await writeFile(join(root, ".tfsb", "brand-tokens.toml"), tokensToml);

    const plan = await planBrandDerivation({ root, all: true });
    expect(plan.createdCount).toBe(0);
    expect(plan.updatedCount).toBe(1);
    expect(plan.unchangedCount).toBe(0);
    expect(plan.targetStates[0]!.state).toBe("update");

    const result = await deriveBrandProject({ root, all: true });
    expect(result.written).toBe(true);
    expect(result.updatedCount).toBe(1);

    await rm(root, { recursive: true, force: true });
  });

  it("State 4 (DERIVED_ASSET_DRIFT): blocks derivation if target asset was modified on disk without receipt update", async () => {
    const root = await setupProjectWithTokensAndRecipes();
    await deriveBrandProject({ root, all: true });

    // Tamper with derived asset TOML on disk
    const targetToml = join(root, ".tfsb", "assets", "fixture-mark-derived-dark.toml");
    const content = (await readFile(targetToml, "utf8")).replace("title = \"Core Fixture Mark on Light\"", "title = \"Tampered Human Edit\"");
    await writeFile(targetToml, content);

    await expect(planBrandDerivation({ root, all: true })).rejects.toSatisfy((e: any) => e?.diagnostic?.code === "DERIVED_ASSET_DRIFT");

    await rm(root, { recursive: true, force: true });
  });

  it("State 5 (DERIVED_TARGET_OWNED_BY_HUMAN): protects human-authored assets from silent overwrite", async () => {
    const root = await setupProjectWithTokensAndRecipes();

    // Create target asset manually without receipt
    const targetToml = join(root, ".tfsb", "assets", "fixture-mark-derived-dark.toml");
    const assetLight = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml");
    await writeFile(targetToml, assetLight.replace("id = \"fixture-mark-on-light\"", "id = \"fixture-mark-derived-dark\""));

    // Derivation must fail closed and refuse to overwrite human file
    await expect(planBrandDerivation({ root, all: true })).rejects.toSatisfy((e: any) => e?.diagnostic?.code === "DERIVED_TARGET_OWNED_BY_HUMAN");

    await rm(root, { recursive: true, force: true });
  });

  it("State 6 (DERIVED_TARGET_MISSING): fails if receipt exists but target asset is missing", async () => {
    const root = await setupProjectWithTokensAndRecipes();
    await deriveBrandProject({ root, all: true });

    // Delete target asset TOML but leave receipt
    await rm(join(root, ".tfsb", "assets", "fixture-mark-derived-dark.toml"));

    await expect(planBrandDerivation({ root, all: true })).rejects.toSatisfy((e: any) => e?.diagnostic?.code === "DERIVED_TARGET_MISSING");

    await rm(root, { recursive: true, force: true });
  });

  it("State 7 (DERIVED_RECEIPT_INVALID): fails if receipt on disk is corrupted", async () => {
    const root = await setupProjectWithTokensAndRecipes();
    await deriveBrandProject({ root, all: true });

    // Corrupt receipt JSON
    await writeFile(join(root, ".tfsb", "derived", "fixture-mark-derived-dark.receipt.json"), "invalid json {[[");

    await expect(planBrandDerivation({ root, all: true })).rejects.toSatisfy((e: any) => e?.diagnostic?.code === "DERIVED_RECEIPT_INVALID");

    await rm(root, { recursive: true, force: true });
  });

  it("State 8 (DERIVED_OWNERSHIP_CONFLICT): rejects a source binding that claims a recipe target", async () => {
    const root = await setupProjectWithTokensAndRecipes();
    const brandPath = join(root, ".tfsb", "brand.toml");
    const brand = (await readFile(brandPath, "utf8")).replace(
      'asset = "fixture-mark-derived-dark"\nauthority = "derived"',
      'asset = "fixture-mark-derived-dark"\nauthority = "source"',
    );
    await writeFile(brandPath, brand);
    expect((await checkProject(root)).brand?.derived).toMatchObject({ total: 1, ownershipConflict: 1, unchanged: 0 });
    await expect(planBrandDerivation({ root, all: true })).rejects.toSatisfy((error: any) => error?.diagnostic?.code === "DERIVED_OWNERSHIP_CONFLICT");
    await rm(root, { recursive: true, force: true });
  });

  it("isolates execution from nested public plan mutation and rejects copied or forged plans", async () => {
    const root = await setupProjectWithTokensAndRecipes();
    const plan = await planBrandDerivation({ root, all: true });
    expect(Object.isFrozen(plan.targetStates[0])).toBe(true);
    expect(() => { (plan.targetStates[0] as any).state = "unchanged"; }).toThrow(TypeError);
    expect(() => { (plan.operationSummaries[0]!.operations as any)[0] = "copy-metadata"; }).toThrow(TypeError);
    expect(() => { (plan as any).targetStates = []; }).toThrow(TypeError);
    await expect(executeBrandDerivationPlan({ ...plan } as any)).rejects.toSatisfy((error: any) => error?.diagnostic?.code === "BRAND_DERIVE_PLAN_EXPIRED");
    await expect(executeBrandDerivationPlan(JSON.parse(JSON.stringify(plan)))).rejects.toSatisfy((error: any) => error?.diagnostic?.code === "BRAND_DERIVE_PLAN_EXPIRED");
    await expect(executeBrandDerivationPlan(Object.create(plan))).rejects.toSatisfy((error: any) => error?.diagnostic?.code === "BRAND_DERIVE_PLAN_EXPIRED");
    const result = await executeBrandDerivationPlan(plan);
    expect(result.targetsWritten).toEqual([".tfsb/assets/fixture-mark-derived-dark.toml"]);
    await expect(executeBrandDerivationPlan(plan)).rejects.toSatisfy((error: any) => error?.diagnostic?.code === "BRAND_DERIVE_PLAN_EXPIRED");
    await rm(root, { recursive: true, force: true });
  });

  it("consumes dry-run and no-op plans and disposes plans idempotently", async () => {
    const root = await setupProjectWithTokensAndRecipes();
    const dryRun = await planBrandDerivation({ root, all: true, dryRun: true });
    expect((await executeBrandDerivationPlan(dryRun)).written).toBe(false);
    await expect(executeBrandDerivationPlan(dryRun)).rejects.toSatisfy((error: any) => error?.diagnostic?.code === "BRAND_DERIVE_PLAN_EXPIRED");
    await deriveBrandProject({ root, all: true });
    const noOp = await planBrandDerivation({ root, all: true });
    expect((await executeBrandDerivationPlan(noOp)).written).toBe(false);
    await expect(executeBrandDerivationPlan(noOp)).rejects.toSatisfy((error: any) => error?.diagnostic?.code === "BRAND_DERIVE_PLAN_EXPIRED");
    const disposed = await planBrandDerivation({ root, all: true });
    await disposeBrandDerivationPlan(disposed);
    await disposeBrandDerivationPlan(disposed);
    await expect(executeBrandDerivationPlan(disposed)).rejects.toSatisfy((error: any) => error?.diagnostic?.code === "BRAND_DERIVE_PLAN_EXPIRED");
    await rm(root, { recursive: true, force: true });
  });

  it("treats tool-version-only receipt evidence as a semantic no-op", async () => {
    const root = await setupProjectWithTokensAndRecipes();
    await deriveBrandProject({ root, all: true });
    const receiptPath = join(root, ".tfsb", "derived", "fixture-mark-derived-dark.receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.toolVersion = "0.3.0-tool-evidence-only";
    receipt.receiptDigest = computeDerivedReceiptDigest(receipt);
    const preservedBytes = JSON.stringify(receipt, null, 2) + "\n";
    await writeFile(receiptPath, preservedBytes);
    const plan = await planBrandDerivation({ root, all: true });
    expect(plan.targetStates[0]!.state).toBe("unchanged");
    expect((await executeBrandDerivationPlan(plan)).written).toBe(false);
    expect(await readFile(receiptPath, "utf8")).toBe(preservedBytes);
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    "targetAssetId",
    "targetFilename",
    "recipeId",
    "recipeDefinitionDigest",
    "orderedOperations",
    "tokenFileDigest",
    "usedTokens",
    "sourceChain",
    "targetTomlByteDigest",
    "targetModelDigest",
    "targetSvgDigest",
    "accessibilityResult",
    "resourceCounts",
  ])("classifies a self-consistent altered receipt field without trusting it: %s", async (field) => {
    const root = await setupProjectWithTokensAndRecipes();
    await deriveBrandProject({ root, all: true });
    const receiptPath = join(root, ".tfsb", "derived", "fixture-mark-derived-dark.receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const zeroDigest = "sha256:" + "0".repeat(64);
    if (field === "targetAssetId") receipt.targetAssetId = "forged-target";
    else if (field === "targetFilename") receipt.targetFilename = "forged-target.svg";
    else if (field === "recipeId") receipt.recipeId = "forged-recipe";
    else if (field === "recipeDefinitionDigest") receipt.recipeDefinitionDigest = zeroDigest;
    else if (field === "orderedOperations") {
      receipt.orderedOperations[0].expectedOccurrences = 2;
      receipt.orderedOperationsDigest = computeSha256(Buffer.from(BRAND_RECIPE_OPERATIONS_DIGEST_BASIS + encodeCanonicalJson(receipt.orderedOperations), "utf8"));
    } else if (field === "tokenFileDigest") receipt.tokenFileDigest = zeroDigest;
    else if (field === "usedTokens") receipt.usedTokens[0].canonicalValue = "#112233FF";
    else if (field === "sourceChain") receipt.sourceChain[0].canonicalAssetDigest = zeroDigest;
    else if (field === "targetTomlByteDigest") receipt.targetTomlByteDigest = zeroDigest;
    else if (field === "targetModelDigest") receipt.targetModelDigest = zeroDigest;
    else if (field === "targetSvgDigest") receipt.targetSvgDigest = zeroDigest;
    else if (field === "accessibilityResult") receipt.accessibilityResult.title = "Forged title";
    else receipt.resourceCounts.elementCount += 1;
    receipt.receiptDigest = computeDerivedReceiptDigest(receipt);
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    if (field === "tokenFileDigest" || field === "sourceChain") {
      const stalePlan = await planBrandDerivation({ root, all: true });
      expect(stalePlan.targetStates[0]!.state).toBe("update");
      await disposeBrandDerivationPlan(stalePlan);
    } else {
      await expect(planBrandDerivation({ root, all: true })).rejects.toSatisfy((error: any) =>
        ["DERIVED_RECEIPT_INVALID", "DERIVED_ASSET_DRIFT"].includes(error?.diagnostic?.code),
      );
    }
    await rm(root, { recursive: true, force: true });
  });

  it("accepts an 8 MiB selected source and rejects source boundary plus one", async () => {
    const root = await setupProjectWithTokensAndRecipes();
    const sourcePath = join(root, ".tfsb", "assets", "fixture-mark-on-light.toml");
    const base = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml");
    await writeFile(sourcePath, assetWithExactBytes(base, "fixture-mark-on-light", DERIVE_FILE_LIMIT));
    const boundary = await planBrandDerivation({ root, all: true });
    expect(boundary.createdCount).toBe(1);
    await disposeBrandDerivationPlan(boundary);
    await writeFile(sourcePath, assetWithExactBytes(base, "fixture-mark-on-light", DERIVE_FILE_LIMIT + 1));
    await expect(planBrandDerivation({ root, all: true })).rejects.toSatisfy((error: any) => error?.diagnostic?.code === "RESOURCE_LIMIT_EXCEEDED");
    await rm(root, { recursive: true, force: true });
  }, 30000);

  it("accepts an exactly 8 MiB planned target and rejects target boundary plus one", async () => {
    const root = await setupProjectWithTokensAndRecipes();
    const recipePath = join(root, ".tfsb", "brand-recipes.toml");
    const recipesText = (await readFile(recipePath, "utf8")).replace(
      '[[recipes.operations]]\noperation = "copy-accessibility"',
      '[[recipes.operations]]\noperation = "copy-metadata"\nfields = ["metadata_text"]\n\n[[recipes.operations]]\noperation = "copy-accessibility"',
    );
    await writeFile(recipePath, recipesText);
    const base = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml");
    const sourcePath = join(root, ".tfsb", "assets", "fixture-mark-on-light.toml");
    const tokens = parseBrandTokensToml(await readFile(join(root, ".tfsb", "brand-tokens.toml"), "utf8"));
    const recipes = parseBrandRecipesToml(recipesText);
    if (!tokens.ok || !recipes.ok) throw new Error("Generated target-limit authority did not parse.");
    const baseSourceText = assetWithExactBytes(base, "fixture-mark-on-light", 1024);
    const baseSource = parseAssetTomlV2(baseSourceText);
    if (!baseSource.ok) throw new Error("Generated target-limit source did not parse.");
    const baseTarget = applyRecipeOperations(recipes.value.recipes[0]!, baseSource.value, tokens.value, { operation: "build", domain: "brand" }).targetAsset;
    const targetBaseBytes = Buffer.byteLength(serializeAssetTomlV2(baseTarget), "utf8");
    const sourceBytes = 1024 + (DERIVE_FILE_LIMIT - targetBaseBytes);
    const exactSourceText = assetWithExactBytes(base, "fixture-mark-on-light", sourceBytes);
    await writeFile(sourcePath, exactSourceText);
    const exactSource = parseAssetTomlV2(exactSourceText);
    if (!exactSource.ok) throw new Error("Exact target-limit source did not parse.");
    const exactTarget = applyRecipeOperations(recipes.value.recipes[0]!, exactSource.value, tokens.value, { operation: "build", domain: "brand" }).targetAsset;
    expect(Buffer.byteLength(serializeAssetTomlV2(exactTarget), "utf8")).toBe(DERIVE_FILE_LIMIT);
    const boundary = await planBrandDerivation({ root, all: true });
    await disposeBrandDerivationPlan(boundary);
    await writeFile(sourcePath, assetWithExactBytes(base, "fixture-mark-on-light", sourceBytes + 1));
    await expect(planBrandDerivation({ root, all: true })).rejects.toSatisfy((error: any) => error?.diagnostic?.code === "RESOURCE_LIMIT_EXCEEDED");
    await rm(root, { recursive: true, force: true });
  }, 30000);

  it("accepts the 32 MiB aggregate source-plus-target boundary and rejects boundary plus one", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-aggregate-limit-"));
    await mkdir(join(root, ".tfsb", "assets"), { recursive: true });
    await writeFile(join(root, ".tfsb", "project.toml"), readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/project.toml"));
    const base = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml");
    const sizes = [4194307, 4194307, 4194306, 4194306] as const;
    const ids = ["large-one", "large-two", "large-six", "large-ten"] as const;
    const roles = ["mark", "wordmark", "favicon", "app-icon"] as const;
    const targetSizes: number[] = [];
    for (let index = 0; index < ids.length; index++) {
      await writeFile(join(root, ".tfsb", "assets", `source-${ids[index]}.toml`), assetWithExactBytes(base, `source-${ids[index]}`, sizes[index]!));
    }
    let brand = `schema = "tfsb.brand"\nschema_version = 1\nenabled_domains = { tokens = true, recipes = true, qa = false, consumer_profiles = false, package = false, exports = false }\n\n[[families]]\nid = "large-family"\nname = "Large Family"\nrequired_roles = []\noptional_roles = ["mark", "wordmark", "favicon", "app-icon"]\n`;
    let recipes = `schema = "tfsb.brand-recipes"\nschema_version = 1\n`;
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index]!;
      const role = roles[index]!;
      brand += `\n[[variants]]\nfamily = "large-family"\nid = "source-${id}"\nbackgrounds = ["light"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "primary"\n\n[[variants]]\nfamily = "large-family"\nid = "target-${id}"\nbackgrounds = ["dark"]\ncolor_mode = "reversed"\nscale = "standard"\nstatus = "primary"\n\n[[bindings]]\nfamily = "large-family"\nrole = "${role}"\nvariant = "source-${id}"\nasset = "source-${id}"\nauthority = "source"\n\n[[bindings]]\nfamily = "large-family"\nrole = "${role}"\nvariant = "target-${id}"\nasset = "target-${id}"\nauthority = "derived"\n`;
      recipes += `\n[[recipes]]\nid = "recipe-${id}"\ntarget_asset = "target-${id}"\nsource_asset = "source-${id}"\n[[recipes.operations]]\noperation = "copy-metadata"\nfields = ["metadata_text"]\n[[recipes.operations]]\noperation = "copy-accessibility"\npolicy = "preserve"\n`;
    }
    await writeFile(join(root, ".tfsb", "brand.toml"), brand);
    const aggregateTokensText = 'schema = "tfsb.brand-tokens"\nschema_version = 1\n';
    await writeFile(join(root, ".tfsb", "brand-tokens.toml"), aggregateTokensText);
    await writeFile(join(root, ".tfsb", "brand-recipes.toml"), recipes);
    expect(sizes.reduce((sum, size) => sum + size + (size - 5), 0)).toBe(DERIVE_AGGREGATE_LIMIT);
    const aggregateTokens = parseBrandTokensToml(aggregateTokensText);
    const aggregateRecipes = parseBrandRecipesToml(recipes);
    if (!aggregateTokens.ok || !aggregateRecipes.ok) throw new Error("Aggregate authority did not parse.");
    for (let index = 0; index < ids.length; index++) {
      const sourceText = await readFile(join(root, ".tfsb", "assets", `source-${ids[index]}.toml`), "utf8");
      const source = parseAssetTomlV2(sourceText);
      if (!source.ok) throw new Error("Aggregate source did not parse.");
      const recipe = aggregateRecipes.value.recipes.find((item) => item.source_asset === source.value.id)!;
      const target = applyRecipeOperations(recipe, source.value, aggregateTokens.value, { operation: "build", domain: "brand" }).targetAsset;
      targetSizes.push(Buffer.byteLength(serializeAssetTomlV2(target), "utf8"));
    }
    expect(targetSizes).toEqual(sizes.map((size) => size - 5));
    const boundary = await planBrandDerivation({ root, all: true });
    expect(boundary.affectedTargets).toHaveLength(4);
    await disposeBrandDerivationPlan(boundary);
    await writeFile(join(root, ".tfsb", "assets", "source-large-six.toml"), assetWithExactBytes(base, "source-large-six", sizes[2] + 1));
    await expect(planBrandDerivation({ root, all: true })).rejects.toSatisfy((error: any) => error?.diagnostic?.code === "RESOURCE_LIMIT_EXCEEDED");
    await rm(root, { recursive: true, force: true });
  }, 30000);

  const stagedFaults = ["target", "receipt", "token", "recipe", "source", "project", "extra", "symlink", "directory"] as const;
  const boundaries = ["afterStageWrite", "beforePromotion"] as const;
  it.each(boundaries.flatMap((boundary) => stagedFaults.map((fault) => [boundary, fault] as const)))(
    "rejects %s staged %s tampering without promotion or residue",
    async (boundary, fault) => {
      const root = await setupProjectWithTokensAndRecipes();
      const plan = await planBrandDerivation({ root, all: true });
      const tamper = async (): Promise<void> => {
        const stageName = (await readdir(root)).find((entry) => entry.startsWith(".tfsb-stage-"));
        if (stageName === undefined) throw new Error("Expected derivation stage directory.");
        const stage = join(root, stageName);
        const paths = {
          target: join(stage, "assets", "fixture-mark-derived-dark.toml"),
          receipt: join(stage, "derived", "fixture-mark-derived-dark.receipt.json"),
          token: join(stage, "brand-tokens.toml"),
          recipe: join(stage, "brand-recipes.toml"),
          source: join(stage, "assets", "fixture-mark-on-light.toml"),
          project: join(stage, "project.toml"),
        } as const;
        if (fault === "extra") await writeFile(join(stage, "extra.toml"), "extra = true\n");
        else if (fault === "symlink") {
          await rm(paths.target);
          await symlink("/dev/null", paths.target);
        } else if (fault === "directory") {
          await rm(join(stage, "assets"), { recursive: true });
          await writeFile(join(stage, "assets"), "not a directory\n");
        } else {
          await writeFile(paths[fault], Buffer.concat([await readFile(paths[fault]), Buffer.from("\n# tampered\n")]));
        }
      };
      await expect(executeBrandDerivationPlan(plan, { [boundary]: tamper })).rejects.toBeDefined();
      expect(await readdir(root)).not.toContain(".tfsb.lock");
      expect((await readdir(root)).filter((entry) => entry.startsWith(".tfsb-stage-") || entry.startsWith(".tfsb-backup-"))).toEqual([]);
      await expect(readFile(join(root, ".tfsb", "assets", "fixture-mark-derived-dark.toml"))).rejects.toBeDefined();
      await rm(root, { recursive: true, force: true });
    },
  );
});
