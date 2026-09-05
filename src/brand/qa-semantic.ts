import type { Sha256Digest } from "../digests.js";
import { computeAssetSemanticDigest, computeSha256, computeSvgOutputDigest } from "../digests.js";
import { compareUtf8 } from "../provenance.js";
import type { AnyNormalizedAsset } from "../schema-dispatch.js";
import type { LoadedProject } from "../project.js";
import type { BrandBinding, BrandModel, BrandVariant } from "./brand-schema.js";
import type { DerivedAuthorityInspection } from "./derive.js";
import type { BrandDerivedReceipt } from "./derived-receipt.js";
import { parseBrandDerivedReceipt } from "./derived-receipt.js";
import { derivedReceiptPath, isBrandBaselinePath } from "./brand-files.js";
import { inspectDerivedAuthority } from "./derive.js";
import type { BrandRecipesModel } from "./recipes.js";
import type { BrandDimensionToken, BrandGradientToken, BrandTokensModel } from "./tokens.js";
import {
  BRAND_QA_MAX_EVALUATIONS_PER_PROFILE,
  BRAND_QA_MAX_TARGETS_PER_CASE,
  computeBrandQaDigest,
  isBrandQaVisualCase,
  type BrandQaBackground,
  type BrandQaCase,
  type BrandQaModel,
  type BrandQaProfile,
  type BrandQaSemanticCase,
  type BrandQaTargetSelector,
  type BrandQaVisualCase,
} from "./qa-schema.js";
import {
  BRAND_QA_RENDER_CONFIGURATION,
  compareBrandQaRasters,
  countBrandQaForbiddenEdgePixels,
  decodeBrandQaBaseline,
  measureBrandQaRaster,
  parseBrandQaBackgroundRgba,
  renderBrandQaRaster,
  validateBrandQaRendererDescriptor,
  type BrandQaRasterBudget,
  type BrandQaRendererCapability,
} from "./qa-capability.js";
import {
  createBrandQaResult,
  type BrandQaCaseResult,
  type BrandQaDiagnostic,
  type BrandQaEvaluationResult,
  type BrandQaJsonValue,
  type BrandQaResult,
  type BrandQaStatus,
  type BrandQaTargetIdentity,
} from "./qa-report.js";

export interface BrandQaExecutionContext {
  readonly brand: BrandModel;
  readonly qa: BrandQaModel;
  readonly brandSystemDigest: Sha256Digest;
  readonly assets: ReadonlyMap<string, AnyNormalizedAsset>;
  readonly canonicalSvgBytes: ReadonlyMap<string, Uint8Array>;
  readonly tokens?: BrandTokensModel;
  readonly recipes?: BrandRecipesModel;
  readonly derived?: DerivedAuthorityInspection;
  readonly derivedReceipts?: ReadonlyMap<string, BrandDerivedReceipt>;
  readonly baselineFiles?: ReadonlyMap<string, Uint8Array>;
  readonly renderer?: BrandQaRendererCapability;
  readonly completeness?: { readonly satisfied: boolean; readonly familyCount: number; readonly variantCount: number; readonly bindingCount: number; readonly requirementCount: number };
}

interface ResolvedTarget {
  readonly asset: AnyNormalizedAsset;
  readonly binding?: BrandBinding;
  readonly variant?: BrandVariant;
  readonly identity: BrandQaTargetIdentity;
}

function diagnostic(code: string, message: string, location?: string): BrandQaDiagnostic {
  return Object.freeze({ code, message, ...(location === undefined ? {} : { location }) });
}

function targetKey(target: ResolvedTarget): string {
  return [target.binding?.family ?? "", target.binding?.role ?? "", target.binding?.variant ?? "", target.asset.id].join("\u0000");
}

function resolveTargets(selector: BrandQaTargetSelector, context: BrandQaExecutionContext): readonly ResolvedTarget[] {
  if (selector.asset !== undefined) {
    const asset = context.assets.get(selector.asset);
    if (asset === undefined) throw new Error(`QA target asset '${selector.asset}' does not exist.`);
    return Object.freeze([{ asset, identity: Object.freeze({ assetId: asset.id }) }]);
  }
  const bindings = context.brand.bindings.filter((binding) => binding.family === selector.family && (selector.role === undefined || binding.role === selector.role) && (selector.variant === undefined || binding.variant === selector.variant));
  const variants = new Map(context.brand.variants.map((variant) => [`${variant.family}\u0000${variant.id}`, variant]));
  const targets = bindings.map((binding): ResolvedTarget => {
    const asset = context.assets.get(binding.asset);
    if (asset === undefined) throw new Error(`QA binding target '${binding.asset}' does not exist.`);
    const variant = variants.get(`${binding.family}\u0000${binding.variant}`);
    if (variant === undefined) throw new Error(`QA binding variant '${binding.variant}' does not exist.`);
    return Object.freeze({ asset, binding, variant, identity: Object.freeze({ assetId: asset.id, family: binding.family, role: binding.role, variant: binding.variant }) });
  });
  targets.sort((left, right) => compareUtf8(targetKey(left), targetKey(right)));
  if (targets.length === 0) throw new Error("QA selector resolved zero targets.");
  if (targets.length > BRAND_QA_MAX_TARGETS_PER_CASE) throw new Error(`QA selector resolves more than ${BRAND_QA_MAX_TARGETS_PER_CASE} targets.`);
  return Object.freeze(targets);
}

