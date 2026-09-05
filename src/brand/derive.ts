import { fail, fromCaught, ok, type DiagnosticContext } from "../diagnostics.js";
import { computeAssetSemanticDigest, computeSha256, computeSvgOutputDigest, type Sha256Digest } from "../digests.js";
import { opendir, lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import { readRegularFileSnapshot } from "../filesystem.js";
import { parseLocalId } from "../primitives.js";
import { compareUtf8 } from "../provenance.js";
import { inspectPlanRetention, type PlanRetentionInspection } from "../plan-retention.js";
import { parseAssetTomlV2, serializeAssetTomlV2 } from "../schema2-toml.js";
import { parseProjectTomlVersioned } from "../schema-dispatch.js";
import { serializeSvgV2 } from "../schema2-svg.js";
import type {
  ArtworkElementV2,
  GroupSpecV2,
  NormalizedAssetV2,
  PaintV2,
  PathSpecV2,
  RectSpecV2,
  SvgDocumentV2,
} from "../schema2-types.js";
import {
  executeCanonicalTransaction,
  snapshotCanonicalTree,
  snapshotsEqual,
  type CanonicalFileSnapshot,
  type CanonicalSnapshot,
  type TransactionHooks,
} from "../transaction.js";
import type { AssetId, HexColor, LinearGradient, LocalId, Result, SvgFilename } from "../types.js";
import { TOOL_VERSION } from "../version.js";
import { discoverBrandState } from "./brand-availability.js";
import { loadBrandProject } from "./brand-core.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import {
  BRAND_DERIVED_RECEIPT_DIR,
  derivedReceiptPath,
  isDerivedReceiptPath,
} from "./brand-files.js";
import {
  createBrandDerivedReceipt,
  parseBrandDerivedReceipt,
  serializeBrandDerivedReceipt,
  toDerivedReceiptPreimageDto,
  DERIVED_RECEIPT_MAX_BYTES,
  DERIVED_RECEIPT_MAX_COUNT,
  type BrandDerivedReceipt,
  type DerivedReceiptSourceRecord,
  type DerivedReceiptUsedToken,
} from "./derived-receipt.js";
import {
  buildRecipeGraph,
  computeBrandRecipesDigest,
  computeBrandRecipeDefinitionDigest,
  computeBrandRecipeOperationsDigest,
  parseBrandRecipesToml,
  toBrandRecipeOperationsCanonicalDto,
  type BrandRecipe,
  type BrandRecipeOperation,
  type BrandRecipesModel,
} from "./recipes.js";
import {
  computeBrandTokensDigest,
  canonicalUsedTokenValue,
  findUnusedTokens,
  parseBrandTokensToml,
  type BrandColorToken,
  type BrandGradientToken,
  type BrandTokensModel,
} from "./tokens.js";

export interface BrandDeriveOptions {
  readonly root?: string;
  readonly all?: boolean;
  readonly recipes?: readonly string[];
  readonly dryRun?: boolean;
}

export interface BrandDeriveTargetSummary {
  readonly targetAssetId: string;
  readonly recipeId: string;
  readonly state: "create" | "update" | "unchanged";
  readonly oldDigest?: string;
  readonly newDigest: string;
  readonly newSvgDigest: string;
}

export interface BrandDeriveOperationSummary {
  readonly recipeId: string;
  readonly targetAssetId: string;
  readonly operations: readonly string[];
}

export interface BrandDerivePlan {
  readonly selectedRecipes: readonly string[];
  readonly transitiveRecipes: readonly string[];
  readonly affectedTargets: readonly string[];
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly unchangedCount: number;
  readonly operationSummaries: readonly BrandDeriveOperationSummary[];
  readonly targetStates: readonly BrandDeriveTargetSummary[];
  readonly tokenDigest: Sha256Digest;
  readonly recipeDigest: Sha256Digest;
  readonly warnings: readonly string[];
  readonly dryRun: boolean;
  readonly [derivePlanBrand]: true;
}

export interface BrandDeriveResult extends BrandDerivePlan {
  readonly written: boolean;
  readonly targetsWritten: readonly string[];
  readonly receiptsWritten: readonly string[];
}

export type DerivedAuthorityState =
  | "unchanged"
  | "stale-authority"
  | "missing-target"
  | "human-owned"
  | "target-drift"
  | "invalid-receipt"
  | "ownership-conflict";

export interface DerivedAuthorityEntry {
  readonly targetAssetId: string;
  readonly recipeId?: string;
  readonly state: DerivedAuthorityState;
  readonly receiptDigest?: Sha256Digest;
  readonly targetModelDigest?: Sha256Digest;
  readonly targetSvgDigest?: Sha256Digest;
}

export interface DerivedAuthorityInspection {
  readonly entries: readonly DerivedAuthorityEntry[];
  readonly counts: Readonly<Record<DerivedAuthorityState, number>>;
}

interface DerivedFileView {
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
}

interface InternalDerivePlanState {
  readonly root: string;
  readonly dryRun: boolean;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly snapshot: CanonicalSnapshot;
  readonly nextFiles: ReadonlyMap<string, Uint8Array>;
  readonly targetsWritten: readonly string[];
  readonly receiptsWritten: readonly string[];
  readonly semanticSummary: string;
  executed: boolean;
}

const derivePlanBrand: unique symbol = Symbol("tfsb-brand-derive-plan");
const derivePlanInternals = new WeakMap<BrandDerivePlan, InternalDerivePlanState>();

function context(source?: string): DiagnosticContext {
  return { operation: "build", domain: "brand", ...(source === undefined ? {} : { source }) };
}

function deepCloneSvg(svg: SvgDocumentV2): SvgDocumentV2 {
  return JSON.parse(JSON.stringify(svg));
}

function deepFreezeJson<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  return Object.freeze(value);
}

function splitRgba(value: string): { readonly color: HexColor; readonly opacity: number } {
  const rgba = value.length === 7 ? value.toUpperCase() + "FF" : value.toUpperCase();
  return {
    color: rgba.slice(0, 7) as HexColor,
    opacity: Number.parseInt(rgba.slice(7, 9), 16) / 255,
  };
}

function matchesGradient(paint: PaintV2 | undefined, gradientId: string): boolean {
  if (paint === undefined || paint.type !== "linear-gradient") return false;
  return paint.reference === gradientId;
}

type MutablePaintBearing = {
  fill?: PaintV2;
  stroke?: PaintV2;
  fillOpacity?: number;
  strokeOpacity?: number;
};

function visitPaintBearing(svg: SvgDocumentV2, visitor: (value: MutablePaintBearing) => void): void {
  visitor(svg.presentation as MutablePaintBearing);
  const visitElement = (element: ArtworkElementV2): void => {
    visitor(element as MutablePaintBearing);
    if (element.type === "group") for (const child of element.children) visitElement(child);
  };
  for (const element of svg.elements) visitElement(element);
  for (const group of svg.definitions.groups) visitElement(group);
  for (const collection of [
    svg.definitions.paths,
    svg.definitions.circles,
    svg.definitions.ellipses,
    svg.definitions.rects,
    svg.definitions.lines,
    svg.definitions.polylines,
    svg.definitions.polygons,
  ]) for (const definition of collection) visitor(definition as MutablePaintBearing);
}

function channelOpacity(value: MutablePaintBearing, channel: "fill" | "stroke"): number {
  return (channel === "fill" ? value.fillOpacity : value.strokeOpacity) ?? 1;
}

function matchesColor(value: MutablePaintBearing, channel: "fill" | "stroke", targetHex: string): boolean {
  const paint = channel === "fill" ? value.fill : value.stroke;
  if (paint === undefined || paint.type !== "solid") return false;
  const expected = splitRgba(targetHex);
  return paint.color.toUpperCase() === expected.color && channelOpacity(value, channel) === expected.opacity;
}

