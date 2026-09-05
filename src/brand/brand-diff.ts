import type { LoadedProject } from "../project.js";
import { computeAssetSemanticDigest, computeSha256, type Sha256Digest } from "../digests.js";
import { compareUtf8 } from "../provenance.js";
import type { AnyNormalizedAsset } from "../schema-dispatch.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import type { BrandDerivedReceipt } from "./derived-receipt.js";
import { parseBrandDerivedReceipt } from "./derived-receipt.js";
import type { DerivedAuthorityInspection } from "./derive.js";
import { inspectDerivedAuthority } from "./derive.js";
import { derivedReceiptPath } from "./brand-files.js";
import { toBrandQaCanonicalDto, type BrandQaModel } from "./qa-schema.js";
import { toBrandRecipeCanonicalDto, type BrandRecipesModel } from "./recipes.js";
import { toBrandTokensCanonicalDto, type BrandTokensModel } from "./tokens.js";
import { computeConsumerProfileDigest, computeConsumerProfilesDomainDigest } from "./consumer-profile.js";
import { computeBrandExportOutputDigest, computeBrandExportProfileDigest, computeBrandExportsDomainDigest, toBrandExportOutputCanonicalDto } from "./export-profile.js";

export const BRAND_DIFF_SCHEMA = "tfsb.brand-diff" as const;
export const BRAND_DIFF_SCHEMA_VERSION = 1 as const;
export const BRAND_DIFF_DIGEST_BASIS = "tfsb.brand-diff-v1\n" as const;
const MAX_DIFF_BYTES = 16 * 1_048_576;
type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface BrandDiffChange<T extends JsonValue = JsonValue> {
  readonly id: string;
  readonly change: "added" | "removed" | "changed";
  readonly before: T | null;
  readonly after: T | null;
}

export interface BrandDiffSnapshot {
  readonly digest: Sha256Digest;
  readonly brand: NonNullable<LoadedProject["brand"]>;
  readonly assets: ReadonlyMap<string, AnyNormalizedAsset>;
  readonly companions: ReadonlyMap<string, Uint8Array>;
  readonly derived?: DerivedAuthorityInspection;
  readonly receipts?: ReadonlyMap<string, BrandDerivedReceipt>;
}

export interface BrandDiffResult {
  readonly schema: typeof BRAND_DIFF_SCHEMA;
  readonly schemaVersion: typeof BRAND_DIFF_SCHEMA_VERSION;
  readonly beforeDigest: Sha256Digest;
  readonly afterDigest: Sha256Digest;
  readonly status: "equal" | "changed";
  readonly inventory: {
    readonly families: readonly BrandDiffChange[];
    readonly roles: readonly BrandDiffChange[];
    readonly variants: readonly BrandDiffChange[];
    readonly requirements: readonly BrandDiffChange[];
    readonly completeness: BrandDiffChange | null;
  };
  readonly bindings: { readonly records: readonly BrandDiffChange[] };
  readonly tokens: { readonly records: readonly BrandDiffChange[] };
  readonly recipes: { readonly records: readonly BrandDiffChange[]; readonly affectedTargets: readonly string[] };
  readonly derived: { readonly records: readonly BrandDiffChange[] };
  readonly geometry: { readonly records: readonly BrandDiffChange[]; readonly canonicalTypedGeometryChanged: boolean; readonly equivalenceClaim: "none" };
  readonly qaImpact: { readonly profiles: readonly BrandDiffChange[]; readonly cases: readonly BrandDiffChange[]; readonly affectedCases: readonly string[] };
  readonly packageAndLegal: { readonly package: BrandDiffChange | null; readonly companions: readonly BrandDiffChange[]; readonly bundleRelevantChanged: boolean };
  readonly consumerProfiles: { readonly beforeState: string; readonly afterState: string; readonly status: "available" | "unavailable"; readonly records: readonly BrandDiffChange[] };
  readonly exports: { readonly beforeState: string; readonly afterState: string; readonly status: "available" | "unavailable"; readonly records: readonly BrandDiffChange[] };
  readonly resultDigest: Sha256Digest;
}

function json(value: unknown): JsonValue { return JSON.parse(encodeCanonicalJson(value)) as JsonValue; }

