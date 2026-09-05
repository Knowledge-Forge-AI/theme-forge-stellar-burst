import { lstat, opendir } from "node:fs/promises";
import { join, relative } from "node:path";

import { fail, type DiagnosticContext } from "../diagnostics.js";
import { computeAssetSemanticDigest, computeSha256, computeSvgOutputDigest, type Sha256Digest } from "../digests.js";
import { readRegularFileSnapshot } from "../filesystem.js";
import { loadCanonicalProjectFromSnapshot } from "../project.js";
import { executeCanonicalTransaction, snapshotCanonicalTree, type CanonicalSnapshot, type TransactionHooks } from "../transaction.js";
import type { AnyNormalizedAsset } from "../schema-dispatch.js";
import { compareUtf8 } from "../provenance.js";
import { inspectPlanRetention, type PlanRetentionInspection } from "../plan-retention.js";
import { brandBaselinePath } from "./brand-files.js";
import { computeBrandSystemDigest } from "./brand-digests.js";
import { compareBrandQaRasters, decodeBrandQaBaseline, parseBrandQaBackgroundRgba, renderBrandQaRaster, validateBrandQaRendererDescriptor, BRAND_QA_RENDER_CONFIGURATION, type BrandQaRasterBudget, type BrandQaRendererCapability } from "./qa-capability.js";
import { parseBrandQaToml, serializeBrandQaToml, toBrandQaCanonicalDto, type BrandQaBackground, type BrandQaBaselineCase, type BrandQaModel, type BrandQaSize, type BrandQaTargetSelector } from "./qa-schema.js";
import { toBrandRecipesCanonicalDto } from "./recipes.js";
import { toBrandTokensCanonicalDto, type BrandTokensModel } from "./tokens.js";

const baselinePlanBrand: unique symbol = Symbol("BrandQaBaselineUpdatePlan");

export interface BrandQaBaselineUpdateOptions {
  readonly root?: string;
  readonly profileId: string;
  readonly caseId: string;
  readonly renderer: BrandQaRendererCapability;
  readonly create?: BrandQaBaselineCreate;
  readonly allowRebaseline?: boolean;
}

export interface BrandQaBaselineCreate extends BrandQaTargetSelector {
  readonly size: BrandQaSize;
  readonly background: BrandQaBackground;
}

export interface BrandQaBaselineUpdatePlan {
  readonly [baselinePlanBrand]: true;
  readonly profileId: string;
  readonly caseId: string;
  readonly baselinePath: string;
  readonly state: "create" | "update" | "rebaseline";
  readonly oldBaselineDigest: Sha256Digest | null;
  readonly newBaselineDigest: Sha256Digest;
  readonly oldQaDigest: Sha256Digest;
  readonly newQaDigest: Sha256Digest;
  readonly renderer: {
    readonly id: string;
    readonly version: string;
    readonly qualificationId: string;
    readonly platformClaim: string;
  };
  readonly rasterDifference: {
    readonly changedPixels: number | null;
    readonly maximumChannelDelta: number | null;
    readonly changedBounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } | null;
    readonly beforeDecodedPixelDigest: Sha256Digest | null;
    readonly afterDecodedPixelDigest: Sha256Digest;
  };
}

export interface BrandQaBaselineUpdateResult {
  readonly written: boolean;
  readonly profileId: string;
  readonly caseId: string;
  readonly baselinePath: string;
  readonly baselineDigest: Sha256Digest;
  readonly qaDigest: Sha256Digest;
}

interface BaselinePlanInternals {
  readonly root: string;
  readonly snapshot: CanonicalSnapshot;
  readonly nextFiles: ReadonlyMap<string, Uint8Array>;
  readonly renderer: BrandQaRendererCapability;
  readonly descriptorValue: string;
  readonly newPngBytes: Uint8Array;
  readonly newQaBytes: Uint8Array;
  readonly protocolInspection: BrandQaBaselineProtocolInspection;
  executed: boolean;
}