function caseStatus(evaluations: readonly BrandQaEvaluationResult[]): BrandQaStatus {
  if (evaluations.some((evaluation) => evaluation.status === "error")) return "error";
  if (evaluations.some((evaluation) => evaluation.status === "unavailable")) return "unavailable";
  if (evaluations.some((evaluation) => evaluation.status === "fail")) return "fail";
  if (evaluations.every((evaluation) => evaluation.status === "skipped")) return "skipped";
  return "pass";
}

function record(qaCase: BrandQaCase, capabilityRequired: boolean, evaluations: readonly BrandQaEvaluationResult[], measurements: Readonly<Record<string, BrandQaJsonValue>> = {}, diagnostics: readonly BrandQaDiagnostic[] = []): BrandQaCaseResult {
  return Object.freeze({ caseId: qaCase.id, kind: qaCase.kind, status: caseStatus(evaluations), capability: isBrandQaVisualCase(qaCase) ? "renderer" : "semantic-core-v1", capabilityRequired, measurements, diagnostics, evaluations });
}

function evaluation(target: BrandQaTargetIdentity, status: BrandQaStatus, measurements: Readonly<Record<string, BrandQaJsonValue>>, diagnostics: readonly BrandQaDiagnostic[] = [], visual?: { width: number; height: number; background: BrandQaBackground }): BrandQaEvaluationResult {
  return Object.freeze({ target, ...(visual === undefined ? {} : visual), status, measurements, diagnostics });
}

function accessibility(asset: AnyNormalizedAsset): { readonly mode: string; readonly title?: string; readonly description?: string; readonly titleId?: string; readonly descriptionId?: string } {
  const value = asset.svg.accessibility as unknown as Record<string, unknown>;
  return Object.freeze({ mode: String(value.mode), ...(typeof value.title === "string" ? { title: value.title } : {}), ...(typeof value.description === "string" ? { description: value.description } : {}), ...(typeof value.titleId === "string" ? { titleId: value.titleId } : {}), ...(typeof value.descriptionId === "string" ? { descriptionId: value.descriptionId } : {}) });
}

function countTypedSvg(asset: AnyNormalizedAsset): { elementCount: number; definitionCount: number } {
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
  return { elementCount, definitionCount };
}

function rgba(color: string, opacity = 1): string {
  const upper = color.toUpperCase();
  const rgb = upper.slice(0, 7);
  const sourceAlpha = upper.length === 9 ? Number.parseInt(upper.slice(7), 16) : 255;
  const alpha = Math.round(sourceAlpha * opacity).toString(16).toUpperCase().padStart(2, "0");
  return `${rgb}${alpha}`;
}

function gradientValue(asset: AnyNormalizedAsset, reference: string, opacity: number): string {
  const gradient = asset.svg.definitions.linearGradients.find((entry) => entry.id === reference);
  if (gradient === undefined) return `invalid-gradient:${reference}`;
  return JSON.stringify({
    type: "gradient",
    kind: "linear",
    units: gradient.units === "userSpaceOnUse" ? "user-space" : "object-bounding-box-millionth",
    x1: gradient.units === "userSpaceOnUse" ? gradient.x1 : Math.round(gradient.x1 * 1_000_000),
    y1: gradient.units === "userSpaceOnUse" ? gradient.y1 : Math.round(gradient.y1 * 1_000_000),
    x2: gradient.units === "userSpaceOnUse" ? gradient.x2 : Math.round(gradient.x2 * 1_000_000),
    y2: gradient.units === "userSpaceOnUse" ? gradient.y2 : Math.round(gradient.y2 * 1_000_000),
    stops: gradient.stops.map((stop) => ({ offset: Math.round(stop.offset * 1_000_000), color: rgba(stop.color, (stop.opacity ?? 1) * opacity) })),
  });
}