function changes(beforeValues: ReadonlyMap<string, JsonValue>, afterValues: ReadonlyMap<string, JsonValue>): readonly BrandDiffChange[] {
  const ids = [...new Set([...beforeValues.keys(), ...afterValues.keys()])].sort(compareUtf8);
  const result: BrandDiffChange[] = [];
  for (const id of ids) {
    const before = beforeValues.get(id);
    const after = afterValues.get(id);
    if (before === undefined) result.push(Object.freeze({ id, change: "added", before: null, after: after! }));
    else if (after === undefined) result.push(Object.freeze({ id, change: "removed", before, after: null }));
    else if (encodeCanonicalJson(before) !== encodeCanonicalJson(after)) result.push(Object.freeze({ id, change: "changed", before, after }));
  }
  return Object.freeze(result);
}

function mapById<T>(values: readonly T[], identify: (value: T) => string, project: (value: T) => JsonValue = (value) => json(value)): ReadonlyMap<string, JsonValue> {
  return new Map(values.map((value) => [identify(value), project(value)]));
}

function roles(snapshot: BrandDiffSnapshot): ReadonlyMap<string, JsonValue> {
  const values = new Map<string, JsonValue>();
  for (const family of snapshot.brand.model.families) for (const role of [...family.requiredRoles, ...family.optionalRoles]) values.set(`${family.id}/${role}`, json({ family: family.id, role, required: family.requiredRoles.includes(role) }));
  for (const requirement of snapshot.brand.model.requirements ?? []) values.set(`${requirement.family}/${requirement.role}`, json({ family: requirement.family, role: requirement.role, required: true }));
  return values;
}

function tokenMap(tokens?: BrandTokensModel): ReadonlyMap<string, JsonValue> {
  if (tokens === undefined) return new Map();
  const dto = toBrandTokensCanonicalDto(tokens);
  return new Map([
    ...dto.colors.map((entry) => [entry.id, json({ type: "color", value: entry.value })] as const),
    ...dto.dimensions.map((entry) => [entry.id, json({ type: "dimension", unit: entry.unit, value: entry.value })] as const),
    ...dto.gradients.map((entry) => [entry.id, json({ type: "gradient", ...entry })] as const),
    ...dto.opacities.map((entry) => [entry.id, json({ type: "opacity", value: entry.value })] as const),
  ]);
}

function recipeMap(recipes?: BrandRecipesModel): ReadonlyMap<string, JsonValue> {
  if (recipes === undefined) return new Map();
  return mapById(recipes.recipes, (entry) => entry.id, (entry) => json(toBrandRecipeCanonicalDto(entry)));
}

function derivedMap(snapshot: BrandDiffSnapshot): ReadonlyMap<string, JsonValue> {
  const result = new Map<string, JsonValue>();
  for (const entry of snapshot.derived?.entries ?? []) {
    const receipt = snapshot.receipts?.get(entry.targetAssetId);
    result.set(entry.targetAssetId, json({ targetAssetId: entry.targetAssetId, recipeId: entry.recipeId ?? null, state: entry.state, receiptDigest: entry.receiptDigest ?? null, targetModelDigest: entry.targetModelDigest ?? null, targetSvgDigest: entry.targetSvgDigest ?? null, sourceChain: receipt?.sourceChain ?? [], accessibility: receipt?.accessibilityResult ?? null }));
  }
  return result;
}

function geometry(asset: AnyNormalizedAsset): JsonValue {
  let elementCount = 0;
  let definitionCount = 0;
  const count = (value: unknown, definition: boolean): void => {
    if (Array.isArray(value)) { for (const child of value) count(child, definition); return; }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "elements" || key === "children") elementCount += Array.isArray(child) ? child.length : 0;
      if (key === "definitions" && typeof child === "object" && child !== null) {
        for (const list of Object.values(child)) if (Array.isArray(list)) definitionCount += list.length;
      }
      count(child, definition || key === "definitions");
    }
  };
  count(asset.svg, false);
  const typed = json({ canvas: asset.svg.canvas, definitions: asset.svg.definitions, elements: asset.svg.elements });
  return json({ canvas: asset.svg.canvas, elementCount, definitionCount, typedGeometryDigest: computeSha256(Buffer.from(encodeCanonicalJson(typed), "utf8")) });
}