export interface BrandQaBaselineProtocolInspection {
  readonly oldAssetDigest: Sha256Digest;
  readonly newAssetDigest: Sha256Digest;
  readonly oldSvgDigest: Sha256Digest;
  readonly newSvgDigest: Sha256Digest;
  readonly oldBrandSystemDigest: Sha256Digest;
  readonly newBrandSystemDigest: Sha256Digest;
}

const baselinePlanInternals = new WeakMap<BrandQaBaselineUpdatePlan, BaselinePlanInternals>();

function context(): DiagnosticContext { return { operation: "reconcile", domain: "brand" }; }

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function unwrapQa(model: BrandQaModel | undefined): BrandQaModel {
  if (model === undefined) fail(context(), "BRAND_QA_DISABLED", "Brand QA is not enabled and available.", ".tfsb/brand-qa.toml");
  return model;
}

function resolveBaselineAsset(qaCase: BrandQaBaselineCase, brand: NonNullable<Awaited<ReturnType<typeof loadCanonicalProjectFromSnapshot>>["brand"]>, assets: ReadonlyMap<string, AnyNormalizedAsset>): AnyNormalizedAsset {
  if (qaCase.asset !== undefined) {
    const asset = assets.get(qaCase.asset);
    if (asset === undefined) fail(context(), "BRAND_QA_TARGET_INVALID", `Baseline asset '${qaCase.asset}' is missing.`, qaCase.id);
    return asset;
  }
  const bindings = brand.model.bindings.filter((binding) => binding.family === qaCase.family && (qaCase.role === undefined || binding.role === qaCase.role) && (qaCase.variant === undefined || binding.variant === qaCase.variant));
  if (bindings.length !== 1) fail(context(), "BRAND_QA_BASELINE_MULTIPLICITY", `Baseline case '${qaCase.id}' must resolve exactly one binding.`, qaCase.id);
  const asset = assets.get(bindings[0]!.asset);
  if (asset === undefined) fail(context(), "BRAND_QA_TARGET_INVALID", "Baseline binding target is missing.", qaCase.id);
  return asset;
}

function resolveBackground(background: BrandQaBackground, tokens: BrandTokensModel | undefined): readonly [number, number, number, number] | null {
  if (!background.startsWith("token:")) return parseBrandQaBackgroundRgba(background);
  const token = tokens?.colors.find((entry) => entry.id === background.slice("token:".length));
  if (token === undefined) fail(context(), "BRAND_TOKEN_TYPE_MISMATCH", "Baseline background token is missing or is not a color token.", background);
  return parseBrandQaBackgroundRgba(token.value as BrandQaBackground);
}

function replaceBaselineCase(model: BrandQaModel, replacement: BrandQaBaselineCase): BrandQaModel {
  return Object.freeze({ ...model, cases: Object.freeze(model.cases.map((entry) => entry.id === replacement.id ? replacement : entry)) });
}

function addBaselineCase(model: BrandQaModel, profileId: string, qaCase: BrandQaBaselineCase): BrandQaModel {
  return Object.freeze({ ...model, profiles: Object.freeze(model.profiles.map((profile) => profile.id === profileId ? Object.freeze({ ...profile, cases: Object.freeze([...profile.cases, qaCase.id]) }) : profile)), cases: Object.freeze([...model.cases, qaCase]) });
}