function setChannelPaint(value: MutablePaintBearing, channel: "fill" | "stroke", paint: PaintV2, opacity: number): void {
  if (channel === "fill") {
    value.fill = paint;
    if (opacity === 1) delete value.fillOpacity;
    else value.fillOpacity = opacity;
  } else {
    value.stroke = paint;
    if (opacity === 1) delete value.strokeOpacity;
    else value.strokeOpacity = opacity;
  }
}

function collectLocalIds(svg: SvgDocumentV2): Set<string> {
  const ids = new Set<string>();
  if (svg.accessibility.mode === "labelled") {
    ids.add(svg.accessibility.titleId);
    if (svg.accessibility.descriptionId !== undefined) ids.add(svg.accessibility.descriptionId);
  }
  const visitElement = (element: ArtworkElementV2): void => {
    if (element.id !== undefined) ids.add(element.id);
    if (element.type === "group") for (const child of element.children) visitElement(child);
  };
  for (const element of svg.elements) visitElement(element);
  for (const group of svg.definitions.groups) visitElement(group);
  for (const gradient of svg.definitions.linearGradients) ids.add(gradient.id);
  for (const collection of [svg.definitions.paths, svg.definitions.circles, svg.definitions.ellipses, svg.definitions.rects, svg.definitions.lines, svg.definitions.polylines, svg.definitions.polygons]) {
    for (const definition of collection) ids.add(definition.id);
  }
  return ids;
}

function countAndReplacePaint(
  svg: SvgDocumentV2,
  channel: "fill" | "stroke" | "gradient-stop",
  sourceColor: string | undefined,
  sourceGradient: string | undefined,
  replacementPaint: PaintV2,
  replacementColor: { readonly color: HexColor; readonly opacity: number } | undefined,
): number {
  let count = 0;
  if (channel === "fill" || channel === "stroke") {
    visitPaintBearing(svg, (value) => {
      const paint = channel === "fill" ? value.fill : value.stroke;
      if ((sourceColor !== undefined && matchesColor(value, channel, sourceColor)) ||
          (sourceGradient !== undefined && matchesGradient(paint, sourceGradient))) {
        count++;
        setChannelPaint(value, channel, replacementPaint, replacementColor?.opacity ?? 1);
      }
    });
  } else if (channel === "gradient-stop") {
    if (sourceColor !== undefined && replacementColor !== undefined) {
      const source = splitRgba(sourceColor);
      for (const grad of svg.definitions.linearGradients) {
        for (const stop of grad.stops) {
          if (stop.color.toUpperCase() === source.color && (stop.opacity ?? 1) === source.opacity) {
            count++;
            (stop as { color: HexColor; opacity?: number }).color = replacementColor.color;
            if (replacementColor.opacity === 1) delete (stop as { opacity?: number }).opacity;
            else (stop as { opacity?: number }).opacity = replacementColor.opacity;
          }
        }
      }
    }
  }

  return count;
}

function countAndApplyMonochrome(
  svg: SvgDocumentV2,
  channels: readonly ("fill" | "stroke")[],
  replacementPaint: PaintV2,
  replacementOpacity: number,
): number {
  let count = 0;

  const replaceIfPainted = (obj: MutablePaintBearing): void => {
    if (channels.includes("fill") && obj.fill !== undefined && obj.fill.type !== "none") {
      count++;
      setChannelPaint(obj, "fill", replacementPaint, replacementOpacity);
    }
    if (channels.includes("stroke") && obj.stroke !== undefined && obj.stroke.type !== "none") {
      count++;
      setChannelPaint(obj, "stroke", replacementPaint, replacementOpacity);
    }
  };

  visitPaintBearing(svg, replaceIfPainted);

  return count;
}