function tokenGradientValue(token: BrandGradientToken, tokens: BrandTokensModel): string {
  const colors = new Map(tokens.colors.map((entry) => [entry.id, entry.value]));
  return JSON.stringify({
    type: "gradient",
    kind: token.kind,
    units: token.units,
    x1: token.x1,
    y1: token.y1,
    x2: token.x2,
    y2: token.y2,
    stops: token.stops.map((stop) => ({ offset: stop.offset, color: stop.color ?? colors.get(stop.colorToken!) ?? `invalid-token:${stop.colorToken}` })),
  });
}

function paintValues(asset: AnyNormalizedAsset): readonly string[] {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return; }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    for (const channel of ["fill", "stroke"] as const) {
      const paint = record[channel];
      const channelOpacity = typeof record[`${channel}Opacity`] === "number" ? record[`${channel}Opacity`] as number : 1;
      const opacity = (typeof record.opacity === "number" ? record.opacity : 1) * channelOpacity;
      if (typeof paint === "string" && paint !== "none") values.push(rgba(paint, opacity));
      if (typeof paint === "object" && paint !== null) {
        const paintRecord = paint as Record<string, unknown>;
        if (paintRecord.type === "solid" && typeof paintRecord.color === "string") values.push(rgba(paintRecord.color, opacity));
        if (paintRecord.type === "linear-gradient" && typeof paintRecord.reference === "string") {
          values.push(gradientValue(asset, paintRecord.reference, opacity));
          if (typeof paintRecord.fallback === "string") values.push(rgba(paintRecord.fallback, opacity));
        }
        if (paintRecord.type === "currentColor") values.push("currentColor");
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === "fill" || key === "stroke" || key === "linearGradients") continue;
      visit(child);
    }
  };
  visit(asset.svg);
  return Object.freeze(values.sort(compareUtf8));
}

