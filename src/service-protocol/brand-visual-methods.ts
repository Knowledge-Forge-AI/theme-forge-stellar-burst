import { createHash } from "node:crypto";

import { computeAssetSemanticDigest } from "../digests.js";
import type { LoadedProject } from "../project.js";
import {
  BRAND_QA_RENDER_CONFIGURATION,
  compareBrandQaRasters,
  decodeBrandQaBaseline,
  parseBrandQaBackgroundRgba,
  renderBrandQaRaster,
  type BrandQaNormalizedRaster,
} from "../brand/qa-capability.js";
import { getVerifiedConsumerBrandDiffSnapshot, getVerifiedConsumerBrandVisualAsset, revalidateConsumerSources, disposeConsumerSources } from "../brand/consumer-source.js";
import { createLoadedProjectBrandDiffSnapshot, type BrandDiffSnapshot } from "../brand/brand-diff.js";
import { isBrandQaVisualCase, type BrandQaBackground, type BrandQaBaselineCase } from "../brand/qa-schema.js";
import { isQualifiedStudioRasterCapability } from "./v1-registry.js";
import { canonicalJson } from "./canonical-json.js";
import { ProtocolError } from "./errors.js";
import type { StudioSession } from "./session.js";
import type {
  BrandVisualEvidenceArtifact,
  BrandVisualEvidenceDifference,
  BrandVisualEvidenceParams,
  BrandVisualEvidenceResult,
  BrandVisualTarget,
  Sha256Digest,
} from "./v1-types.js";

export const VISUAL_EVIDENCE_MAX_DIMENSION = 1024;
export const VISUAL_EVIDENCE_MAX_PIXELS = 1_048_576;
export const VISUAL_EVIDENCE_MAX_ARTIFACT_BYTES = 6_291_456;
export const VISUAL_EVIDENCE_MAX_AGGREGATE_ARTIFACT_BYTES = 8_388_608;
export const VISUAL_EVIDENCE_MAX_RESULT_BYTES = 12_582_912;
export const VISUAL_EVIDENCE_DIGEST_BASIS = "tfsb.studio-visual-evidence-v1";

interface ResolvedVisualAsset {
  readonly assetId: string;
  readonly canonicalAssetDigest: Sha256Digest;
  readonly svgBytes: Uint8Array;
  readonly svgDigest: Sha256Digest;
  readonly binding?: { readonly family: string; readonly role: string; readonly variant: string };
}

type PublicVisualTarget = BrandVisualEvidenceResult["target"];

function check(signal: AbortSignal): void {
  if (signal.aborted) throw new ProtocolError("REQUEST_CANCELLED");
}

function sha(bytes: Uint8Array | string): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > VISUAL_EVIDENCE_MAX_DIMENSION || height > VISUAL_EVIDENCE_MAX_DIMENSION || width * height > VISUAL_EVIDENCE_MAX_PIXELS) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
}