async function validateExactStagedTree(stageRoot: string, expectedFiles: ReadonlyMap<string, Uint8Array>, expectedQaDigest: Sha256Digest): Promise<void> {
  const actualFiles = new Map<string, Uint8Array>();
  const expectedDirectories = new Set<string>();
  for (const path of expectedFiles.keys()) {
    const segments = path.slice(".tfsb/".length).split("/");
    for (let index = 1; index < segments.length; index++) expectedDirectories.add(segments.slice(0, index).join("/"));
  }
  const actualDirectories = new Set<string>();
  const scan = async (directory: string): Promise<void> => {
    const entries = [];
    for await (const entry of await opendir(directory)) entries.push(entry);
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const stat = await lstat(full);
      const inside = relative(stageRoot, full).replaceAll("\\", "/");
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail(context(), "BRAND_QA_BASELINE_STAGE_UNSAFE", "Staged tree contains a symlink or special file.", `.tfsb/${inside}`);
      if (stat.isDirectory()) { actualDirectories.add(inside); await scan(full); continue; }
      const path = `.tfsb/${inside}`;
      const expected = expectedFiles.get(path);
      if (expected === undefined || stat.size !== expected.byteLength) fail(context(), "BRAND_QA_BASELINE_STAGE_MISMATCH", "Staged tree differs from the private baseline plan.", path);
      const snapshot = await readRegularFileSnapshot(full, context(), "BRAND_QA_BASELINE_STAGE_UNSAFE", "Failed to read staged file.");
      if (!Buffer.from(snapshot.bytes).equals(Buffer.from(expected))) fail(context(), "BRAND_QA_BASELINE_STAGE_MISMATCH", "Staged bytes differ from the private baseline plan.", path);
      actualFiles.set(path, snapshot.bytes);
    }
  };
  await scan(stageRoot);
  if (actualFiles.size !== expectedFiles.size || JSON.stringify([...actualDirectories].sort(compareUtf8)) !== JSON.stringify([...expectedDirectories].sort(compareUtf8))) fail(context(), "BRAND_QA_BASELINE_STAGE_MISMATCH", "Staged topology differs from the private baseline plan.", ".tfsb");
  const qaBytes = actualFiles.get(".tfsb/brand-qa.toml");
  if (qaBytes === undefined) fail(context(), "BRAND_QA_BASELINE_STAGE_MISMATCH", "Staged QA authority is missing.", ".tfsb/brand-qa.toml");
  let qaText: string;
  try { qaText = new TextDecoder("utf8", { fatal: true }).decode(qaBytes); }
  catch { fail(context(), "BRAND_QA_BASELINE_STAGE_MISMATCH", "Staged QA authority is not valid UTF-8.", ".tfsb/brand-qa.toml"); }
  const parsed = parseBrandQaToml(qaText, ".tfsb/brand-qa.toml");
  if (!parsed.ok) fail(context(), "BRAND_QA_BASELINE_STAGE_MISMATCH", "Staged QA authority is invalid.", ".tfsb/brand-qa.toml");
  const { computeBrandQaDigest } = await import("./qa-schema.js");
  if (computeBrandQaDigest(parsed.value) !== expectedQaDigest) fail(context(), "BRAND_QA_BASELINE_STAGE_MISMATCH", "Staged QA semantics differ from the private plan.", ".tfsb/brand-qa.toml");
}