export function applyRecipeOperations(
  recipe: BrandRecipe,
  sourceAsset: NormalizedAssetV2,
  tokens: BrandTokensModel,
  ctx: DiagnosticContext,
): {
  readonly targetAsset: NormalizedAssetV2;
  readonly usedTokens: readonly DerivedReceiptUsedToken[];
} {
  const targetSvg = deepCloneSvg(sourceAsset.svg);
  delete (targetSvg as { metadataText?: string }).metadataText;
  const usedTokensMap = new Map<string, DerivedReceiptUsedToken>();

  const colorTokensMap = new Map<string, BrandColorToken>();
  for (const c of tokens.colors) colorTokensMap.set(c.id, c);

  const gradientTokensMap = new Map<string, BrandGradientToken>();
  for (const g of tokens.gradients) gradientTokensMap.set(g.id, g);
  const localIds = collectLocalIds(targetSvg);
  const generatedGradients = new Map<string, LocalId>();

  for (const op of recipe.operations) {
    if (op.operation === "replace-paint") {
      if (op.source_color !== undefined) {
        const colorTok = colorTokensMap.get(op.replacement_token);
        if (colorTok === undefined) {
          fail(ctx, "BRAND_TOKEN_NOT_FOUND", "Color token '" + op.replacement_token + "' not found in tokens.", recipe.id);
        }
        usedTokensMap.set(colorTok.id, { id: colorTok.id, type: "color", canonicalValue: canonicalUsedTokenValue(colorTok, tokens) });
        const replacementColor = splitRgba(colorTok.value);
        const replacementPaint: PaintV2 = { type: "solid", color: replacementColor.color };

        const matched = countAndReplacePaint(targetSvg, op.channel, op.source_color, undefined, replacementPaint, replacementColor);
        if (matched !== op.expected_occurrences) {
          fail(
            ctx,
            "BRAND_RECIPE_OCCURRENCE_MISMATCH",
            "Recipe '" + recipe.id + "' replace-paint expected " + op.expected_occurrences + " occurrences, found " + matched + ".",
            recipe.id,
          );
        }
      } else if (op.source_gradient !== undefined) {
        const gradTok = gradientTokensMap.get(op.replacement_token);
        if (gradTok === undefined) {
          fail(ctx, "BRAND_TOKEN_NOT_FOUND", "Gradient token '" + op.replacement_token + "' not found in tokens.", recipe.id);
        }
        usedTokensMap.set(gradTok.id, { id: gradTok.id, type: "gradient", canonicalValue: canonicalUsedTokenValue(gradTok, tokens) });

        let gradId = generatedGradients.get(gradTok.id);
        if (gradId === undefined) {
          gradId = parseLocalId("tfsb-" + recipe.id + "-" + gradTok.id + "-grad", ctx, recipe.id + ".generated-gradient-id");
          if (localIds.has(gradId)) {
            fail(ctx, "BRAND_RECIPE_ID_COLLISION", "Generated gradient id '" + gradId + "' collides with an existing local id.", recipe.id);
          }
        }
        const stops = gradTok.stops.map((stop) => {
          let stopColorValue: string;
          if (stop.colorToken !== undefined) {
            const stopTok = colorTokensMap.get(stop.colorToken);
            if (stopTok === undefined) {
              fail(ctx, "BRAND_TOKEN_NOT_FOUND", "Gradient stop color token '" + stop.colorToken + "' not found.", gradTok.id);
            }
            usedTokensMap.set(stopTok.id, { id: stopTok.id, type: "color", canonicalValue: canonicalUsedTokenValue(stopTok, tokens) });
            stopColorValue = stopTok.value;
          } else {
            stopColorValue = stop.color!;
          }
          const stopColor = splitRgba(stopColorValue);
          return {
            offset: stop.offset / 1000000,
            color: stopColor.color,
            ...(stopColor.opacity === 1 ? {} : { opacity: stopColor.opacity }),
          };
        });

        if (!generatedGradients.has(gradTok.id)) {
          const coordinate = (value: number): number => gradTok.units === "object-bounding-box-millionth" ? value / 1000000 : value;
          const newGrad: LinearGradient = {
            id: gradId,
            x1: coordinate(gradTok.x1),
            y1: coordinate(gradTok.y1),
            x2: coordinate(gradTok.x2),
            y2: coordinate(gradTok.y2),
            ...(gradTok.units === "user-space" ? { units: "userSpaceOnUse" as const } : {}),
            stops,
          };
          (targetSvg.definitions.linearGradients as LinearGradient[]).push(newGrad);
          generatedGradients.set(gradTok.id, gradId);
          localIds.add(gradId);
        }

        const replacementPaint: PaintV2 = { type: "linear-gradient", reference: gradId };
        const matched = countAndReplacePaint(targetSvg, op.channel, undefined, op.source_gradient, replacementPaint, undefined);
        if (matched !== op.expected_occurrences) {
          fail(
            ctx,
            "BRAND_RECIPE_OCCURRENCE_MISMATCH",
            "Recipe '" + recipe.id + "' replace-paint expected " + op.expected_occurrences + " occurrences, found " + matched + ".",
            recipe.id,
          );
        }
      }
    } else if (op.operation === "monochrome") {
      const colorTok = colorTokensMap.get(op.color_token);
      if (colorTok === undefined) {
        fail(ctx, "BRAND_TOKEN_NOT_FOUND", "Color token '" + op.color_token + "' not found in tokens.", recipe.id);
      }
      usedTokensMap.set(colorTok.id, { id: colorTok.id, type: "color", canonicalValue: canonicalUsedTokenValue(colorTok, tokens) });
      const replacementColor = splitRgba(colorTok.value);
      const replacementPaint: PaintV2 = { type: "solid", color: replacementColor.color };

      const matched = countAndApplyMonochrome(targetSvg, op.channels, replacementPaint, replacementColor.opacity);
      if (matched !== op.expected_occurrences) {
        fail(
          ctx,
          "BRAND_RECIPE_OCCURRENCE_MISMATCH",
          "Recipe '" + recipe.id + "' monochrome expected " + op.expected_occurrences + " occurrences, found " + matched + ".",
          recipe.id,
        );
      }
    } else if (op.operation === "remove-group") {
      const matches: { owner: ArtworkElementV2[]; index: number }[] = [];
      const scan = (owner: ArtworkElementV2[]): void => {
        for (let index = 0; index < owner.length; index++) {
          const element = owner[index]!;
          if (element.type !== "group") continue;
          if (element.id === op.group_id) matches.push({ owner, index });
          scan(element.children as ArtworkElementV2[]);
        }
      };
      scan(targetSvg.elements as ArtworkElementV2[]);
      scan(targetSvg.definitions.groups as ArtworkElementV2[]);
      if (matches.length !== 1) {
        fail(ctx, matches.length === 0 ? "BRAND_RECIPE_GROUP_NOT_FOUND" : "BRAND_RECIPE_GROUP_NOT_UNIQUE", "Group '" + op.group_id + "' must match exactly once; found " + matches.length + ".", recipe.id);
      }
      matches[0]!.owner.splice(matches[0]!.index, 1);
    } else if (op.operation === "retain-groups") {
      const beforeCount = targetSvg.elements.filter((e) => e.type === "group").length;
      if (beforeCount !== op.expected_before_count) {
        fail(
          ctx,
          "BRAND_RECIPE_COUNT_MISMATCH",
          "Recipe '" + recipe.id + "' retain-groups expected before count " + op.expected_before_count + ", found " + beforeCount + ".",
          recipe.id,
        );
      }

      for (const groupId of op.group_ids) {
        const matches = targetSvg.elements.filter((element) => element.type === "group" && element.id === groupId).length;
        if (matches !== 1) {
          fail(ctx, "BRAND_RECIPE_GROUP_NOT_UNIQUE", "Top-level group '" + groupId + "' must exist exactly once; found " + matches + ".", recipe.id);
        }
      }
      const retainSet = new Set(op.group_ids);
      const remainingElements = targetSvg.elements.filter((e) => e.type !== "group" || (e.id !== undefined && retainSet.has(e.id)));
      (targetSvg as any).elements = remainingElements;

      const afterCount = remainingElements.filter((e) => e.type === "group").length;
      if (afterCount !== op.expected_after_count) {
        fail(
          ctx,
          "BRAND_RECIPE_COUNT_MISMATCH",
          "Recipe '" + recipe.id + "' retain-groups expected after count " + op.expected_after_count + ", found " + afterCount + ".",
          recipe.id,
        );
      }
    } else if (op.operation === "background-plate") {
      const colorTok = colorTokensMap.get(op.color_token);
      if (colorTok === undefined) {
        fail(ctx, "BRAND_TOKEN_NOT_FOUND", "Color token '" + op.color_token + "' not found in tokens.", recipe.id);
      }
      usedTokensMap.set(colorTok.id, { id: colorTok.id, type: "color", canonicalValue: canonicalUsedTokenValue(colorTok, tokens) });
      const plateColor = splitRgba(colorTok.value);
      const elementId = parseLocalId(op.element_id, ctx, recipe.id + ".background-plate.element-id");
      if (localIds.has(elementId)) {
        fail(ctx, "BRAND_RECIPE_ID_COLLISION", "Background plate id '" + elementId + "' collides with an existing local id.", recipe.id);
      }

      const [viewX, viewY, viewWidth, viewHeight] = targetSvg.canvas.viewBox;
      const x = op.x ?? viewX;
      const y = op.y ?? viewY;
      const width = op.width ?? viewWidth;
      const height = op.height ?? viewHeight;
      if (width <= 0 || height <= 0) {
        fail(ctx, "BRAND_RECIPE_INVALID_GEOMETRY", "Background plate width and height must be positive.", recipe.id);
      }
      if (op.corner_radius !== undefined && op.corner_radius > Math.min(width, height) / 2) {
        fail(ctx, "BRAND_RECIPE_INVALID_GEOMETRY", "Background plate corner radius exceeds half the smaller dimension.", recipe.id);
      }

      const plate: RectSpecV2 = {
        type: "rect",
        id: elementId,
        x,
        y,
        width,
        height,
        ...(op.corner_radius === undefined ? {} : { cornerRadius: op.corner_radius }),
        fill: { type: "solid", color: plateColor.color },
        ...(plateColor.opacity === 1 ? {} : { fillOpacity: plateColor.opacity }),
      };

      (targetSvg as any).elements = [plate, ...targetSvg.elements];
      localIds.add(elementId);
    } else if (op.operation === "resize-canvas") {
      (targetSvg as any).canvas = {
        ...targetSvg.canvas,
        width: op.width,
        height: op.height,
        viewBox: [...op.view_box] as [number, number, number, number],
      };
    } else if (op.operation === "copy-accessibility") {
      if (op.policy === "preserve") {
        if (targetSvg.accessibility.mode === "labelled") {
          const currentTitleId = targetSvg.accessibility.titleId;
          const currentDescriptionId = targetSvg.accessibility.descriptionId;
          const titleId = parseLocalId("tfsb-" + recipe.target_asset + "-title", ctx, recipe.id + ".accessibility.title-id");
          const descriptionId = targetSvg.accessibility.descriptionId === undefined
            ? undefined
            : parseLocalId("tfsb-" + recipe.target_asset + "-description", ctx, recipe.id + ".accessibility.description-id");
          for (const generatedId of [titleId, descriptionId]) {
            if (
              generatedId !== undefined &&
              generatedId !== currentTitleId &&
              generatedId !== currentDescriptionId &&
              localIds.has(generatedId)
            ) {
              fail(ctx, "BRAND_RECIPE_ID_COLLISION", "Generated accessibility id '" + generatedId + "' collides with an existing local id.", recipe.id);
            }
          }
          (targetSvg as any).accessibility = {
            ...targetSvg.accessibility,
            titleId,
            ...(descriptionId === undefined ? {} : { descriptionId }),
          };
          localIds.add(titleId);
          if (descriptionId !== undefined) localIds.add(descriptionId);
        }
      } else if (op.policy === "replace-explicit") {
        const titleId = parseLocalId("tfsb-" + recipe.target_asset + "-title", ctx, recipe.id + ".accessibility.title-id");
        const descriptionId = op.description === undefined
          ? undefined
          : parseLocalId("tfsb-" + recipe.target_asset + "-description", ctx, recipe.id + ".accessibility.description-id");
        for (const generatedId of [titleId, descriptionId]) {
          if (generatedId !== undefined && localIds.has(generatedId)) {
            fail(ctx, "BRAND_RECIPE_ID_COLLISION", "Generated accessibility id '" + generatedId + "' collides with an existing local id.", recipe.id);
          }
        }
        (targetSvg as any).accessibility = {
          mode: "labelled",
          title: op.title!,
          titleId,
          ...(op.description === undefined ? {} : { description: op.description, descriptionId }),
        };
        localIds.add(titleId);
        if (descriptionId !== undefined) localIds.add(descriptionId);
      } else if (op.policy === "decorative") {
        (targetSvg as any).accessibility = {
          mode: "decorative",
        };
      }
    } else if (op.operation === "copy-metadata") {
      if (op.fields.includes("metadata_text")) {
        if (sourceAsset.svg.metadataText !== undefined) {
          (targetSvg as any).metadataText = sourceAsset.svg.metadataText;
        }
      }
    }
  }

  const targetAsset: NormalizedAssetV2 = {
    schemaVersion: 2,
    id: recipe.target_asset as AssetId,
    filename: (recipe.target_asset + ".svg") as SvgFilename,
    svg: targetSvg,
  };

  const sortedUsedTokens = [...usedTokensMap.values()].sort((a, b) => compareUtf8(a.id, b.id));
  const validated = parseAssetTomlV2(serializeAssetTomlV2(targetAsset), ".tfsb/assets/" + targetAsset.id + ".toml");
  if (!validated.ok) {
    fail(ctx, "BRAND_RECIPE_RESULT_INVALID", "Recipe '" + recipe.id + "' produced an invalid schema-2 target.", recipe.id);
  }
  return {
    targetAsset: validated.value,
    usedTokens: Object.freeze(sortedUsedTokens),
  };
}