function qaMaps(qa?: BrandQaModel): { profiles: ReadonlyMap<string, JsonValue>; cases: ReadonlyMap<string, JsonValue> } {
  if (qa === undefined) return { profiles: new Map(), cases: new Map() };
  const dto = toBrandQaCanonicalDto(qa);
  return { profiles: mapById(dto.profiles, (entry) => entry.id), cases: mapById(dto.cases, (entry) => entry.id) };
}

function packageValue(snapshot: BrandDiffSnapshot): JsonValue | undefined {
  return snapshot.brand.packageModel === undefined ? undefined : json(snapshot.brand.packageModel);
}

function consumerProfileMap(snapshot: BrandDiffSnapshot): Map<string, JsonValue> {
  const model = snapshot.brand.consumerProfilesModel;
  if (model === undefined) return new Map();
  return new Map([
    ["domain", json({ digest: computeConsumerProfilesDomainDigest(model) })],
    ...model.profiles.map((profile) => [profile.qualifiedId, json({ ...profile, digest: computeConsumerProfileDigest(profile) })] as const),
  ]);
}

function exportProfileMap(snapshot: BrandDiffSnapshot): Map<string, JsonValue> {
  const model = snapshot.brand.exportsModel;
  if (model === undefined) return new Map();
  const domainDigest = computeBrandExportsDomainDigest(model);
  const values = new Map<string, JsonValue>();
  for (const profile of model.profiles) {
    const profileDigest = computeBrandExportProfileDigest(profile);
    values.set(`profile/${profile.id}`, json({ profileId: profile.id, adapter: profile.adapter, profileDigest, domainDigest }));
    for (const output of profile.outputs) values.set(`output/${profile.id}/${output.id}`, json({ profileId: profile.id, profileDigest, outputConfigDigest: computeBrandExportOutputDigest(output), domainDigest, ...toBrandExportOutputCanonicalDto(output) }));
  }
  return values;
}

function companionMap(snapshot: BrandDiffSnapshot): ReadonlyMap<string, JsonValue> {
  return new Map([...snapshot.companions.entries()].map(([name, bytes]) => [name, json({ digest: computeSha256(bytes), size: bytes.byteLength })]));
}

function domainState(snapshot: BrandDiffSnapshot, domain: "consumer_profiles" | "exports"): string {
  return snapshot.brand.domains?.find((entry) => entry.domain === domain)?.state ?? "disabled";
}

function oneChange(id: string, before: JsonValue | undefined, after: JsonValue | undefined): BrandDiffChange | null {
  return changes(new Map(before === undefined ? [] : [[id, before]]), new Map(after === undefined ? [] : [[id, after]]))[0] ?? null;
}

export function createBrandDiffSnapshot(project: LoadedProject, derived?: DerivedAuthorityInspection, receipts?: ReadonlyMap<string, BrandDerivedReceipt>): BrandDiffSnapshot {
  if (project.brand === undefined || project.brand.brandSystemDigest === undefined) throw new Error("Brand diff requires a complete branded project.");
  return Object.freeze({ digest: project.brand.brandSystemDigest, brand: project.brand, assets: new Map(project.assets.map((asset) => [asset.id, asset])), companions: project.companions, ...(derived === undefined ? {} : { derived }), ...(receipts === undefined ? {} : { receipts }) });
}

export function createLoadedProjectBrandDiffSnapshot(project: LoadedProject): BrandDiffSnapshot {
  if (project.brand === undefined) throw new Error("Brand diff requires a branded project.");
  const derived = project.brand.recipesModel === undefined ? undefined : inspectDerivedAuthority(project.snapshot.files, { operation: "diff", domain: "brand" });
  const receipts = new Map<string, BrandDerivedReceipt>();
  for (const asset of project.assets) {
    const path = derivedReceiptPath(asset.id);
    const entry = project.snapshot.files.get(path);
    if (entry === undefined) continue;
    const parsed = parseBrandDerivedReceipt(new TextDecoder("utf8", { fatal: true }).decode(entry.bytes), path);
    if (parsed.ok) receipts.set(asset.id, parsed.value);
  }
  return createBrandDiffSnapshot(project, derived, receipts);
}

export function computeBrandDiffResultDigest(result: Omit<BrandDiffResult, "resultDigest">): Sha256Digest {
  return computeSha256(Buffer.from(BRAND_DIFF_DIGEST_BASIS + encodeCanonicalJson(result), "utf8"));
}