export async function planBrandQaBaselineUpdate(options: BrandQaBaselineUpdateOptions): Promise<BrandQaBaselineUpdatePlan> {
  const root = options.root ?? process.cwd();
  const snapshot = await snapshotCanonicalTree(root, false, "reconcile");
  const loaded = await loadCanonicalProjectFromSnapshot(snapshot, "reconcile");
  const brand = loaded.brand;
  if (brand === undefined) fail(context(), "BRAND_NOT_CONFIGURED", "Project is not configured as a brand system.", root);
  let qa = unwrapQa(brand.qaModel);
  const profile = qa.profiles.find((entry) => entry.id === options.profileId);
  if (profile === undefined) fail(context(), "BRAND_QA_BASELINE_CASE_INVALID", "Baseline profile does not exist.", options.profileId);
  let qaCase = qa.cases.find((entry): entry is BrandQaBaselineCase => entry.id === options.caseId && entry.kind === "baseline");
  const expectedPath = brandBaselinePath(profile.id, options.caseId);
  const creating = qaCase === undefined;
  if (creating) {
    if (options.create === undefined || qa.cases.some((entry) => entry.id === options.caseId) || profile.cases.includes(options.caseId)) fail(context(), "BRAND_QA_BASELINE_CASE_INVALID", "Creating a baseline requires a new case ID and one bounded create definition.", options.caseId);
    if (snapshot.files.has(expectedPath)) fail(context(), "BRAND_QA_BASELINE_UNOWNED", "An unowned baseline already exists at the new case path.", expectedPath);
    const descriptor = validateBrandQaRendererDescriptor(options.renderer.descriptor);
    const provisional: BrandQaBaselineCase = Object.freeze({ id: options.caseId, kind: "baseline", ...(options.create.asset === undefined ? {} : { asset: options.create.asset }), ...(options.create.family === undefined ? {} : { family: options.create.family }), ...(options.create.role === undefined ? {} : { role: options.create.role }), ...(options.create.variant === undefined ? {} : { variant: options.create.variant }), sizes: Object.freeze([Object.freeze([...options.create.size]) as BrandQaSize]), backgrounds: Object.freeze([options.create.background]), baselinePath: expectedPath, baselineDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000", rendererId: descriptor.id, rendererVersion: descriptor.version, platformClaim: descriptor.platformClaim, canonicalAssetDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000", svgDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" });
    const validated = parseBrandQaToml(serializeBrandQaToml(addBaselineCase(qa, profile.id, provisional)), ".tfsb/brand-qa.toml");
    if (!validated.ok) fail(context(), "BRAND_QA_BASELINE_CASE_INVALID", "New baseline case definition is invalid.", options.caseId);
    qa = validated.value;
    qaCase = qa.cases.find((entry): entry is BrandQaBaselineCase => entry.id === options.caseId && entry.kind === "baseline")!;
  }
  if (qaCase === undefined) fail(context(), "BRAND_QA_BASELINE_CASE_INVALID", "Baseline case could not be resolved.", options.caseId);
  if (!creating && !profile.cases.includes(qaCase.id)) fail(context(), "BRAND_QA_BASELINE_CASE_INVALID", "Profile/case does not identify one baseline case.", options.caseId);
  if (qaCase.baselinePath !== expectedPath) fail(context(), "BRAND_QA_BASELINE_PATH", "Baseline path does not match profile/case identity.", qaCase.baselinePath);
  const descriptor = validateBrandQaRendererDescriptor(options.renderer.descriptor, creating ? undefined : { id: qaCase.rendererId, version: qaCase.rendererVersion, platformClaim: qaCase.platformClaim });
  const assetMap = new Map(loaded.assets.map((asset) => [asset.id, asset]));
  const asset = resolveBaselineAsset(qaCase, brand, assetMap);
  const svgBytes = loaded.outputs.get(asset.filename);
  if (svgBytes === undefined) fail(context(), "BRAND_QA_SVG_MISSING", "Canonical SVG bytes are missing.", asset.id);
  const canonicalAssetDigest = computeAssetSemanticDigest(asset);
  const svgDigest = computeSvgOutputDigest(Buffer.from(svgBytes).toString("utf8"));
  const baselineFile = snapshot.files.get(expectedPath);
  const metadataExact = qaCase.canonicalAssetDigest === canonicalAssetDigest && qaCase.svgDigest === svgDigest && qaCase.rendererId === descriptor.id && qaCase.rendererVersion === descriptor.version && qaCase.platformClaim === descriptor.platformClaim;
  const bytesExact = baselineFile !== undefined && baselineFile.digest === qaCase.baselineDigest;
  let state: BrandQaBaselineUpdatePlan["state"];
  if (baselineFile === undefined) {
    if (!creating) fail(context(), "BRAND_QA_BASELINE_MISSING", "Baseline metadata exists but the PNG is missing.", expectedPath);
    state = "create";
  } else if (!metadataExact || !bytesExact) {
    if (options.allowRebaseline !== true) fail(context(), "BRAND_QA_BASELINE_DRIFT", "Baseline bytes or input/renderer metadata are stale or drifted; explicit rebaseline authority is required.", expectedPath);
    state = "rebaseline";
  } else state = "update";
  const [width, height] = qaCase.sizes[0]!;
  const background = qaCase.backgrounds[0]!;
  const budget: BrandQaRasterBudget = { decodedRgbaBytes: 0 };
  const nextRaster = await renderBrandQaRaster(options.renderer, { canonicalSvgBytes: svgBytes, svgDigest, width, height, background, backgroundRgba: resolveBackground(background, brand.tokensModel), configuration: BRAND_QA_RENDER_CONFIGURATION }, budget);
  if (nextRaster.pngBytes === undefined || nextRaster.pngBytes.byteLength === 0) fail(context(), "BRAND_QA_BASELINE_PNG_REQUIRED", "Baseline renderer must return deterministic PNG bytes.", expectedPath);
  let difference: ReturnType<typeof compareBrandQaRasters> | undefined;
  if (baselineFile !== undefined && bytesExact) difference = compareBrandQaRasters(await decodeBrandQaBaseline(options.renderer, baselineFile.bytes, width, height, budget), nextRaster);
  const nextPng = new Uint8Array(nextRaster.pngBytes);
  const nextDigest = computeSha256(nextPng);
  const replacement: BrandQaBaselineCase = Object.freeze({ ...qaCase, baselineDigest: nextDigest, rendererId: descriptor.id, rendererVersion: descriptor.version, platformClaim: descriptor.platformClaim, canonicalAssetDigest, svgDigest });
  const nextQa = replaceBaselineCase(qa, replacement);
  const nextQaText = serializeBrandQaToml(nextQa);
  const reparsed = parseBrandQaToml(nextQaText, ".tfsb/brand-qa.toml");
  if (!reparsed.ok) fail(context(), "BRAND_QA_BASELINE_PLAN_INVALID", "Planned QA serialization did not reparse.", ".tfsb/brand-qa.toml");
  const { computeBrandQaDigest } = await import("./qa-schema.js");
  const oldQaDigest = computeBrandQaDigest(qa);
  const newQaDigest = computeBrandQaDigest(reparsed.value);
  if (brand.brandSystemDigest === undefined) fail(context(), "BRAND_QA_BASELINE_PLAN_INVALID", "Current brand-system digest is unavailable.");
  const referencedAssetIds = [...new Set(brand.model.bindings.map((binding) => binding.asset))].sort(compareUtf8);
  const referencedAssets = referencedAssetIds.map((assetId) => {
    const referenced = loaded.assets.find((entry) => entry.id === assetId);
    if (referenced === undefined) fail(context(), "BRAND_QA_TARGET_INVALID", `Referenced asset '${assetId}' is missing.`);
    return { assetId, canonicalAssetDigest: computeAssetSemanticDigest(referenced) };
  });
  const newBrandSystemDigest = computeBrandSystemDigest({
    brand: brand.model,
    consumerProfiles: brand.consumerProfilesModel ?? null,
    exports: brand.exportsModel ?? null,
    qa: toBrandQaCanonicalDto(reparsed.value),
    recipes: brand.recipesModel === undefined ? null : toBrandRecipesCanonicalDto(brand.recipesModel),
    referencedAssets,
    tokens: brand.tokensModel === undefined ? null : toBrandTokensCanonicalDto(brand.tokensModel),
  });
  const nextFiles = new Map<string, Uint8Array>([...snapshot.files].map(([path, file]) => [path, file.bytes]));
  const newQaBytes = Buffer.from(nextQaText, "utf8");
  nextFiles.set(".tfsb/brand-qa.toml", newQaBytes);
  nextFiles.set(expectedPath, nextPng);
  const plan = deepFreeze({ profileId: profile.id, caseId: qaCase.id, baselinePath: expectedPath, state, oldBaselineDigest: baselineFile?.digest ?? null, newBaselineDigest: nextDigest, oldQaDigest, newQaDigest, renderer: { ...descriptor }, rasterDifference: { changedPixels: difference?.changedPixels ?? null, maximumChannelDelta: difference?.maximumChannelDelta ?? null, changedBounds: difference?.changedBounds === null || difference === undefined ? null : { ...difference.changedBounds }, beforeDecodedPixelDigest: difference?.beforeDecodedPixelDigest ?? null, afterDecodedPixelDigest: difference?.afterDecodedPixelDigest ?? computeSha256(nextRaster.rgba8) }, [baselinePlanBrand]: true as const });
  baselinePlanInternals.set(plan, { root: loaded.root, snapshot, nextFiles, renderer: options.renderer, descriptorValue: JSON.stringify(descriptor), newPngBytes: nextPng, newQaBytes, protocolInspection: Object.freeze({ oldAssetDigest: qaCase.canonicalAssetDigest, newAssetDigest: canonicalAssetDigest, oldSvgDigest: qaCase.svgDigest, newSvgDigest: svgDigest, oldBrandSystemDigest: brand.brandSystemDigest, newBrandSystemDigest }), executed: false });
  return plan;
}

export async function executeBrandQaBaselineUpdatePlan(plan: BrandQaBaselineUpdatePlan, hooks?: TransactionHooks): Promise<BrandQaBaselineUpdateResult> {
  const internals = baselinePlanInternals.get(plan);
  if (internals === undefined || internals.executed) fail(context(), "BRAND_QA_BASELINE_PLAN_EXPIRED", "Baseline plan is disposed, forged, copied, or already executed.");
  internals.executed = true;
  baselinePlanInternals.delete(plan);
  if (JSON.stringify(validateBrandQaRendererDescriptor(internals.renderer.descriptor)) !== internals.descriptorValue) fail(context(), "BRAND_QA_BASELINE_RENDERER_CHANGED", "Renderer descriptor changed after planning.");
  const verifyRenderer = (): void => {
    if (JSON.stringify(validateBrandQaRendererDescriptor(internals.renderer.descriptor)) !== internals.descriptorValue) fail(context(), "BRAND_QA_BASELINE_RENDERER_CHANGED", "Renderer descriptor changed during baseline transaction.");
  };
  await executeCanonicalTransaction({ root: internals.root, expectedSnapshot: internals.snapshot, nextFiles: internals.nextFiles, operation: "reconcile", validateStagedTree: (stageRoot) => validateExactStagedTree(stageRoot, internals.nextFiles, plan.newQaDigest), verifyExternalState: verifyRenderer, ...(hooks === undefined ? {} : { hooks }) });
  return Object.freeze({ written: true, profileId: plan.profileId, caseId: plan.caseId, baselinePath: plan.baselinePath, baselineDigest: plan.newBaselineDigest, qaDigest: plan.newQaDigest });
}

export function disposeBrandQaBaselineUpdatePlan(plan: BrandQaBaselineUpdatePlan): void {
  const internals = baselinePlanInternals.get(plan);
  if (internals === undefined) return;
  internals.newPngBytes.fill(0);
  internals.newQaBytes.fill(0);
  internals.executed = true;
  baselinePlanInternals.delete(plan);
}

/** Internal Studio summary seam; exposes only digests already bound by the authentic plan. */
export function inspectBrandQaBaselineProtocol(plan: BrandQaBaselineUpdatePlan): BrandQaBaselineProtocolInspection {
  const internals = baselinePlanInternals.get(plan);
  if (internals === undefined || internals.executed) fail(context(), "BRAND_QA_BASELINE_PLAN_EXPIRED", "Baseline plan is disposed, forged, copied, or already executed.");
  return internals.protocolInspection;
}

/** Internal Studio retention seam; not re-exported from the package root. */
export function inspectBrandQaBaselineUpdatePlanRetention(plan: BrandQaBaselineUpdatePlan): PlanRetentionInspection {
  const internals = baselinePlanInternals.get(plan);
  if (internals === undefined) throw new Error("Brand QA baseline plan was not produced by this planner instance.");
  return inspectPlanRetention([plan, internals]);
}