function resolveBackground(project: LoadedProject, background: string): { readonly text: string; readonly rgba: readonly [number, number, number, number] | null } {
  if (background === "transparent" || /^#[0-9A-F]{8}$/u.test(background)) return Object.freeze({ text: background, rgba: parseBrandQaBackgroundRgba(background as BrandQaBackground) });
  if (!/^token:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(background)) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
  const token = project.brand?.tokensModel?.colors.find((entry) => entry.id === background.slice(6));
  if (token === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
  return Object.freeze({ text: background, rgba: parseBrandQaBackgroundRgba(token.value as BrandQaBackground) });
}

function selectSnapshotAsset(snapshot: BrandDiffSnapshot, target: BrandVisualTarget): string {
  if (target.kind === "asset") return target.assetId;
  const matches = snapshot.brand.model.bindings.filter((entry) => entry.family === target.family && entry.role === target.role && entry.variant === target.variant);
  if (matches.length !== 1) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
  return matches[0]!.asset;
}

function resolveProjectAsset(project: LoadedProject, target: BrandVisualTarget): ResolvedVisualAsset {
  const snapshot = createLoadedProjectBrandDiffSnapshot(project);
  const assetId = selectSnapshotAsset(snapshot, target);
  const asset = project.assets.find((entry) => entry.id === assetId);
  if (asset === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
  const bytes = project.outputs.get(asset.filename);
  if (bytes === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
  return Object.freeze({
    assetId,
    canonicalAssetDigest: computeAssetSemanticDigest(asset),
    svgBytes: new Uint8Array(bytes),
    svgDigest: sha(bytes),
    ...(target.kind === "binding" ? { binding: Object.freeze({ family: target.family, role: target.role, variant: target.variant }) } : {}),
  });
}

function publicTarget(asset: ResolvedVisualAsset): PublicVisualTarget {
  return Object.freeze({
    assetId: asset.assetId,
    canonicalAssetDigest: asset.canonicalAssetDigest,
    svgDigest: asset.svgDigest,
    ...(asset.binding === undefined ? {} : { binding: asset.binding }),
  });
}

async function render(session: StudioSession, asset: ResolvedVisualAsset, width: number, height: number, background: ReturnType<typeof resolveBackground>, signal: AbortSignal): Promise<BrandQaNormalizedRaster> {
  if (!isQualifiedStudioRasterCapability(session.rasterCapability)) throw new ProtocolError("METHOD_CAPABILITY_UNAVAILABLE");
  check(signal);
  const result = await renderBrandQaRaster(session.rasterCapability.qa, {
    canonicalSvgBytes: asset.svgBytes, svgDigest: asset.svgDigest, width, height,
    background: background.text as BrandQaBackground, backgroundRgba: background.rgba,
    configuration: BRAND_QA_RENDER_CONFIGURATION,
  });
  check(signal);
  return result;
}

function artifact(role: BrandVisualEvidenceArtifact["role"], raster: BrandQaNormalizedRaster): BrandVisualEvidenceArtifact {
  const pngBytes = raster.pngBytes;
  if (pngBytes === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
  if (pngBytes.byteLength > VISUAL_EVIDENCE_MAX_ARTIFACT_BYTES) throw new ProtocolError("MESSAGE_TOO_LARGE");
  const bytesBase64 = Buffer.from(pngBytes).toString("base64");
  const decoded = Buffer.from(bytesBase64, "base64");
  if (decoded.toString("base64") !== bytesBase64 || !decoded.equals(Buffer.from(pngBytes))) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
  return Object.freeze({ role, mediaType: "image/png", encoding: "base64", width: raster.width, height: raster.height, byteLength: decoded.byteLength, pngDigest: sha(decoded), decodedPixelDigest: sha(raster.rgba8), bytesBase64 });
}

function difference(before: BrandQaNormalizedRaster, after: BrandQaNormalizedRaster): BrandVisualEvidenceDifference {
  const compared = compareBrandQaRasters(before, after);
  return Object.freeze({ changedPixels: compared.changedPixels, maximumChannelDelta: compared.maximumChannelDelta, changedBounds: compared.changedBounds, claim: compared.changedPixels === 0 ? "pixel-equal-for-this-renderer-and-case-only" : "pixel-different-for-this-renderer-and-case-only" });
}

function finalize(value: Omit<BrandVisualEvidenceResult, "evidenceDigest">): BrandVisualEvidenceResult {
  const aggregate = value.artifacts.reduce((total, entry) => total + entry.byteLength, 0);
  if (value.artifacts.length < 1 || value.artifacts.length > 2 || aggregate > VISUAL_EVIDENCE_MAX_AGGREGATE_ARTIFACT_BYTES) throw new ProtocolError("MESSAGE_TOO_LARGE");
  const projection = { ...value, artifacts: value.artifacts.map(({ bytesBase64: _bytesBase64, ...entry }) => entry) };
  const evidenceDigest = sha(`${VISUAL_EVIDENCE_DIGEST_BASIS}\n${canonicalJson(projection)}`);
  const result = deepFreeze({ ...value, evidenceDigest });
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > VISUAL_EVIDENCE_MAX_RESULT_BYTES) throw new ProtocolError("MESSAGE_TOO_LARGE");
  return result;
}

function baselineTarget(qaCase: BrandQaBaselineCase): BrandVisualTarget {
  if (qaCase.asset !== undefined) return Object.freeze({ kind: "asset", assetId: qaCase.asset });
  if (qaCase.family === undefined || qaCase.role === undefined || qaCase.variant === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
  return Object.freeze({ kind: "binding", family: qaCase.family, role: qaCase.role, variant: qaCase.variant });
}

export async function executeBrandVisualEvidence(session: StudioSession, project: LoadedProject, projectDigest: Sha256Digest, params: BrandVisualEvidenceParams, signal: AbortSignal): Promise<BrandVisualEvidenceResult> {
  if (session.negotiatedVersion !== "1.2" || !isQualifiedStudioRasterCapability(session.rasterCapability)) throw new ProtocolError("METHOD_CAPABILITY_UNAVAILABLE");
  if (project.brand?.brandSystemDigest === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
  const descriptor = session.rasterCapability.qa.descriptor;
  const renderer = Object.freeze({ id: descriptor.id, version: descriptor.version, qualificationId: descriptor.qualificationId, platformClaim: descriptor.platformClaim });
  check(signal);

  if (params.kind === "project-render") {
    assertDimensions(params.width, params.height);
    const target = resolveProjectAsset(project, params.target);
    const background = resolveBackground(project, params.background);
    const current = await render(session, target, params.width, params.height, background, signal);
    return finalize({ schema: "tfsb.studio-visual-evidence", schemaVersion: 1, kind: params.kind, projectDigest, brandSystemDigest: project.brand.brandSystemDigest, target: publicTarget(target), configuration: Object.freeze({ width: params.width, height: params.height, background: params.background }), renderer, artifacts: Object.freeze([artifact("current", current)]) });
  }

  if (params.kind === "qa-baseline") {
    const qa = project.brand.qaModel;
    if (qa === undefined || project.brand.qaDigest === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
    const profile = qa.profiles.find((entry) => entry.id === params.profileId);
    const qaCase = qa.cases.find((entry): entry is BrandQaBaselineCase => entry.id === params.caseId && entry.kind === "baseline");
    if (profile === undefined || qaCase === undefined || !profile.cases.includes(qaCase.id) || !isBrandQaVisualCase(qaCase) || qaCase.sizes.length !== 1 || qaCase.backgrounds.length !== 1) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
    const [width, height] = qaCase.sizes[0]!; assertDimensions(width, height);
    const target = resolveProjectAsset(project, baselineTarget(qaCase));
    if (target.canonicalAssetDigest !== qaCase.canonicalAssetDigest || target.svgDigest !== qaCase.svgDigest || descriptor.id !== qaCase.rendererId || descriptor.version !== qaCase.rendererVersion || descriptor.platformClaim !== qaCase.platformClaim) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
    const background = resolveBackground(project, qaCase.backgrounds[0]!);
    const baselineBytes = project.snapshot.files.get(qaCase.baselinePath)?.bytes;
    if (baselineBytes === undefined || sha(baselineBytes) !== qaCase.baselineDigest) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
    const baseline = await decodeBrandQaBaseline(session.rasterCapability.qa, baselineBytes, width, height); check(signal);
    const current = await render(session, target, width, height, background, signal);
    return finalize({ schema: "tfsb.studio-visual-evidence", schemaVersion: 1, kind: params.kind, projectDigest, brandSystemDigest: project.brand.brandSystemDigest, qaDigest: project.brand.qaDigest, target: publicTarget(target), configuration: Object.freeze({ width, height, background: qaCase.backgrounds[0]! }), renderer, artifacts: Object.freeze([artifact("baseline", baseline), artifact("current", current)]), difference: difference(baseline, current) });
  }

  assertDimensions(params.width, params.height);
  const sources = await session.handles.leaseBrandSources([params.sourceHandle]);
  try {
    await revalidateConsumerSources(sources); check(signal);
    const source = sources.packages[0]; if (source === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
    const beforeSnapshot = getVerifiedConsumerBrandDiffSnapshot(sources, source.packageId);
    const afterSnapshot = createLoadedProjectBrandDiffSnapshot(project);
    const beforeId = selectSnapshotAsset(beforeSnapshot, params.target);
    const afterId = selectSnapshotAsset(afterSnapshot, params.target);
    const beforeSource = getVerifiedConsumerBrandVisualAsset(sources, source.packageId, beforeId);
    const before: ResolvedVisualAsset = Object.freeze({ assetId: beforeId, canonicalAssetDigest: computeAssetSemanticDigest(beforeSource.asset), svgBytes: beforeSource.svgBytes, svgDigest: sha(beforeSource.svgBytes), ...(params.target.kind === "binding" ? { binding: Object.freeze({ family: params.target.family, role: params.target.role, variant: params.target.variant }) } : {}) });
    const after = resolveProjectAsset(project, params.target);
    if (after.assetId !== afterId) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
    const background = resolveBackground(project, params.background);
    const beforeRaster = await render(session, before, params.width, params.height, background, signal);
    const afterRaster = await render(session, after, params.width, params.height, background, signal);
    await revalidateConsumerSources(sources); check(signal);
    return finalize({ schema: "tfsb.studio-visual-evidence", schemaVersion: 1, kind: params.kind, projectDigest, brandSystemDigest: project.brand.brandSystemDigest, sourceDigest: beforeSnapshot.digest, target: publicTarget(after), configuration: Object.freeze({ width: params.width, height: params.height, background: params.background }), renderer, artifacts: Object.freeze([artifact("before", beforeRaster), artifact("after", afterRaster)]), difference: difference(beforeRaster, afterRaster) });
  } finally {
    await disposeConsumerSources(sources);
  }
}