export function compareBrandSnapshots(before: BrandDiffSnapshot, after: BrandDiffSnapshot): BrandDiffResult {
  const beforeBrand = before.brand.model;
  const afterBrand = after.brand.model;
  const inventory = Object.freeze({
    families: changes(mapById(beforeBrand.families, (entry) => entry.id), mapById(afterBrand.families, (entry) => entry.id)),
    roles: changes(roles(before), roles(after)),
    variants: changes(mapById(beforeBrand.variants, (entry) => `${entry.family}/${entry.id}`), mapById(afterBrand.variants, (entry) => `${entry.family}/${entry.id}`)),
    requirements: changes(mapById(beforeBrand.requirements ?? [], (entry) => `${entry.family}/${entry.role}/${entry.background ?? ""}/${entry.colorMode ?? ""}/${entry.scale ?? ""}`), mapById(afterBrand.requirements ?? [], (entry) => `${entry.family}/${entry.role}/${entry.background ?? ""}/${entry.colorMode ?? ""}/${entry.scale ?? ""}`)),
    completeness: oneChange("completeness", before.brand.completeness === undefined ? undefined : json(before.brand.completeness), after.brand.completeness === undefined ? undefined : json(after.brand.completeness)),
  });
  const bindings = Object.freeze({ records: changes(mapById(beforeBrand.bindings, (entry) => `${entry.family}/${entry.role}/${entry.variant}`), mapById(afterBrand.bindings, (entry) => `${entry.family}/${entry.role}/${entry.variant}`)) });
  const tokenRecords = changes(tokenMap(before.brand.tokensModel), tokenMap(after.brand.tokensModel));
  const recipeRecords = changes(recipeMap(before.brand.recipesModel), recipeMap(after.brand.recipesModel));
  const affectedTargets = [...new Set(recipeRecords.flatMap((entry) => {
    const values = [entry.before, entry.after].filter((value): value is { readonly [key: string]: JsonValue } => typeof value === "object" && value !== null && !Array.isArray(value));
    return values.flatMap((value) => typeof value.targetAsset === "string" ? [value.targetAsset] : []);
  }))].sort(compareUtf8);
  const recipes = Object.freeze({ records: recipeRecords, affectedTargets: Object.freeze(affectedTargets) });
  const derived = Object.freeze({ records: changes(derivedMap(before), derivedMap(after)) });
  const geometryRecords = changes(mapById([...before.assets.values()], (entry) => entry.id, geometry), mapById([...after.assets.values()], (entry) => entry.id, geometry));
  const geometrySection = Object.freeze({ records: geometryRecords, canonicalTypedGeometryChanged: geometryRecords.length > 0, equivalenceClaim: "none" as const });
  const beforeQa = qaMaps(before.brand.qaModel);
  const afterQa = qaMaps(after.brand.qaModel);
  const profileChanges = changes(beforeQa.profiles, afterQa.profiles);
  const caseChanges = changes(beforeQa.cases, afterQa.cases);
  const changedAssets = new Set([...bindings.records, ...geometryRecords, ...derived.records].map((entry) => entry.id));
  const authorityChanged = tokenRecords.length > 0 || recipeRecords.length > 0 || inventory.families.length > 0 || inventory.roles.length > 0 || inventory.variants.length > 0 || inventory.requirements.length > 0;
  const affectedCases = [...new Set([...(after.brand.qaModel?.cases ?? []), ...(before.brand.qaModel?.cases ?? [])].filter((qaCase) => caseChanges.some((entry) => entry.id === qaCase.id) || authorityChanged || ("asset" in qaCase && qaCase.asset !== undefined && changedAssets.has(qaCase.asset))).map((qaCase) => qaCase.id))].sort(compareUtf8);
  const qaImpact = Object.freeze({ profiles: profileChanges, cases: caseChanges, affectedCases: Object.freeze(affectedCases) });
  const packageChange = oneChange("package", packageValue(before), packageValue(after));
  const companionChanges = changes(companionMap(before), companionMap(after));
  const packageAndLegal = Object.freeze({ package: packageChange, companions: companionChanges, bundleRelevantChanged: packageChange !== null || companionChanges.length > 0 || before.digest !== after.digest });
  const beforeConsumer = domainState(before, "consumer_profiles"), afterConsumer = domainState(after, "consumer_profiles");
  const consumerRecords = changes(consumerProfileMap(before), consumerProfileMap(after));
  const consumerProfiles = Object.freeze({ beforeState: beforeConsumer, afterState: afterConsumer, status: beforeConsumer === "available" && afterConsumer === "available" ? "available" as const : "unavailable" as const, records: consumerRecords });
  const beforeExports = domainState(before, "exports"), afterExports = domainState(after, "exports");
  const exportRecords = changes(exportProfileMap(before), exportProfileMap(after));
  const exports = Object.freeze({ beforeState: beforeExports, afterState: afterExports, status: beforeExports === "available" && afterExports === "available" ? "available" as const : "unavailable" as const, records: exportRecords });
  const changed = before.digest !== after.digest || [inventory.families, inventory.roles, inventory.variants, inventory.requirements, bindings.records, tokenRecords, recipeRecords, derived.records, geometryRecords, profileChanges, caseChanges, companionChanges, consumerRecords, exportRecords].some((records) => records.length > 0) || inventory.completeness !== null || packageChange !== null || beforeConsumer !== afterConsumer || beforeExports !== afterExports;
  const withoutDigest: Omit<BrandDiffResult, "resultDigest"> = Object.freeze({ schema: BRAND_DIFF_SCHEMA, schemaVersion: BRAND_DIFF_SCHEMA_VERSION, beforeDigest: before.digest, afterDigest: after.digest, status: changed ? "changed" : "equal", inventory, bindings, tokens: Object.freeze({ records: tokenRecords }), recipes, derived, geometry: geometrySection, qaImpact, packageAndLegal, consumerProfiles, exports });
  const result = Object.freeze({ ...withoutDigest, resultDigest: computeBrandDiffResultDigest(withoutDigest) });
  if (Buffer.byteLength(encodeCanonicalJson(result), "utf8") > MAX_DIFF_BYTES) throw new Error("Brand diff result exceeds 16 MiB.");
  return result;
}