function semanticCase(qaCase: BrandQaSemanticCase, context: BrandQaExecutionContext): BrandQaCaseResult {
  if (qaCase.kind === "inventory") {
    const family = context.brand.families.find((entry) => entry.id === qaCase.family);
    if (family === undefined) return record(qaCase, false, [evaluation({ assetId: qaCase.family }, "fail", {}, [diagnostic("BRAND_QA_FAMILY_MISSING", `Family '${qaCase.family}' is missing.`)])]);
    const declared = new Set([...family.requiredRoles, ...family.optionalRoles, ...(context.brand.requirements ?? []).filter((entry) => entry.family === family.id).map((entry) => entry.role)]);
    const requested = qaCase.roles ?? [...declared].sort(compareUtf8);
    const missing = requested.filter((role) => !declared.has(role));
    const bindings = context.brand.bindings.filter((binding) => binding.family === family.id && requested.includes(binding.role));
    const unbound = requested.filter((role) => !bindings.some((binding) => binding.role === role));
    const triples = bindings.map((binding) => `${binding.family}/${binding.role}/${binding.variant}`);
    const duplicateTriples = triples.length - new Set(triples).size;
    const completenessSatisfied = context.completeness?.satisfied ?? true;
    const status = missing.length === 0 && unbound.length === 0 && duplicateTriples === 0 && completenessSatisfied ? "pass" : "fail";
    const diagnostics = [...missing.map((role) => diagnostic("BRAND_QA_ROLE_MISSING", `Requested role '${role}' is not declared.`)), ...unbound.map((role) => diagnostic("BRAND_QA_ROLE_UNBOUND", `Requested role '${role}' has no binding.`)), ...(completenessSatisfied ? [] : [diagnostic("BRAND_QA_COMPLETENESS", "Loaded brand completeness authority is unsatisfied.")])];
    return record(qaCase, false, [evaluation({ assetId: family.id }, status, { requestedRoles: requested.length, bindings: bindings.length, missingRoles: missing.length, unboundRoles: unbound.length, duplicateBindingTriples: duplicateTriples, completenessSatisfied }, diagnostics)], { families: 1, roles: requested.length, bindings: bindings.length });
  }
  if (qaCase.kind === "recipe") {
    const recipes = context.recipes?.recipes ?? [];
    const selected = qaCase.recipe === undefined ? recipes.filter((recipe) => context.brand.bindings.some((binding) => binding.family === qaCase.family && (binding.asset === recipe.source_asset || binding.asset === recipe.target_asset))) : recipes.filter((recipe) => recipe.id === qaCase.recipe);
    if (selected.length === 0) return record(qaCase, false, [evaluation({ assetId: qaCase.recipe ?? qaCase.family ?? "recipe" }, "fail", {}, [diagnostic("BRAND_QA_RECIPE_MISSING", "Recipe selector resolved zero recipes.")])]);
    const entries = new Map((context.derived?.entries ?? []).map((entry) => [entry.recipeId, entry]));
    const evaluations = selected.sort((a, b) => compareUtf8(a.id, b.id)).map((recipe) => {
      const authority = entries.get(recipe.id);
      const pass = authority?.state === "unchanged" || (!qaCase.verifyReceipts && authority !== undefined);
      return evaluation({ assetId: recipe.target_asset }, pass ? "pass" : "fail", { recipeId: recipe.id, sourceAssetId: recipe.source_asset, targetAssetId: recipe.target_asset, operationCount: recipe.operations.length, authorityState: authority?.state ?? "missing" }, pass ? [] : [diagnostic("BRAND_QA_RECIPE_AUTHORITY", `Recipe '${recipe.id}' derived authority is '${authority?.state ?? "missing"}'.`)]);
    });
    return record(qaCase, false, evaluations, { recipes: evaluations.length, verifyProvenance: qaCase.verifyProvenance, verifyReceipts: qaCase.verifyReceipts });
  }
  let targets: readonly ResolvedTarget[];
  try { targets = resolveTargets(qaCase, context); }
  catch (error) { return record(qaCase, false, [evaluation({ assetId: "unresolved" }, "error", {}, [diagnostic("BRAND_QA_TARGET_INVALID", error instanceof Error ? error.message : "Invalid QA target.")])]); }

  if (qaCase.kind === "accessibility") {
    const labels = targets.map((target) => accessibility(target.asset));
    const consistency = new Set(labels.map((label) => JSON.stringify({ mode: label.mode, title: label.title ?? null, description: label.description ?? null }))).size <= 1;
    const evaluations = targets.map((target, index) => {
      const label = labels[index]!;
      const labelledValid = label.mode !== "labelled" || (label.title !== undefined && label.title.length > 0 && label.titleId !== undefined && label.titleId.length > 0 && (label.description === undefined || label.descriptionId !== undefined));
      const decorativeValid = label.mode !== "decorative" || (label.title === undefined && label.description === undefined && label.titleId === undefined && label.descriptionId === undefined);
      const authority = context.derived?.entries.find((entry) => entry.targetAssetId === target.asset.id);
      const receipt = context.derivedReceipts?.get(target.asset.id);
      const receiptValid = authority === undefined || (authority.state === "unchanged" && receipt !== undefined && receipt.accessibilityResult.mode === label.mode);
      const pass = labelledValid && decorativeValid && receiptValid && (!qaCase.requireConsistentLabels || consistency);
      return evaluation(target.identity, pass ? "pass" : "fail", { mode: label.mode, hasTitle: label.title !== undefined, hasDescription: label.description !== undefined, derivedAuthority: authority?.state ?? "source", receiptAccessibilityVerified: authority === undefined || receiptValid }, pass ? [] : [diagnostic("BRAND_QA_ACCESSIBILITY", `Accessibility authority is inconsistent for '${target.asset.id}'.`)]);
    });
    return record(qaCase, false, evaluations, { targets: targets.length, consistentLabels: consistency });
  }

  if (qaCase.kind === "palette") {
    const tokens = context.tokens;
    const allTokens = [...(tokens?.colors ?? []), ...(tokens?.gradients ?? []), ...(tokens?.dimensions ?? []), ...(tokens?.opacities ?? [])];
    const allowed = qaCase.allowedTokens.map((id) => allTokens.find((token) => token.id === id));
    const unknown = qaCase.allowedTokens.filter((_id, index) => allowed[index] === undefined);
    const invalidTypes = allowed.filter((token) => token !== undefined && token.type !== "color" && token.type !== "gradient");
    const allowedPaints = new Set<string>();
    for (const token of allowed) {
      if (token?.type === "color") allowedPaints.add(token.value);
      if (token?.type === "gradient" && tokens !== undefined) allowedPaints.add(tokenGradientValue(token, tokens));
    }
    const evaluations = targets.map((target) => {
      const paints = paintValues(target.asset);
      const recipe = context.recipes?.recipes.find((entry) => entry.target_asset === target.asset.id);
      const usedRecipeTokens = recipe?.operations.flatMap((operation) => operation.operation === "replace-paint" ? [operation.replacement_token] : operation.operation === "monochrome" || operation.operation === "background-plate" ? [operation.color_token] : []) ?? [];
      const forbiddenRecipeTokens = usedRecipeTokens.filter((id) => !qaCase.allowedTokens.includes(id));
      const unmatched = qaCase.allowLiterals ? [] : paints.filter((paint) => !allowedPaints.has(paint));
      const pass = unknown.length === 0 && invalidTypes.length === 0 && forbiddenRecipeTokens.length === 0 && unmatched.length === 0;
      return evaluation(target.identity, pass ? "pass" : "fail", { paints: paints.length, unmatchedPaints: unmatched.length, recipeTokens: [...new Set(usedRecipeTokens)].sort(compareUtf8), forbiddenRecipeTokens: [...new Set(forbiddenRecipeTokens)].sort(compareUtf8) }, pass ? [] : [diagnostic("BRAND_QA_PALETTE", `Palette authority failed for '${target.asset.id}'.`)]);
    });
    return record(qaCase, false, evaluations, { allowedTokens: qaCase.allowedTokens.length, unknownTokens: unknown, typeMismatchedTokens: invalidTypes.map((token) => token!.id).sort(compareUtf8) });
  }

  if (qaCase.kind === "external-reference" || qaCase.kind === "embedded-content") {
    const evaluations = targets.map((target) => {
      const bytes = context.canonicalSvgBytes.get(target.asset.id);
      if (bytes === undefined) return evaluation(target.identity, "error", {}, [diagnostic("BRAND_QA_SVG_MISSING", `Canonical SVG bytes for '${target.asset.id}' are missing.`)]);
      const svg = Buffer.from(bytes).toString("utf8");
      const externalUrls = (svg.match(/(?:href|xlink:href|src)=["'](?:https?:|ftp:|file:|\/\/)|url\(["']?(?:https?:|ftp:|file:|\/\/)/giu) ?? []).length;
      const externalImages = (svg.match(/<image\b[^>]*(?:href|xlink:href)=["'](?:https?:|ftp:|file:|\/\/)/giu) ?? []).length;
      const externalUses = (svg.match(/<use\b[^>]*(?:href|xlink:href)=["'](?!#)/giu) ?? []).length;
      const externalStyles = (svg.match(/<link\b[^>]*(?:rel=["']stylesheet["']|type=["']text\/css["'])[^>]*(?:href=["'](?:https?:|ftp:|file:|\/\/)|href=["'][^"']+\.css)|@import\b/giu) ?? []).length;
      const externalFonts = (svg.match(/@font-face\b[^}]*url\(["']?(?:https?:|ftp:|file:|\/\/)|<link\b[^>]*fonts/giu) ?? []).length;
      const embeddedRasters = (svg.match(/data:image\//giu) ?? []).length;
      const embeddedFonts = (svg.match(/data:(?:font\/|application\/(?:font-|x-font-|vnd\.ms-fontobject|octet-stream;base64.*(?:woff|ttf|otf)))|@font-face\b[^}]*data:(?:font\/|application\/)/giu) ?? []).length;
      const pass = qaCase.kind === "external-reference"
        ? (!qaCase.forbidExternalUrls || externalUrls === 0) && (!qaCase.forbidExternalImages || externalImages === 0) && (!qaCase.forbidExternalUses || externalUses === 0) && (!qaCase.forbidExternalStyles || externalStyles === 0) && (!qaCase.forbidExternalFonts || externalFonts === 0)
        : (!qaCase.forbidEmbeddedRaster || embeddedRasters === 0) && (!qaCase.forbidEmbeddedFonts || embeddedFonts === 0);
      return evaluation(target.identity, pass ? "pass" : "fail", { externalUrls, externalImages, externalUses, externalStyles, externalFonts, embeddedRasters, embeddedFonts }, pass ? [] : [diagnostic(qaCase.kind === "external-reference" ? "BRAND_QA_EXTERNAL_REFERENCE" : "BRAND_QA_EMBEDDED_CONTENT", `Forbidden content exists in '${target.asset.id}'.`)]);
    });
    return record(qaCase, false, evaluations, { targets: targets.length });
  }

  const evaluations = targets.map((target) => {
    const canvas = target.asset.svg.canvas;
    const viewBox = canvas.viewBox;
    const viewBoxValid = Array.isArray(viewBox) && viewBox.length === 4 && viewBox.every((value) => Number.isFinite(value));
    const minimumWidth = target.variant?.minimumWidthPx;
    const minimumHeight = target.variant?.minimumHeightPx;
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    const minimumValid = !qaCase.enforceMinimumSize || ((minimumWidth === undefined || (canvasWidth !== undefined && canvasWidth >= minimumWidth)) && (minimumHeight === undefined || (canvasHeight !== undefined && canvasHeight >= minimumHeight)));
    const pass = (!qaCase.requireViewbox || viewBoxValid) && minimumValid;
    const { elementCount, definitionCount } = countTypedSvg(target.asset);
    return evaluation(target.identity, pass ? "pass" : "fail", { width: canvasWidth ?? null, height: canvasHeight ?? null, viewBox: viewBox as unknown as BrandQaJsonValue, viewBoxValid, minimumWidth: minimumWidth ?? null, minimumHeight: minimumHeight ?? null, elementCount, definitionCount }, pass ? [] : [diagnostic("BRAND_QA_CANVAS", `Canvas authority failed for '${target.asset.id}'.`)]);
  });
  return record(qaCase, false, evaluations, { targets: targets.length });
}

function resolveBackground(background: BrandQaBackground, tokens?: BrandTokensModel): readonly [number, number, number, number] | null {
  if (!background.startsWith("token:")) return parseBrandQaBackgroundRgba(background);
  const id = background.slice("token:".length);
  const token = tokens?.colors.find((entry) => entry.id === id);
  if (token === undefined) throw new Error(`Background token '${id}' is missing or is not a color token.`);
  return parseBrandQaBackgroundRgba(token.value as BrandQaBackground);
}

function unavailableVisual(qaCase: BrandQaVisualCase, profile: BrandQaProfile, context: BrandQaExecutionContext, message: string): BrandQaCaseResult {
  let targets: readonly ResolvedTarget[];
  try { targets = resolveTargets(qaCase, context); }
  catch (error) { return record(qaCase, profile.renderer === "required", [evaluation({ assetId: "unresolved" }, "error", {}, [diagnostic("BRAND_QA_TARGET_INVALID", error instanceof Error ? error.message : "Invalid target.")])]); }
  const evaluations = targets.flatMap((target) => qaCase.sizes.flatMap(([width, height]) => qaCase.backgrounds.map((background) => evaluation(target.identity, "unavailable", {}, [diagnostic("BRAND_QA_CAPABILITY_UNAVAILABLE", message)], { width, height, background }))));
  return record(qaCase, profile.renderer === "required", evaluations, { evaluations: evaluations.length }, [diagnostic("BRAND_QA_CAPABILITY_UNAVAILABLE", message)]);
}

async function visualCase(qaCase: BrandQaVisualCase, profile: BrandQaProfile, context: BrandQaExecutionContext, budget: BrandQaRasterBudget): Promise<BrandQaCaseResult> {
  const capability = context.renderer;
  if (capability === undefined) return unavailableVisual(qaCase, profile, context, "No renderer capability was provided.");
  if (qaCase.kind === "baseline") {
    try { validateBrandQaRendererDescriptor(capability.descriptor, { id: qaCase.rendererId, version: qaCase.rendererVersion, platformClaim: qaCase.platformClaim }); }
    catch (error) { return unavailableVisual(qaCase, profile, context, error instanceof Error ? error.message : "Renderer descriptor mismatch."); }
  }
  let targets: readonly ResolvedTarget[];
  try { targets = resolveTargets(qaCase, context); }
  catch (error) { return record(qaCase, profile.renderer === "required", [evaluation({ assetId: "unresolved" }, "error", {}, [diagnostic("BRAND_QA_TARGET_INVALID", error instanceof Error ? error.message : "Invalid target.")])]); }
  if (qaCase.kind === "baseline" && targets.length !== 1) return record(qaCase, profile.renderer === "required", [evaluation({ assetId: "unresolved" }, "error", {}, [diagnostic("BRAND_QA_BASELINE_MULTIPLICITY", "Baseline selector must resolve exactly one target.")])]);
  const evaluations: BrandQaEvaluationResult[] = [];
  for (const target of targets) for (const [width, height] of qaCase.sizes) for (const background of qaCase.backgrounds) {
    const visual = { width, height, background };
    try {
      const svgBytes = context.canonicalSvgBytes.get(target.asset.id);
      if (svgBytes === undefined) throw new Error(`Canonical SVG bytes for '${target.asset.id}' are missing.`);
      const svgDigest = computeSvgOutputDigest(Buffer.from(svgBytes).toString("utf8"));
      const backgroundRgba = resolveBackground(background, context.tokens);
      const raster = await renderBrandQaRaster(capability, { canonicalSvgBytes: svgBytes, svgDigest, width, height, background, backgroundRgba, configuration: BRAND_QA_RENDER_CONFIGURATION }, budget);
      if (qaCase.kind === "baseline") {
        const assetDigest = computeAssetSemanticDigest(target.asset);
        if (assetDigest !== qaCase.canonicalAssetDigest || svgDigest !== qaCase.svgDigest) throw new Error("Baseline input identity is stale.");
        const baseline = context.baselineFiles?.get(qaCase.baselinePath);
        if (baseline === undefined) throw new Error("Baseline PNG is missing.");
        if (computeSha256(baseline) !== qaCase.baselineDigest) throw new Error("Baseline PNG digest is stale or drifted.");
        const decoded = await decodeBrandQaBaseline(capability, baseline, width, height, budget);
        const difference = compareBrandQaRasters(decoded, raster);
        evaluations.push(evaluation(target.identity, difference.changedPixels === 0 ? "pass" : "fail", { changedPixels: difference.changedPixels, maximumChannelDelta: difference.maximumChannelDelta, changedBounds: difference.changedBounds === null ? null : { ...difference.changedBounds }, beforeDecodedPixelDigest: difference.beforeDecodedPixelDigest, afterDecodedPixelDigest: difference.afterDecodedPixelDigest, beforePngDigest: difference.beforePngDigest ?? null, afterPngDigest: difference.afterPngDigest ?? null, claim: difference.changedPixels === 0 ? "pixel-equal-for-this-renderer-and-case-only" : "pixel-different-for-this-renderer-and-case-only", baselinePath: qaCase.baselinePath, baselineDigest: qaCase.baselineDigest }, difference.changedPixels === 0 ? [] : [diagnostic("BRAND_QA_BASELINE_DIFFERENT", "Rendered pixels differ from the owner-approved baseline.")], visual));
        continue;
      }
      const alphaOnly = qaCase.kind === "transparent-bounds";
      const alphaThreshold = qaCase.kind === "pixel-bounds" || qaCase.kind === "transparent-bounds" ? qaCase.alphaThreshold : 0;
      const measured = measureBrandQaRaster(raster, backgroundRgba, alphaThreshold, alphaOnly);
      let pass = measured.visiblePixels > 0;
      const metrics: Record<string, BrandQaJsonValue> = { bounds: measured.bounds === null ? null : { ...measured.bounds }, visiblePixels: measured.visiblePixels, topPadding: measured.topPadding, rightPadding: measured.rightPadding, bottomPadding: measured.bottomPadding, leftPadding: measured.leftPadding };
      if (qaCase.kind === "clipping") {
        const edgePixels = countBrandQaForbiddenEdgePixels(raster, backgroundRgba, qaCase.forbiddenEdgePixels);
        metrics.edgePixels = edgePixels; pass = edgePixels === 0;
      } else if (qaCase.kind === "visible-padding") {
        let minimum = qaCase.minimumPaddingPx;
        if (qaCase.minimumPaddingRatio !== undefined) minimum = Math.ceil(Math.min(width, height) * qaCase.minimumPaddingRatio / 1_000_000);
        if (qaCase.minimumPaddingToken !== undefined) {
          const token: BrandDimensionToken | undefined = context.tokens?.dimensions.find((entry) => entry.id === qaCase.minimumPaddingToken);
          if (token === undefined) throw new Error(`Padding token '${qaCase.minimumPaddingToken}' is missing or is not a dimension token.`);
          if (token.unit === "px") minimum = token.value;
          else if (token.unit === "percent-millionth") minimum = Math.ceil(Math.min(width, height) * token.value / 1_000_000);
          else {
            const viewBox = target.asset.svg.canvas.viewBox;
            const fitScale = Math.min(width / Math.abs(viewBox[2]!), height / Math.abs(viewBox[3]!));
            minimum = Math.ceil(token.value / 1_000_000 * fitScale);
          }
        }
        metrics.minimumPadding = minimum ?? 0;
        pass = measured.visiblePixels > 0 && [measured.topPadding, measured.rightPadding, measured.bottomPadding, measured.leftPadding].every((value) => value >= (minimum ?? 0));
      } else if (qaCase.kind === "small-size-visibility") {
        const minimum = qaCase.minimumVisiblePixels ?? Math.ceil(width * height * (qaCase.minimumVisibleRatio ?? 0) / 1_000_000);
        metrics.minimumVisiblePixels = minimum; pass = measured.visiblePixels >= minimum;
      }
      evaluations.push(evaluation(target.identity, pass ? "pass" : "fail", metrics, pass ? [] : [diagnostic("BRAND_QA_VISUAL_ASSERTION", `Visual assertion '${qaCase.kind}' failed.`)], visual));
    } catch (error) {
      evaluations.push(evaluation(target.identity, "error", {}, [diagnostic("BRAND_QA_RENDERER_ERROR", error instanceof Error ? error.message : "Renderer failure.")], visual));
    }
  }
  return record(qaCase, profile.renderer === "required", evaluations, { evaluations: evaluations.length, targets: targets.length, decodedRgbaBytes: budget.decodedRgbaBytes });
}

export async function runBrandQaProfile(context: BrandQaExecutionContext, profileId: string): Promise<BrandQaResult> {
  const profile = context.qa.profiles.find((entry) => entry.id === profileId);
  if (profile === undefined) throw new Error(`Unknown QA profile '${profileId}'.`);
  const selected = profile.cases.map((id) => context.qa.cases.find((entry) => entry.id === id)! ).sort((a, b) => compareUtf8(a.id, b.id));
  let evaluationCount = 0;
  for (const qaCase of selected) {
    try {
      if (isBrandQaVisualCase(qaCase)) {
        const targets = resolveTargets(qaCase, context);
        evaluationCount += targets.length * qaCase.sizes.length * qaCase.backgrounds.length;
      } else if (qaCase.kind === "inventory") evaluationCount++;
      else if (qaCase.kind === "recipe") evaluationCount += Math.max(1, context.recipes?.recipes.length ?? 0);
      else evaluationCount += resolveTargets(qaCase, context).length;
    } catch {
      evaluationCount += 1;
    }
    if (evaluationCount > BRAND_QA_MAX_EVALUATIONS_PER_PROFILE) throw new Error(`QA profile resolves more than ${BRAND_QA_MAX_EVALUATIONS_PER_PROFILE} evaluations.`);
  }
  const budget: BrandQaRasterBudget = { decodedRgbaBytes: 0 };
  const rendererDescriptor = context.renderer === undefined ? undefined : validateBrandQaRendererDescriptor(context.renderer.descriptor);
  const results: BrandQaCaseResult[] = [];
  for (const qaCase of selected) results.push(isBrandQaVisualCase(qaCase) ? await visualCase(qaCase, profile, context, budget) : semanticCase(qaCase, context));
  if (rendererDescriptor !== undefined && JSON.stringify(validateBrandQaRendererDescriptor(context.renderer!.descriptor)) !== JSON.stringify(rendererDescriptor)) throw new Error("Renderer descriptor changed during QA execution.");
  return createBrandQaResult({ profileId, qaDigest: computeBrandQaDigest(context.qa), brandSystemDigest: context.brandSystemDigest, ...(rendererDescriptor === undefined ? {} : { renderer: rendererDescriptor }), results, selectedCaseIds: selected.map((entry) => entry.id) });
}

export function runBrandQaSemanticProfile(context: Omit<BrandQaExecutionContext, "renderer">, profileId: string): Promise<BrandQaResult> {
  return runBrandQaProfile(context, profileId);
}

export async function runLoadedBrandQaProfile(project: LoadedProject, profileId: string, renderer?: BrandQaRendererCapability): Promise<BrandQaResult> {
  if (project.brand?.qaModel === undefined || project.brand.brandSystemDigest === undefined) throw new Error("The project does not have an available QA domain.");
  const canonicalSvgBytes = new Map<string, Uint8Array>();
  for (const asset of project.assets) {
    const bytes = project.outputs.get(asset.filename);
    if (bytes === undefined) throw new Error(`Canonical SVG output for '${asset.id}' is unavailable.`);
    canonicalSvgBytes.set(asset.id, bytes);
  }
  const derived = project.brand.recipesModel === undefined ? undefined : inspectDerivedAuthority(project.snapshot.files, { operation: "check", domain: "brand" });
  const derivedReceipts = new Map<string, BrandDerivedReceipt>();
  for (const asset of project.assets) {
    const path = derivedReceiptPath(asset.id);
    const entry = project.snapshot.files.get(path);
    if (entry === undefined) continue;
    const parsed = parseBrandDerivedReceipt(new TextDecoder("utf8", { fatal: true }).decode(entry.bytes), path);
    if (!parsed.ok) throw new Error(`Derived receipt '${path}' is invalid.`);
    derivedReceipts.set(asset.id, parsed.value);
  }
  const baselineFiles = new Map<string, Uint8Array>();
  for (const [path, entry] of project.snapshot.files) if (isBrandBaselinePath(path)) baselineFiles.set(path, entry.bytes);
  return runBrandQaProfile({ brand: project.brand.model, qa: project.brand.qaModel, brandSystemDigest: project.brand.brandSystemDigest, assets: new Map(project.assets.map((asset) => [asset.id, asset])), canonicalSvgBytes, completeness: project.brand.completeness, ...(project.brand.tokensModel === undefined ? {} : { tokens: project.brand.tokensModel }), ...(project.brand.recipesModel === undefined ? {} : { recipes: project.brand.recipesModel }), ...(derived === undefined ? {} : { derived }), derivedReceipts, baselineFiles, ...(renderer === undefined ? {} : { renderer }) }, profileId);
}