function receiptAuthorityValue(receipt: BrandDerivedReceipt): string {
  const dto = toDerivedReceiptPreimageDto(receipt);
  delete dto.toolVersion;
  return encodeCanonicalJson(dto);
}

function accessibilityResult(asset: NormalizedAssetV2): BrandDerivedReceipt["accessibilityResult"] {
  if (asset.svg.accessibility.mode === "labelled") {
    return {
      mode: "labelled",
      title: asset.svg.accessibility.title,
      ...(asset.svg.accessibility.description === undefined ? {} : { description: asset.svg.accessibility.description }),
    };
  }
  return { mode: asset.svg.accessibility.mode };
}

export function inspectDerivedAuthority(
  files: ReadonlyMap<string, DerivedFileView>,
  ctx: DiagnosticContext = context(),
): DerivedAuthorityInspection {
  const tokensFile = files.get(".tfsb/brand-tokens.toml");
  const recipesFile = files.get(".tfsb/brand-recipes.toml");
  if (tokensFile === undefined || recipesFile === undefined) {
    return deepFreezeJson({
      entries: [],
      counts: { unchanged: 0, "stale-authority": 0, "missing-target": 0, "human-owned": 0, "target-drift": 0, "invalid-receipt": 0, "ownership-conflict": 0 },
    });
  }
  const tokensParsed = parseBrandTokensToml(new TextDecoder("utf8", { fatal: true }).decode(tokensFile.bytes));
  const recipesParsed = parseBrandRecipesToml(new TextDecoder("utf8", { fatal: true }).decode(recipesFile.bytes));
  if (!tokensParsed.ok || !recipesParsed.ok) {
    fail(ctx, "DERIVED_AUTHORITY_INVALID", "Token or recipe authority cannot be parsed.");
  }
  const tokens = tokensParsed.value;
  const recipes = recipesParsed.value;
  const graph = buildRecipeGraph(recipes, ctx);
  const discovery = discoverBrandState(files as ReadonlyMap<string, CanonicalFileSnapshot>, ctx);
  const sourceClaims = new Set(
    discovery.brandModel?.bindings.filter((binding) => binding.authority === "source").map((binding) => binding.asset) ?? [],
  );

  const assets = new Map<string, NormalizedAssetV2>();
  for (const [path, file] of files) {
    if (!path.startsWith(".tfsb/assets/") || !path.endsWith(".toml")) continue;
    const parsed = parseAssetTomlV2(new TextDecoder("utf8", { fatal: true }).decode(file.bytes), path);
    if (parsed.ok) assets.set(parsed.value.id, parsed.value);
  }
  const receiptFiles = [...files.entries()].filter(([path]) => isDerivedReceiptPath(path));
  if (receiptFiles.length > DERIVED_RECEIPT_MAX_COUNT) {
    fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Derived receipt count exceeds 128.", BRAND_DERIVED_RECEIPT_DIR);
  }
  const parsedReceipts = new Map<string, { readonly path: string; readonly receipt?: BrandDerivedReceipt }>();
  for (const [path, file] of receiptFiles) {
    let receipt: BrandDerivedReceipt | undefined;
    try {
      const parsed = parseBrandDerivedReceipt(new TextDecoder("utf8", { fatal: true }).decode(file.bytes), path);
      if (parsed.ok) receipt = parsed.value;
    } catch {
      receipt = undefined;
    }
    const pathTarget = path.slice((BRAND_DERIVED_RECEIPT_DIR + "/").length, -".receipt.json".length);
    parsedReceipts.set(pathTarget, { path, ...(receipt === undefined ? {} : { receipt }) });
  }

  const expectedAssets = new Map(assets);
  const expectedReceipts = new Map<string, BrandDerivedReceipt>();
  const entries: DerivedAuthorityEntry[] = [];
  const recipeTargets = new Set(recipes.recipes.map((recipe) => recipe.target_asset));
  for (const recipe of graph.topologicalOrder) {
    const targetId = recipe.target_asset;
    const targetPath = ".tfsb/assets/" + targetId + ".toml";
    const targetFile = files.get(targetPath);
    const receiptRecord = parsedReceipts.get(targetId);
    if (sourceClaims.has(targetId)) {
      entries.push({ targetAssetId: targetId, recipeId: recipe.id, state: "ownership-conflict" });
      continue;
    }
    if (targetFile === undefined && receiptRecord === undefined) {
      entries.push({ targetAssetId: targetId, recipeId: recipe.id, state: "missing-target" });
      continue;
    }
    if (targetFile !== undefined && receiptRecord === undefined) {
      entries.push({ targetAssetId: targetId, recipeId: recipe.id, state: "human-owned" });
      continue;
    }
    if (targetFile === undefined) {
      const missingReceipt = receiptRecord?.receipt;
      entries.push({ targetAssetId: targetId, recipeId: recipe.id, state: "missing-target", ...(missingReceipt === undefined ? {} : { receiptDigest: missingReceipt.receiptDigest }) });
      continue;
    }
    const receipt = receiptRecord?.receipt;
    if (receipt === undefined || receiptRecord?.path !== derivedReceiptPath(targetId) || receipt.targetAssetId !== targetId || receipt.recipeId !== recipe.id || receipt.targetFilename !== targetId + ".svg") {
      entries.push({ targetAssetId: targetId, recipeId: recipe.id, state: "invalid-receipt" });
      continue;
    }
    const actualParsed = parseAssetTomlV2(new TextDecoder("utf8", { fatal: true }).decode(targetFile.bytes), targetPath);
    if (!actualParsed.ok) {
      entries.push({ targetAssetId: targetId, recipeId: recipe.id, state: "target-drift", receiptDigest: receipt.receiptDigest });
      continue;
    }
    const actualAsset = actualParsed.value;
    const actualSvg = serializeSvgV2(actualAsset.svg);
    const actualModelDigest = computeAssetSemanticDigest(actualAsset);
    const actualSvgDigest = actualSvg.ok ? computeSvgOutputDigest(actualSvg.value) : undefined;
    const sourceAsset = expectedAssets.get(recipe.source_asset);
    if (sourceAsset === undefined) {
      entries.push({ targetAssetId: targetId, recipeId: recipe.id, state: "ownership-conflict", receiptDigest: receipt.receiptDigest });
      continue;
    }
    let computed;
    try {
      computed = applyRecipeOperations(recipe, sourceAsset, tokens, ctx);
    } catch {
      entries.push({ targetAssetId: targetId, recipeId: recipe.id, state: "invalid-receipt", receiptDigest: receipt.receiptDigest });
      continue;
    }
    const expectedAsset = computed.targetAsset;
    const expectedTomlBytes = Buffer.from(serializeAssetTomlV2(expectedAsset), "utf8");
    const expectedSvg = serializeSvgV2(expectedAsset.svg);
    if (!expectedSvg.ok) {
      entries.push({ targetAssetId: targetId, recipeId: recipe.id, state: "invalid-receipt", receiptDigest: receipt.receiptDigest });
      continue;
    }
    const parentReceipt = expectedReceipts.get(sourceAsset.id);
    const sourceChain: DerivedReceiptSourceRecord[] = [
      { assetId: sourceAsset.id, canonicalAssetDigest: computeAssetSemanticDigest(sourceAsset) },
      ...(parentReceipt?.sourceChain ?? []),
    ];
    if (new Set(sourceChain.map((source) => source.assetId)).size !== sourceChain.length) {
      entries.push({ targetAssetId: targetId, recipeId: recipe.id, state: "invalid-receipt", receiptDigest: receipt.receiptDigest });
      continue;
    }
    const accessibilityOperation = recipe.operations.find((operation) => operation.operation === "copy-accessibility")!;
    const expectedReceipt = createBrandDerivedReceipt({
      targetAssetId: expectedAsset.id,
      targetFilename: expectedAsset.filename,
      recipeId: recipe.id,
      recipeFileDigest: recipesFile.digest,
      recipeDefinitionDigest: computeBrandRecipeDefinitionDigest(recipe),
      orderedOperations: toBrandRecipeOperationsCanonicalDto(recipe),
      orderedOperationsDigest: computeBrandRecipeOperationsDigest(recipe),
      tokenFileDigest: tokensFile.digest,
      usedTokens: computed.usedTokens,
      sourceChain,
      targetSchemaVersion: 2,
      targetTomlByteDigest: computeSha256(expectedTomlBytes),
      targetModelDigest: computeAssetSemanticDigest(expectedAsset),
      targetSvgDigest: computeSvgOutputDigest(expectedSvg.value),
      accessibilityPolicy: accessibilityOperation.policy,
      accessibilityResult: accessibilityResult(expectedAsset),
      resourceCounts: { operationCount: recipe.operations.length, elementCount: expectedAsset.svg.elements.length },
    });
    expectedAssets.set(targetId, expectedAsset);
    expectedReceipts.set(targetId, expectedReceipt);
    const actualMatchesReceipt = targetFile.digest === receipt.targetTomlByteDigest &&
      actualModelDigest === receipt.targetModelDigest && actualSvgDigest === receipt.targetSvgDigest;
    const actualMatchesExpected = targetFile.digest === expectedReceipt.targetTomlByteDigest &&
      actualModelDigest === expectedReceipt.targetModelDigest && actualSvgDigest === expectedReceipt.targetSvgDigest;
    if (!actualMatchesReceipt) {
      entries.push({
        targetAssetId: targetId,
        recipeId: recipe.id,
        state: actualMatchesExpected ? "invalid-receipt" : "target-drift",
        receiptDigest: receipt.receiptDigest,
        targetModelDigest: actualModelDigest,
        ...(actualSvgDigest === undefined ? {} : { targetSvgDigest: actualSvgDigest }),
      });
      continue;
    }
    if (receiptAuthorityValue(receipt) === receiptAuthorityValue(expectedReceipt)) {
      entries.push({ targetAssetId: targetId, recipeId: recipe.id, state: "unchanged", receiptDigest: receipt.receiptDigest, targetModelDigest: actualModelDigest, targetSvgDigest: actualSvgDigest! });
      continue;
    }
    const authorityChanged = receipt.recipeFileDigest !== recipesFile.digest || receipt.tokenFileDigest !== tokensFile.digest || encodeCanonicalJson(receipt.sourceChain) !== encodeCanonicalJson(sourceChain);
    entries.push({
      targetAssetId: targetId,
      recipeId: recipe.id,
      state: authorityChanged ? "stale-authority" : "invalid-receipt",
      receiptDigest: receipt.receiptDigest,
      targetModelDigest: actualModelDigest,
      targetSvgDigest: actualSvgDigest!,
    });
  }
  for (const [targetId, record] of parsedReceipts) {
    if (!recipeTargets.has(targetId)) {
      entries.push({ targetAssetId: targetId, ...(record.receipt === undefined ? {} : { recipeId: record.receipt.recipeId, receiptDigest: record.receipt.receiptDigest }), state: "ownership-conflict" });
    }
  }
  entries.sort((left, right) => compareUtf8(left.targetAssetId, right.targetAssetId));
  const counts: Record<DerivedAuthorityState, number> = { unchanged: 0, "stale-authority": 0, "missing-target": 0, "human-owned": 0, "target-drift": 0, "invalid-receipt": 0, "ownership-conflict": 0 };
  for (const entry of entries) counts[entry.state]++;
  return deepFreezeJson({ entries, counts });
}