export function serializeBrandDiff(result: BrandDiffResult): string {
  const { resultDigest: _ignored, ...withoutDigest } = result;
  if (computeBrandDiffResultDigest(withoutDigest) !== result.resultDigest) throw new Error("Brand diff result digest is invalid.");
  const output = JSON.stringify(result, null, 2) + "\n";
  if (Buffer.byteLength(output, "utf8") > MAX_DIFF_BYTES) throw new Error("Brand diff JSON exceeds 16 MiB.");
  return output;
}

function html(value: string): string { return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;").replace(/[\u0000-\u001f\u007f]/gu, ""); }
const SECTION_ORDER = ["inventory", "bindings", "tokens", "recipes", "derived", "geometry", "qaImpact", "packageAndLegal", "consumerProfiles", "exports"] as const;

export function projectBrandDiffMarkdown(result: BrandDiffResult): string {
  const lines = ["# Brand semantic diff", "", `Status: **${result.status}**`, `Before: \`${result.beforeDigest}\``, `After: \`${result.afterDigest}\``, `Result: \`${result.resultDigest}\``, ""];
  for (const section of SECTION_ORDER) lines.push(`## ${section}`, "", "```json", JSON.stringify(result[section], null, 2).replace(/```/gu, "` ` `"), "```", "");
  const output = lines.join("\n");
  if (Buffer.byteLength(output, "utf8") > MAX_DIFF_BYTES) throw new Error("Brand diff Markdown exceeds 16 MiB.");
  return output;
}

export function projectBrandDiffHtml(result: BrandDiffResult): string {
  const sections = SECTION_ORDER.map((section) => `<section><h2>${section}</h2><pre>${html(JSON.stringify(result[section], null, 2))}</pre></section>`).join("");
  const output = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><title>Brand semantic diff</title><style>body{font-family:system-ui,sans-serif;max-width:72rem;margin:2rem auto;padding:0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #888;padding:1rem}</style></head><body><h1>Brand semantic diff</h1><p>Status: <strong>${result.status}</strong></p><p>Before: <code>${result.beforeDigest}</code><br>After: <code>${result.afterDigest}</code><br>Result: <code>${result.resultDigest}</code></p>${sections}</body></html>\n`;
  if (Buffer.byteLength(output, "utf8") > MAX_DIFF_BYTES) throw new Error("Brand diff HTML exceeds 16 MiB.");
  return output;
}