async function validateExactStagedDerivationTree(
  stageRoot: string,
  expectedFiles: ReadonlyMap<string, Uint8Array>,
  expectedSemanticSummary: string,
): Promise<void> {
  const ctx = context();
  const expectedDirectories = new Set<string>();
  for (const path of expectedFiles.keys()) {
    const segments = path.slice(".tfsb/".length).split("/");
    for (let index = 1; index < segments.length; index++) {
      expectedDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  const actualDirectories = new Set<string>();
  const actualFiles = new Map<string, DerivedFileView>();
  const expectedAggregateBytes = [...expectedFiles.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
  let aggregateBytes = 0;
  const scan = async (directory: string): Promise<void> => {
    const entries = [];
    for await (const entry of await opendir(directory)) entries.push(entry);
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      const stat = await lstat(fullPath);
      const inside = relative(stageRoot, fullPath).replaceAll("\\", "/");
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        fail(ctx, "DERIVED_STAGE_UNSAFE_CONTENT", "Staged canonical tree contains a symlink or special file.", ".tfsb/" + inside);
      }
      if (stat.isDirectory()) {
        actualDirectories.add(inside);
        await scan(fullPath);
        continue;
      }
      const canonicalPath = ".tfsb/" + inside;
      const expectedBytes = expectedFiles.get(canonicalPath);
      if (expectedBytes === undefined) {
        fail(ctx, "DERIVED_STAGE_TREE_MISMATCH", "Staged canonical tree contains an extra file.", canonicalPath);
      }
      if (stat.size !== expectedBytes.byteLength) {
        fail(ctx, "DERIVED_STAGE_BYTE_MISMATCH", "Staged canonical file size differs from the private plan.", canonicalPath);
      }
      aggregateBytes += stat.size;
      if (aggregateBytes > expectedAggregateBytes) {
        fail(ctx, "DERIVED_STAGE_TREE_MISMATCH", "Staged canonical tree exceeds the private planned byte budget.", ".tfsb");
      }
      const snapshot = await readRegularFileSnapshot(fullPath, ctx, "DERIVED_STAGE_UNSAFE_CONTENT", "Failed to read staged canonical file");
      actualFiles.set(canonicalPath, { bytes: snapshot.bytes, digest: computeSha256(snapshot.bytes) });
    }
  };
  await scan(stageRoot);
  if (encodeCanonicalJson([...actualDirectories].sort(compareUtf8)) !== encodeCanonicalJson([...expectedDirectories].sort(compareUtf8))) {
    fail(ctx, "DERIVED_STAGE_TREE_MISMATCH", "Staged canonical directory topology differs from the private plan.", ".tfsb");
  }
  if (actualFiles.size !== expectedFiles.size) {
    fail(ctx, "DERIVED_STAGE_TREE_MISMATCH", "Staged canonical file count differs from the private plan.", ".tfsb");
  }
  for (const [path, expectedBytes] of expectedFiles) {
    const actual = actualFiles.get(path);
    if (actual === undefined || !Buffer.from(actual.bytes).equals(Buffer.from(expectedBytes))) {
      fail(ctx, "DERIVED_STAGE_BYTE_MISMATCH", "Staged canonical bytes differ from the private plan.", path);
    }
  }
  const decoder = new TextDecoder("utf8", { fatal: true });
  const projectFile = actualFiles.get(".tfsb/project.toml");
  if (projectFile === undefined || !parseProjectTomlVersioned(decoder.decode(projectFile.bytes), ".tfsb/project.toml").ok) {
    fail(ctx, "DERIVED_STAGE_SEMANTIC_MISMATCH", "Staged project authority is invalid.", ".tfsb/project.toml");
  }
  const provenanceFile = actualFiles.get(".tfsb/provenance.json");
  if (provenanceFile !== undefined) {
    try { JSON.parse(decoder.decode(provenanceFile.bytes)); }
    catch { fail(ctx, "DERIVED_STAGE_SEMANTIC_MISMATCH", "Staged provenance is invalid JSON.", ".tfsb/provenance.json"); }
  }
  discoverBrandState(actualFiles as unknown as ReadonlyMap<string, CanonicalFileSnapshot>, ctx);
  for (const [path, file] of actualFiles) {
    decoder.decode(file.bytes);
    if (path.startsWith(".tfsb/assets/") && path.endsWith(".toml") && !parseAssetTomlV2(decoder.decode(file.bytes), path).ok) {
      fail(ctx, "DERIVED_STAGE_SEMANTIC_MISMATCH", "Staged asset is invalid.", path);
    }
    if (isDerivedReceiptPath(path) && !parseBrandDerivedReceipt(decoder.decode(file.bytes), path).ok) {
      fail(ctx, "DERIVED_STAGE_SEMANTIC_MISMATCH", "Staged derived receipt is invalid.", path);
    }
  }
  const semanticSummary = computeDerivationSemanticSummary(actualFiles, ctx);
  if (semanticSummary !== expectedSemanticSummary) {
    fail(ctx, "DERIVED_STAGE_AUTHORITY_MISMATCH", "Staged brand and derived authority differ from the private semantic plan.", ".tfsb");
  }
}

function computeDerivationSemanticSummary(
  files: ReadonlyMap<string, DerivedFileView>,
  ctx: DiagnosticContext,
): string {
  const assets = new Map<string, NormalizedAssetV2>();
  for (const [path, file] of files) {
    if (!path.startsWith(".tfsb/assets/") || !path.endsWith(".toml")) continue;
    const parsed = parseAssetTomlV2(new TextDecoder("utf8", { fatal: true }).decode(file.bytes), path);
    if (!parsed.ok) fail(ctx, "DERIVED_STAGE_SEMANTIC_MISMATCH", "Canonical asset is invalid.", path);
    assets.set(parsed.value.id, parsed.value);
  }
  const brand = loadBrandProject(files, assets, ctx);
  const authority = inspectDerivedAuthority(files, ctx);
  return encodeCanonicalJson({
    authorityEntries: authority.entries,
    brandDigest: brand?.brandDigest ?? null,
    brandSystemDigest: brand?.brandSystemDigest ?? null,
  });
}

export async function planBrandDerivation(options: BrandDeriveOptions = {}): Promise<BrandDerivePlan> {
  const root = options.root ?? process.cwd();
  const ctx = context();
  const snapshot = await snapshotCanonicalTree(root, false, "build");

  const brandDiscovery = discoverBrandState(snapshot.files, ctx);
  if (!brandDiscovery.branded || brandDiscovery.brandModel === undefined) {
    fail(ctx, "BRAND_NOT_CONFIGURED", "Project is not configured as a brand system.", root);
  }
  if (!brandDiscovery.brandModel.enabledDomains.recipes) {
    fail(ctx, "BRAND_RECIPES_DISABLED", "Brand recipes domain is disabled in brand.toml.", ".tfsb/brand.toml");
  }

  // Parse tokens & recipes
  const tokensFile = snapshot.files.get(".tfsb/brand-tokens.toml");
  if (tokensFile === undefined) {
    fail(ctx, "BRAND_DOMAIN_FILE_MISSING", "brand-tokens.toml is required when recipes domain is enabled.", ".tfsb/brand-tokens.toml");
  }
  const tokensText = new TextDecoder("utf8", { fatal: true }).decode(tokensFile.bytes);
  const parsedTokens = parseBrandTokensToml(tokensText, ".tfsb/brand-tokens.toml");
  if (!parsedTokens.ok) {
    fail(ctx, "SCHEMA_INVALID_SYNTAX", "Invalid brand-tokens.toml.", ".tfsb/brand-tokens.toml");
  }
  const tokensModel = parsedTokens.value;
  const tokenFileDigest = tokensFile.digest;
  const tokenDigest = computeBrandTokensDigest(tokensModel);

  const recipesFile = snapshot.files.get(".tfsb/brand-recipes.toml");
  if (recipesFile === undefined) {
    fail(ctx, "BRAND_DOMAIN_FILE_MISSING", "brand-recipes.toml is required when recipes domain is enabled.", ".tfsb/brand-recipes.toml");
  }
  const recipesText = new TextDecoder("utf8", { fatal: true }).decode(recipesFile.bytes);
  const parsedRecipes = parseBrandRecipesToml(recipesText, ".tfsb/brand-recipes.toml");
  if (!parsedRecipes.ok) {
    fail(ctx, "SCHEMA_INVALID_SYNTAX", "Invalid brand-recipes.toml.", ".tfsb/brand-recipes.toml");
  }
  const recipesModel = parsedRecipes.value;
  const recipeFileDigest = recipesFile.digest;
  const recipeDigest = computeBrandRecipesDigest(recipesModel);

  const recipeGraph = buildRecipeGraph(recipesModel, ctx);

  // Validate selection
  let selectedRecipeIds: string[];
  if (options.all === true) {
    selectedRecipeIds = recipeGraph.topologicalOrder.map((r) => r.id);
  } else if (options.recipes !== undefined && options.recipes.length > 0) {
    selectedRecipeIds = [...options.recipes];
    for (const rId of selectedRecipeIds) {
      if (!recipeGraph.nodes.has(rId)) {
        fail(ctx, "BRAND_RECIPE_NOT_FOUND", "Recipe '" + rId + "' not found in brand-recipes.toml.", rId);
      }
    }
  } else {
    fail(ctx, "USAGE_ERROR", "Derive requires either --all or --recipe <id>.", root);
  }

  // Expand to transitive recipes
  const transitiveSet = new Set<string>();
  const addAncestors = (rId: string): void => {
    transitiveSet.add(rId);
    const node = recipeGraph.nodes.get(rId)!;
    for (const parentId of node.dependencies) {
      addAncestors(parentId);
    }
  };
  const addDescendants = (rId: string): void => {
    transitiveSet.add(rId);
    const node = recipeGraph.nodes.get(rId)!;
    for (const childId of node.dependents) {
      addDescendants(childId);
    }
  };

  for (const rId of selectedRecipeIds) {
    addAncestors(rId);
    addDescendants(rId);
  }

  const transitiveRecipes = recipeGraph.topologicalOrder.filter((r) => transitiveSet.has(r.id));
  if (transitiveRecipes.length > 128 || transitiveRecipes.length > DERIVED_RECEIPT_MAX_COUNT) {
    fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Selected/transitive derived targets or receipts exceed 128.", "recipes");
  }
  const affectedTargets = transitiveRecipes.map((r) => r.target_asset);

  // Load existing assets from snapshot
  const assetsMap = new Map<string, NormalizedAssetV2>();
  for (const [path, file] of snapshot.files) {
    if (path.startsWith(".tfsb/assets/") && path.endsWith(".toml")) {
      const assetToml = new TextDecoder("utf8", { fatal: true }).decode(file.bytes);
      const parseRes = parseAssetTomlV2(assetToml, path);
      if (parseRes.ok) {
        assetsMap.set(parseRes.value.id, parseRes.value);
      }
    }
  }

  // Parse existing receipts from snapshot
  const existingReceipts = new Map<string, BrandDerivedReceipt>();
  for (const [path, file] of snapshot.files) {
    if (isDerivedReceiptPath(path)) {
      const receiptJson = new TextDecoder("utf8", { fatal: true }).decode(file.bytes);
      const parseRes = parseBrandDerivedReceipt(receiptJson, path);
      if (!parseRes.ok) {
        fail(ctx, "DERIVED_RECEIPT_INVALID", "Corrupt derived receipt '" + path + "'.", path);
      }
      existingReceipts.set(parseRes.value.targetAssetId, parseRes.value);
    }
  }

  const authorityInspection = inspectDerivedAuthority(snapshot.files, ctx);
  const selectedTargets = new Set(transitiveRecipes.map((recipe) => recipe.target_asset));
  for (const entry of authorityInspection.entries) {
    if (!selectedTargets.has(entry.targetAssetId)) continue;
    if (entry.state === "human-owned") {
      fail(ctx, "DERIVED_TARGET_OWNED_BY_HUMAN", "Target asset '" + entry.targetAssetId + "' exists without authoritative receipt ownership.", entry.targetAssetId);
    }
    if (entry.state === "missing-target" && snapshot.files.has(derivedReceiptPath(entry.targetAssetId))) {
      fail(ctx, "DERIVED_TARGET_MISSING", "Derived receipt exists for missing target '" + entry.targetAssetId + "'.", entry.targetAssetId);
    }
    if (entry.state === "invalid-receipt") {
      fail(ctx, "DERIVED_RECEIPT_INVALID", "Derived receipt authority is invalid for '" + entry.targetAssetId + "'.", derivedReceiptPath(entry.targetAssetId));
    }
    if (entry.state === "ownership-conflict") {
      fail(ctx, "DERIVED_OWNERSHIP_CONFLICT", "Derived target ownership conflicts for '" + entry.targetAssetId + "'.", entry.targetAssetId);
    }
    if (entry.state === "target-drift") {
      fail(ctx, "DERIVED_ASSET_DRIFT", "Derived target asset '" + entry.targetAssetId + "' has drifted from receipt authority.", entry.targetAssetId);
    }
  }

  // Execute derivations in memory in topological order
  const nextFiles = new Map<string, Uint8Array>();
  for (const [p, f] of snapshot.files) {
    nextFiles.set(p, f.bytes);
  }

  const targetStates: BrandDeriveTargetSummary[] = [];
  const operationSummaries: BrandDeriveOperationSummary[] = [];
  const allUsedTokenIds = new Set<string>();

  const receiptsByTarget = new Map<string, BrandDerivedReceipt>(existingReceipts);
  const selectedSourceIds = new Set<string>();
  let selectedSourceBytes = 0;
  let plannedTargetBytes = 0;
  let totalOperationApplications = 0;

  let createdCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const recipe of transitiveRecipes) {
    const sourceAsset = assetsMap.get(recipe.source_asset);
    if (sourceAsset === undefined) {
      fail(
        ctx,
        "BRAND_RECIPE_SOURCE_ASSET_MISSING",
        "Recipe '" + recipe.id + "' source_asset '" + recipe.source_asset + "' not found in project assets.",
        recipe.id,
      );
    }
    if (!selectedSourceIds.has(sourceAsset.id)) {
      const sourcePath = ".tfsb/assets/" + sourceAsset.id + ".toml";
      const sourceBytes = nextFiles.get(sourcePath);
      if (sourceBytes === undefined) {
        fail(ctx, "BRAND_RECIPE_SOURCE_ASSET_MISSING", "Selected source bytes are missing for '" + sourceAsset.id + "'.", sourcePath);
      }
      if (sourceBytes.byteLength > 8 * 1024 * 1024) {
        fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Selected source '" + sourceAsset.id + "' exceeds 8 MiB.", sourcePath);
      }
      selectedSourceIds.add(sourceAsset.id);
      selectedSourceBytes += sourceBytes.byteLength;
      if (selectedSourceBytes + plannedTargetBytes > 32 * 1024 * 1024) {
        fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Aggregate selected source plus planned target bytes exceed 32 MiB.", "recipes");
      }
    }
    totalOperationApplications += recipe.operations.length;
    if (totalOperationApplications > 2048) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Total ordered operation applications exceed 2048.", recipe.id);
    }

    const { targetAsset, usedTokens } = applyRecipeOperations(recipe, sourceAsset, tokensModel, ctx);
    for (const t of usedTokens) allUsedTokenIds.add(t.id);

    const targetTomlText = serializeAssetTomlV2(targetAsset);
    const targetTomlBytes = Buffer.from(targetTomlText, "utf8");
    if (targetTomlBytes.byteLength > 8 * 1024 * 1024) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Planned target '" + targetAsset.id + "' exceeds 8 MiB.", targetAsset.id);
    }
    plannedTargetBytes += targetTomlBytes.byteLength;
    if (selectedSourceBytes + plannedTargetBytes > 32 * 1024 * 1024) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Aggregate selected source plus planned target bytes exceed 32 MiB.", "recipes");
    }
    const targetTomlSha = computeSha256(targetTomlBytes);
    const targetModelDigest = computeAssetSemanticDigest(targetAsset);
    const targetSvgRes = serializeSvgV2(targetAsset.svg);
    if (!targetSvgRes.ok) {
      fail(ctx, "SVG_INVALID", "Failed to render target SVG for " + targetAsset.id, targetAsset.id);
    }
    const targetSvgText = targetSvgRes.value;
    const targetSvgDigest = computeSvgOutputDigest(targetSvgText);

    // Build sourceChain
    const sourceCanonicalDigest = computeAssetSemanticDigest(sourceAsset);
    const parentReceipt = receiptsByTarget.get(sourceAsset.id);

    const sourceChain: DerivedReceiptSourceRecord[] = [
      { assetId: sourceAsset.id, canonicalAssetDigest: sourceCanonicalDigest },
      ...(parentReceipt === undefined ? [] : parentReceipt.sourceChain),
    ];

    const accOp = recipe.operations.find((o) => o.operation === "copy-accessibility") as any;
    const accResult = {
      mode: targetAsset.svg.accessibility.mode as "labelled" | "decorative",
      ...(targetAsset.svg.accessibility.mode === "labelled" ? { title: targetAsset.svg.accessibility.title, ...(targetAsset.svg.accessibility.description === undefined ? {} : { description: targetAsset.svg.accessibility.description }) } : {}),
    };

    const newReceipt = createBrandDerivedReceipt({
      targetAssetId: targetAsset.id,
      targetFilename: targetAsset.filename,
      recipeId: recipe.id,
      recipeFileDigest,
      recipeDefinitionDigest: computeBrandRecipeDefinitionDigest(recipe),
      orderedOperations: toBrandRecipeOperationsCanonicalDto(recipe),
      orderedOperationsDigest: computeBrandRecipeOperationsDigest(recipe),
      tokenFileDigest,
      usedTokens,
      sourceChain,
      targetSchemaVersion: 2,
      targetTomlByteDigest: targetTomlSha,
      targetModelDigest,
      targetSvgDigest,
      accessibilityPolicy: accOp.policy,
      accessibilityResult: accResult,
      resourceCounts: {
        operationCount: recipe.operations.length,
        elementCount: targetAsset.svg.elements.length,
      },
    });

    const receiptJson = serializeBrandDerivedReceipt(newReceipt);
    const receiptBytes = Buffer.from(receiptJson, "utf8");
    if (receiptBytes.byteLength > DERIVED_RECEIPT_MAX_BYTES) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Derived receipt for '" + targetAsset.id + "' exceeds 1 MiB.", targetAsset.id);
    }

    const targetTomlPath = ".tfsb/assets/" + targetAsset.id + ".toml";
    const receiptPath = derivedReceiptPath(targetAsset.id);

    const oldReceipt = existingReceipts.get(targetAsset.id);
    let state: "create" | "update" | "unchanged";

    if (oldReceipt === undefined) {
      state = "create";
      createdCount++;
    } else if ((() => {
      const oldDto = toDerivedReceiptPreimageDto(oldReceipt);
      const newDto = toDerivedReceiptPreimageDto(newReceipt);
      delete oldDto.toolVersion;
      delete newDto.toolVersion;
      return encodeCanonicalJson(oldDto) === encodeCanonicalJson(newDto) && oldReceipt.targetTomlByteDigest === targetTomlSha;
    })()) {
      state = "unchanged";
      unchangedCount++;
    } else {
      state = "update";
      updatedCount++;
    }

    targetStates.push({
      targetAssetId: targetAsset.id,
      recipeId: recipe.id,
      state,
      ...(oldReceipt === undefined ? {} : { oldDigest: oldReceipt.receiptDigest }),
      newDigest: newReceipt.receiptDigest,
      newSvgDigest: targetSvgDigest,
    });

    operationSummaries.push({
      recipeId: recipe.id,
      targetAssetId: targetAsset.id,
      operations: recipe.operations.map((o) => o.operation),
    });

    // Stage in nextFiles if created or updated
    if (state !== "unchanged") {
      nextFiles.set(targetTomlPath, targetTomlBytes);
      nextFiles.set(receiptPath, receiptBytes);
    }

    assetsMap.set(targetAsset.id, targetAsset);
    receiptsByTarget.set(targetAsset.id, state === "unchanged" && oldReceipt !== undefined ? oldReceipt : newReceipt);
  }

  if (transitiveRecipes.length > 128 || transitiveRecipes.length > DERIVED_RECEIPT_MAX_COUNT) {
    fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Selected/transitive derived targets or receipts exceed 128.", "recipes");
  }
  if (selectedSourceBytes + plannedTargetBytes > 32 * 1024 * 1024) {
    fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Aggregate selected source plus planned target bytes exceed 32 MiB.", "recipes");
  }

  const unusedTokens = findUnusedTokens(tokensModel, allUsedTokenIds);
  const warnings = unusedTokens.map((t) => "BRAND_TOKEN_UNUSED: Token '" + t + "' is declared in brand-tokens.toml but never referenced.");

  const targetsWritten = targetStates.filter((state) => state.state !== "unchanged").map((state) => ".tfsb/assets/" + state.targetAssetId + ".toml").sort(compareUtf8);
  const receiptsWritten = targetStates.filter((state) => state.state !== "unchanged").map((state) => derivedReceiptPath(state.targetAssetId)).sort(compareUtf8);
  const semanticFiles = new Map<string, DerivedFileView>();
  for (const [path, bytes] of nextFiles) semanticFiles.set(path, { bytes, digest: computeSha256(bytes) });
  const semanticSummary = computeDerivationSemanticSummary(semanticFiles, ctx);
  const plan: BrandDerivePlan = deepFreezeJson({
    selectedRecipes: Object.freeze(selectedRecipeIds.sort(compareUtf8)),
    transitiveRecipes: Object.freeze(transitiveRecipes.map((r) => r.id)),
    affectedTargets: Object.freeze(affectedTargets.sort(compareUtf8)),
    createdCount,
    updatedCount,
    unchangedCount,
    operationSummaries,
    targetStates,
    tokenDigest,
    recipeDigest,
    warnings: Object.freeze(warnings),
    dryRun: options.dryRun === true,
    [derivePlanBrand]: true as const,
  });

  derivePlanInternals.set(plan, {
    root,
    dryRun: options.dryRun === true,
    createdCount,
    updatedCount,
    snapshot,
    nextFiles,
    targetsWritten: Object.freeze(targetsWritten),
    receiptsWritten: Object.freeze(receiptsWritten),
    semanticSummary,
    executed: false,
  });

  return plan;
}

export async function executeBrandDerivationPlan(
  plan: BrandDerivePlan,
  hooks?: TransactionHooks,
): Promise<BrandDeriveResult> {
  const internals = derivePlanInternals.get(plan);
  if (internals === undefined || internals.executed) {
    fail(context(), "BRAND_DERIVE_PLAN_EXPIRED", "Derivation plan is expired, disposed, forged, or already executed.");
  }
  internals.executed = true;
  derivePlanInternals.delete(plan);

  if (internals.dryRun || (internals.createdCount === 0 && internals.updatedCount === 0)) {
    return {
      ...plan,
      written: false,
      targetsWritten: [],
      receiptsWritten: [],
    };
  }

  const targetsWritten = [...internals.targetsWritten];
  const receiptsWritten = [...internals.receiptsWritten];

  await executeCanonicalTransaction({
    root: internals.root,
    expectedSnapshot: internals.snapshot,
    nextFiles: internals.nextFiles,
    operation: "reconcile",
    validateStagedTree: async (stageRoot: string) => {
      await validateExactStagedDerivationTree(stageRoot, internals.nextFiles, internals.semanticSummary);
    },
    ...(hooks === undefined ? {} : { hooks }),
  });

  return {
    ...plan,
    written: true,
    targetsWritten: Object.freeze(targetsWritten.sort(compareUtf8)),
    receiptsWritten: Object.freeze(receiptsWritten.sort(compareUtf8)),
  };
}

export async function deriveBrandProject(options: BrandDeriveOptions = {}): Promise<BrandDeriveResult> {
  const plan = await planBrandDerivation(options);
  return executeBrandDerivationPlan(plan);
}

export async function disposeBrandDerivationPlan(plan: BrandDerivePlan): Promise<void> {
  const internals = derivePlanInternals.get(plan);
  if (internals !== undefined) {
    internals.executed = true;
    derivePlanInternals.delete(plan);
  }
}

/** Internal Studio retention seam; not re-exported from the package root. */
export function inspectBrandDerivationPlanRetention(plan: BrandDerivePlan): PlanRetentionInspection {
  const internals = derivePlanInternals.get(plan);
  if (internals === undefined) throw new Error("Brand derivation plan was not produced by this planner instance.");
  return inspectPlanRetention([plan, internals]);
}
