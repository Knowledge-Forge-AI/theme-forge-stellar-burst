import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, rm, rmdir, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { DiagnosticError, fail } from "../diagnostics.js";
import { computeAssetSemanticDigest, computeSha256, type Sha256Digest } from "../digests.js";
import { loadCanonicalProject, verifyLoadedProjectSnapshot, type LoadedProject } from "../project.js";
import { compareUtf8 } from "../provenance.js";
import { resolveConfinedPath } from "../root.js";
import { inspectPlanRetention, type PlanRetentionInspection } from "../plan-retention.js";
import { findRecoveryResidue, withCanonicalMutationLock } from "../transaction.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import { computeBrandExportOutputDigest, computeBrandExportProfileDigest, type BrandExportOutput, type BrandExportProfile } from "./export-profile.js";
import { decodeStrictPng, loadRasterCapability, validateRasterDescriptor, type RasterAdapterCapability, type RasterCapabilityStatus } from "./raster-capability.js";
import { createRasterReceipt, parseRasterReceipt, rasterReceiptPath, serializeRasterReceipt, type RasterAdapterDescriptor, type RasterReceipt } from "./raster-receipt.js";

export type RasterOwnershipState = "create" | "unchanged" | "stale-authority" | "RASTER_OUTPUT_DRIFT" | "RASTER_OUTPUT_OWNED_BY_HUMAN" | "RASTER_OUTPUT_MISSING" | "RASTER_RECEIPT_INVALID" | "RASTER_OWNERSHIP_CONFLICT";

export interface RasterStateEntry {
  readonly profileId: string;
  readonly outputId: string;
  readonly assetId?: string;
  readonly binding?: Readonly<{ readonly family: string; readonly role: string; readonly variant: string }>;
  readonly destination: string;
  readonly receiptPath: string;
  readonly state: RasterOwnershipState;
  readonly width?: number;
  readonly height?: number;
  readonly purpose?: string;
  readonly background?: string;
  readonly alpha?: "straight" | "opaque";
  readonly canonicalAssetDigest?: Sha256Digest;
  readonly svgDigest?: Sha256Digest;
  readonly profileDigest?: Sha256Digest;
  readonly outputConfigDigest?: Sha256Digest;
  readonly pngDigest?: Sha256Digest;
  readonly decodedPixelDigest?: Sha256Digest;
  readonly receiptDigest?: Sha256Digest;
}

export interface RasterStateInspection {
  readonly capability: Readonly<{ available: boolean; code?: "EXPORT_CAPABILITY_UNAVAILABLE"; descriptor?: RasterAdapterDescriptor }>;
  readonly entries: readonly RasterStateEntry[];
  readonly counts: Readonly<Record<RasterOwnershipState, number>>;
  readonly drift: boolean;
}

export interface RasterExportPlanOutputSummary {
  readonly profileId: string;
  readonly outputId: string;
  readonly assetId: string;
  readonly destination: string;
  readonly state: "create" | "update" | "unchanged";
  readonly width: number;
  readonly height: number;
  readonly purpose: string;
  readonly fit: "contain-pad";
  readonly background: string;
  readonly alpha: "straight" | "opaque";
  readonly canonicalAssetDigest: Sha256Digest;
  readonly svgDigest: Sha256Digest;
  readonly profileDigest: Sha256Digest;
  readonly outputConfigDigest: Sha256Digest;
  readonly rendererBuildDigest: Sha256Digest;
  readonly pngDigest: Sha256Digest;
  readonly decodedPixelDigest: Sha256Digest;
  readonly receiptDigest: Sha256Digest;
}

const rasterPlanBrand: unique symbol = Symbol("tfsb-raster-export-plan");
export interface RasterExportPlan {
  readonly profileId: string;
  readonly adapter: RasterAdapterDescriptor;
  readonly outputs: readonly RasterExportPlanOutputSummary[];
  readonly counts: Readonly<{ create: number; update: number; unchanged: number }>;
  readonly warnings: readonly string[];
  readonly [rasterPlanBrand]: true;
}

export interface RasterExportPlanOptions {
  readonly profileId: string;
  readonly outputIds?: readonly string[];
  readonly capability?: RasterCapabilityStatus;
}

export interface RasterExportResult {
  readonly profileId: string;
  readonly writtenOutputs: number;
  readonly unchangedOutputs: number;
  readonly dryRun: boolean;
  readonly destinations: readonly string[];
}

export type RasterTransactionEvent = "after-stage" | "after-journal" | "before-backup" | "after-backup" | "before-output-promotion" | "after-output-promotion" | "before-receipt-promotion" | "after-receipt-promotion" | "before-rollback" | "after-rollback" | "before-cleanup" | "after-cleanup";
export interface RasterTransactionHooks { readonly onEvent?: (event: RasterTransactionEvent, relativePath?: string) => void | Promise<void>; }

interface FileState { readonly kind: "absent" | "file" | "other"; readonly bytes?: Uint8Array; readonly digest?: Sha256Digest; readonly dev?: number; readonly ino?: number; }
interface ParentState { readonly path: string; readonly dev: number; readonly ino: number; }
interface PlannedOutput { readonly summary: RasterExportPlanOutputSummary; readonly output: BrandExportOutput; readonly pngBytes: Uint8Array; readonly receiptBytes: Uint8Array; readonly outputBefore: FileState; readonly receiptBefore: FileState; readonly outputParent: ParentState; readonly receiptParent: ParentState; readonly outputAbsolute: string; readonly receiptAbsolute: string; }
interface PlanInternals { readonly project: LoadedProject; readonly profile: BrandExportProfile; readonly adapter: RasterAdapterCapability; readonly outputs: readonly PlannedOutput[]; disposed: boolean; executed: boolean; }
const planInternals = new WeakMap<RasterExportPlan, PlanInternals>();

function ctx() { return { operation: "export" as const, domain: "brand" as const }; }
function sha(bytes: Uint8Array): Sha256Digest { return computeSha256(bytes); }
function pathsOverlap(left: string, right: string): boolean { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }
function deepFreeze<T>(value: T): T { if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value; for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); return Object.freeze(value); }

async function fileState(path: string, maxBytes: number): Promise<FileState> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (stat === undefined) return Object.freeze({ kind: "absent" });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return Object.freeze({ kind: "other", dev: stat.dev, ino: stat.ino });
  const bytes = new Uint8Array(await readFile(path)); const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) fail(ctx(), "RASTER_OUTPUT_CHANGED", "Raster output changed during inspection.", path);
  return Object.freeze({ kind: "file", bytes, digest: sha(bytes), dev: stat.dev, ino: stat.ino });
}

async function nearestExistingParent(path: string, root: string): Promise<ParentState> {
  let cursor = dirname(path);
  for (;;) {
    const stat = await lstat(cursor).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (stat !== undefined) { if (!stat.isDirectory() || stat.isSymbolicLink()) fail(ctx(), "RASTER_PARENT_CHANGED", "Nearest raster parent is not a safe directory."); return Object.freeze({ path: cursor, dev: stat.dev, ino: stat.ino }); }
    const next = dirname(cursor); if (next === cursor || relative(root, next).startsWith("..")) fail(ctx(), "RASTER_PARENT_CHANGED", "Raster parent authority escapes the project root."); cursor = next;
  }
}

async function sameParent(expected: ParentState): Promise<boolean> { const stat = await lstat(expected.path).catch(() => undefined); return stat !== undefined && stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino; }

function resolveAsset(project: LoadedProject, output: BrandExportOutput): { readonly id: string; readonly canonicalAssetDigest: Sha256Digest; readonly svgBytes: Uint8Array; readonly svgDigest: Sha256Digest } {
  let id = output.asset;
  if (id === undefined) {
    const matches = project.brand!.model.bindings.filter((binding) => binding.family === output.family && binding.role === output.role && binding.variant === output.variant);
    if (matches.length !== 1) fail(ctx(), "BRAND_EXPORT_SELECTOR_AMBIGUOUS", "Raster output selector no longer resolves exactly one asset.");
    id = matches[0]!.asset;
  }
  const asset = project.assets.find((entry) => entry.id === id); if (asset === undefined) fail(ctx(), "BRAND_EXPORT_UNKNOWN_ASSET", `Raster output references unknown asset '${id}'.`);
  const svgBytes = project.outputs.get(asset.filename); if (svgBytes === undefined) fail(ctx(), "BRAND_EXPORT_SOURCE_UNAVAILABLE", `Canonical SVG for '${id}' is unavailable.`);
  return Object.freeze({ id, canonicalAssetDigest: computeAssetSemanticDigest(asset), svgBytes: new Uint8Array(svgBytes), svgDigest: sha(svgBytes) });
}

function resolvedBackground(project: LoadedProject, output: BrandExportOutput): { readonly text: "transparent" | `#${string}`; readonly rgba: readonly [number, number, number, number] | null } {
  const text = output.background ?? project.brand!.tokensModel!.colors.find((entry) => entry.id === output.backgroundToken)!.value;
  if (text === "transparent") return Object.freeze({ text, rgba: null });
  return Object.freeze({ text: text as `#${string}`, rgba: Object.freeze([Number.parseInt(text.slice(1, 3), 16), Number.parseInt(text.slice(3, 5), 16), Number.parseInt(text.slice(5, 7), 16), Number.parseInt(text.slice(7, 9), 16)] as [number, number, number, number]) });
}

function receiptMatchesCurrent(receipt: RasterReceipt, project: LoadedProject, profile: BrandExportProfile, output: BrandExportOutput, asset: ReturnType<typeof resolveAsset>, background: string, capability: RasterCapabilityStatus): boolean {
  if (receipt.exportAuthority.profileId !== profile.id || receipt.exportAuthority.outputId !== output.id || receipt.output.destination !== output.destination || receipt.source.assetId !== asset.id || receipt.source.canonicalAssetDigest !== asset.canonicalAssetDigest || receipt.source.svgDigest !== asset.svgDigest || receipt.source.brandSystemDigest !== project.brand!.brandSystemDigest || receipt.exportAuthority.rawExportFileDigest !== project.brand!.rawExportsFileDigest || receipt.exportAuthority.exportDomainDigest !== project.brand!.exportsDigest || receipt.exportAuthority.profileDigest !== computeBrandExportProfileDigest(profile) || receipt.exportAuthority.outputConfigDigest !== computeBrandExportOutputDigest(output) || receipt.output.width !== output.width || receipt.output.height !== output.height || receipt.output.purpose !== output.purpose || receipt.output.fit !== output.fit || receipt.output.background !== background || receipt.output.colorSpace !== output.colorSpace || receipt.output.alpha !== output.alpha) return false;
  if (capability.available && encodeCanonicalJson(receipt.adapter) !== encodeCanonicalJson(capability.adapter.descriptor)) return false;
  return true;
}

async function inspectLoadedProject(project: LoadedProject, capability: RasterCapabilityStatus): Promise<RasterStateInspection> {
  if (project.brand?.exportsModel === undefined || project.brand.brandSystemDigest === undefined || project.brand.exportsDigest === undefined || project.brand.rawExportsFileDigest === undefined) fail(ctx(), "BRAND_EXPORT_DOMAIN_UNAVAILABLE", "Raster export requires an enabled complete export domain.");
  const entries: RasterStateEntry[] = [], knownReceipts = new Set<string>(), receiptClaims = new Map<string, number[]>();
  for (const profile of project.brand.exportsModel.profiles) for (const output of profile.outputs) {
    const receiptPath = rasterReceiptPath(profile.id, output.id); knownReceipts.add(receiptPath);
    const outputAbsolute = await resolveConfinedPath(project.root, output.destination, "export"); const receiptAbsolute = join(project.root, ...receiptPath.split("/"));
    const [out, rec] = await Promise.all([fileState(outputAbsolute, 32 * 1_048_576), fileState(receiptAbsolute, 1_048_576)]);
    let state: RasterOwnershipState; let receipt: RasterReceipt | undefined;
    if (out.kind === "other") state = "RASTER_OUTPUT_OWNED_BY_HUMAN";
    else if (rec.kind === "other") state = "RASTER_RECEIPT_INVALID";
    else if (out.kind === "absent" && rec.kind === "absent") state = "create";
    else if (out.kind === "file" && rec.kind === "absent") state = "RASTER_OUTPUT_OWNED_BY_HUMAN";
    else if (out.kind === "absent" && rec.kind === "file") state = "RASTER_OUTPUT_MISSING";
    else {
      let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(rec.bytes!); } catch { text = ""; }
      const parsed = parseRasterReceipt(text, receiptPath);
      if (!parsed.ok) state = "RASTER_RECEIPT_INVALID";
      else {
        receipt = parsed.value;
        const claim = receipt.output.destination.normalize("NFC").toLowerCase(), indices = receiptClaims.get(claim) ?? []; indices.push(entries.length); receiptClaims.set(claim, indices);
        const pathIds = receiptPath.split("/");
        if (receipt.exportAuthority.profileId !== profile.id || receipt.exportAuthority.outputId !== output.id || pathIds.at(-2) !== profile.id || pathIds.at(-1) !== `${output.id}.receipt.json` || receipt.output.destination !== output.destination) state = "RASTER_RECEIPT_INVALID";
        else if (receipt.output.pngDigest !== out.digest) state = "RASTER_OUTPUT_DRIFT";
        else {
          try {
            const decoded = decodeStrictPng(out.bytes!, receipt.output.width, receipt.output.height);
            if (decoded.decodedPixelDigest !== receipt.output.decodedPixelDigest) state = "RASTER_RECEIPT_INVALID";
            else if (receipt.output.alpha === "opaque" && decoded.rgba8.some((channel, index) => index % 4 === 3 && channel !== 255)) state = "RASTER_RECEIPT_INVALID";
            else { const asset = resolveAsset(project, output), background = resolvedBackground(project, output).text; state = receiptMatchesCurrent(receipt, project, profile, output, asset, background, capability) ? "unchanged" : "stale-authority"; }
          } catch { state = "RASTER_RECEIPT_INVALID"; }
        }
      }
    }
    const background = resolvedBackground(project, output).text;
    entries.push(Object.freeze({
      profileId: profile.id,
      outputId: output.id,
      ...(output.asset === undefined
        ? { binding: Object.freeze({ family: output.family!, role: output.role!, variant: output.variant! }) }
        : { assetId: output.asset }),
      destination: output.destination,
      receiptPath,
      state,
      width: output.width,
      height: output.height,
      purpose: output.purpose,
      background,
      alpha: output.alpha,
      profileDigest: computeBrandExportProfileDigest(profile),
      outputConfigDigest: computeBrandExportOutputDigest(output),
      ...(out.digest === undefined ? {} : { pngDigest: out.digest }),
      ...(receipt === undefined ? {} : {
        canonicalAssetDigest: receipt.source.canonicalAssetDigest,
        svgDigest: receipt.source.svgDigest,
        decodedPixelDigest: receipt.output.decodedPixelDigest,
        receiptDigest: receipt.evidence.receiptDigest,
      }),
    }));
  }
  for (const indices of receiptClaims.values()) if (indices.length > 1) for (const index of indices) entries[index] = Object.freeze({ ...entries[index]!, state: "RASTER_OWNERSHIP_CONFLICT" });
  for (const path of project.snapshot.files.keys()) if (path.startsWith(".tfsb/raster-receipts/") && !knownReceipts.has(path)) entries.push(Object.freeze({ profileId: "unknown", outputId: "unknown", destination: "", receiptPath: path, state: "RASTER_RECEIPT_INVALID" }));
  entries.sort((left, right) => compareUtf8(`${left.profileId}/${left.outputId}`, `${right.profileId}/${right.outputId}`));
  const counts = { create: 0, unchanged: 0, "stale-authority": 0, RASTER_OUTPUT_DRIFT: 0, RASTER_OUTPUT_OWNED_BY_HUMAN: 0, RASTER_OUTPUT_MISSING: 0, RASTER_RECEIPT_INVALID: 0, RASTER_OWNERSHIP_CONFLICT: 0 } satisfies Record<RasterOwnershipState, number>;
  for (const entry of entries) counts[entry.state]++;
  return deepFreeze({ capability: capability.available ? { available: true, descriptor: capability.adapter.descriptor } : { available: false, code: capability.code }, entries, counts, drift: entries.some((entry) => entry.state !== "unchanged") });
}

export async function inspectRasterExportState(root: string, capability?: RasterCapabilityStatus): Promise<RasterStateInspection> {
  return inspectLoadedProject(await loadCanonicalProject(root, "check"), capability ?? await loadRasterCapability());
}

function assertDestinationBoundary(project: LoadedProject, output: BrandExportOutput): void {
  const destination = output.destination.toLowerCase(), build = project.project.buildDirectory.toLowerCase();
  if (pathsOverlap(destination, build)) fail(ctx(), "RASTER_DESTINATION_PROTECTED", `Raster destination '${output.destination}' overlaps the project build directory.`);
  const absolute = join(project.root, ...output.destination.split("/"));
  for (const values of [...project.installDestinations.values(), ...project.companionDestinations.values()]) for (const existing of values) {
    const existingRelative = relative(project.root, existing).split(sep).join("/").toLowerCase();
    if (pathsOverlap(destination, existingRelative) || absolute === existing) fail(ctx(), "RASTER_DESTINATION_PROTECTED", `Raster destination '${output.destination}' overlaps an explicit install destination.`);
  }
  for (const companion of project.brand?.packageModel?.companions ?? []) {
    if (pathsOverlap(destination, companion.source.toLowerCase())) fail(ctx(), "RASTER_DESTINATION_PROTECTED", `Raster destination '${output.destination}' overlaps brand package source '${companion.source}'.`);
  }
}

export async function planRasterExport(root: string, options: RasterExportPlanOptions): Promise<RasterExportPlan> {
  const project = await loadCanonicalProject(root, "export");
  if (project.brand?.exportsModel === undefined || project.brand.brandSystemDigest === undefined || project.brand.exportsDigest === undefined || project.brand.rawExportsFileDigest === undefined) fail(ctx(), "BRAND_EXPORT_DOMAIN_UNAVAILABLE", "Raster export domain is unavailable.");
  const capability = options.capability ?? await loadRasterCapability(); if (!capability.available) fail(ctx(), capability.code, capability.reason);
  if (options.capability !== undefined && options.capability.available) { try { validateRasterDescriptor(options.capability.adapter.descriptor); } catch (error) { fail(ctx(), "EXPORT_CAPABILITY_UNAVAILABLE", error instanceof Error ? error.message : "Injected capability descriptor is invalid."); } }
  const profile = project.brand.exportsModel.profiles.find((entry) => entry.id === options.profileId); if (profile === undefined) fail(ctx(), "BRAND_EXPORT_PROFILE_NOT_FOUND", `Unknown export profile '${options.profileId}'.`);
  const requested = options.outputIds === undefined ? profile.outputs.map((entry) => entry.id) : [...options.outputIds];
  if (new Set(requested).size !== requested.length) fail(ctx(), "BRAND_EXPORT_DUPLICATE_OUTPUT", "Output selection contains duplicates.");
  const selected = requested.map((id) => { const output = profile.outputs.find((entry) => entry.id === id); if (output === undefined) fail(ctx(), "BRAND_EXPORT_OUTPUT_NOT_FOUND", `Output '${id}' does not belong to profile '${profile.id}'.`); return output; }).sort((a, b) => compareUtf8(a.id, b.id));
  if (selected.length < 1 || selected.length > 128 || selected.reduce((sum, output) => sum + output.width * output.height * 4, 0) > 256 * 1_048_576) fail(ctx(), "RESOURCE_LIMIT_EXCEEDED", "Resolved export selection exceeds phase limits.");
  const inspection = await inspectLoadedProject(project, capability); const planned: PlannedOutput[] = [];
  for (const output of selected) {
    assertDestinationBoundary(project, output);
    const state = inspection.entries.find((entry) => entry.profileId === profile.id && entry.outputId === output.id)!;
    if (!["create", "unchanged", "stale-authority"].includes(state.state)) fail(ctx(), state.state, `Raster output '${profile.id}/${output.id}' is blocked in state ${state.state}.`, output.destination);
    const asset = resolveAsset(project, output), background = resolvedBackground(project, output), outputAbsolute = await resolveConfinedPath(project.root, output.destination, "export"), receiptRelative = rasterReceiptPath(profile.id, output.id), receiptAbsolute = join(project.root, ...receiptRelative.split("/"));
    const [outputBefore, receiptBefore, outputParent, receiptParent] = await Promise.all([fileState(outputAbsolute, 32 * 1_048_576), fileState(receiptAbsolute, 1_048_576), nearestExistingParent(outputAbsolute, project.root), nearestExistingParent(receiptAbsolute, project.root)]);
    let pngBytes: Uint8Array, pixelDigest: Sha256Digest;
    if (state.state === "unchanged") { pngBytes = new Uint8Array(outputBefore.bytes!); const parsed = parseRasterReceipt(new TextDecoder().decode(receiptBefore.bytes!), receiptRelative); if (!parsed.ok) fail(ctx(), "RASTER_RECEIPT_INVALID", "Receipt changed during planning."); pixelDigest = parsed.value.output.decodedPixelDigest; }
    else { const rendered = await capability.adapter.renderSvg({ canonicalSvgBytes: asset.svgBytes, width: output.width, height: output.height, backgroundRgba: background.rgba, alpha: output.alpha, fit: "contain-pad", colorSpace: "srgb" }); pngBytes = rendered.pngBytes; pixelDigest = sha(rendered.rgba8); }
    const receipt = createRasterReceipt({ adapter: capability.adapter.descriptor, source: { assetId: asset.id, canonicalAssetDigest: asset.canonicalAssetDigest, svgDigest: asset.svgDigest, brandSystemDigest: project.brand.brandSystemDigest }, exportAuthority: { rawExportFileDigest: project.brand.rawExportsFileDigest, exportDomainDigest: project.brand.exportsDigest, profileId: profile.id, profileDigest: computeBrandExportProfileDigest(profile), outputId: output.id, outputConfigDigest: computeBrandExportOutputDigest(output) }, output: { destination: output.destination, width: output.width, height: output.height, purpose: output.purpose, fit: output.fit, background: background.text, colorSpace: output.colorSpace, alpha: output.alpha, pngDigest: sha(pngBytes), decodedPixelDigest: pixelDigest } });
    const receiptBytes = Buffer.from(serializeRasterReceipt(receipt), "utf8");
    const summary: RasterExportPlanOutputSummary = deepFreeze({ profileId: profile.id, outputId: output.id, assetId: asset.id, destination: output.destination, state: state.state === "create" ? "create" : state.state === "unchanged" ? "unchanged" : "update", width: output.width, height: output.height, purpose: output.purpose, fit: output.fit, background: background.text, alpha: output.alpha, canonicalAssetDigest: asset.canonicalAssetDigest, svgDigest: asset.svgDigest, profileDigest: computeBrandExportProfileDigest(profile), outputConfigDigest: computeBrandExportOutputDigest(output), rendererBuildDigest: capability.adapter.descriptor.rendererBuildDigest, pngDigest: receipt.output.pngDigest, decodedPixelDigest: pixelDigest, receiptDigest: receipt.evidence.receiptDigest });
    planned.push(Object.freeze({ summary, output, pngBytes: new Uint8Array(pngBytes), receiptBytes: new Uint8Array(receiptBytes), outputBefore, receiptBefore, outputParent, receiptParent, outputAbsolute, receiptAbsolute }));
  }
  if (planned.reduce((sum, entry) => sum + entry.pngBytes.byteLength, 0) > 256 * 1_048_576) fail(ctx(), "RESOURCE_LIMIT_EXCEEDED", "Raster export plan exceeds the 256 MiB staged PNG limit.");
  const summaries = Object.freeze(planned.map((entry) => entry.summary)); const plan = deepFreeze({ profileId: profile.id, adapter: capability.adapter.descriptor, outputs: summaries, counts: { create: summaries.filter((entry) => entry.state === "create").length, update: summaries.filter((entry) => entry.state === "update").length, unchanged: summaries.filter((entry) => entry.state === "unchanged").length }, warnings: [], [rasterPlanBrand]: true }) as RasterExportPlan;
  planInternals.set(plan, { project, profile, adapter: capability.adapter, outputs: Object.freeze(planned), disposed: false, executed: false }); return plan;
}

function getInternals(plan: RasterExportPlan): PlanInternals { const internals = planInternals.get(plan); if (internals === undefined || plan[rasterPlanBrand] !== true) fail(ctx(), "RASTER_PLAN_INVALID", "Raster export plan has no private authority."); if (internals.disposed || internals.executed) fail(ctx(), "RASTER_PLAN_CONSUMED", "Raster export plan was already consumed or disposed."); return internals; }
export function disposeRasterExportPlan(plan: RasterExportPlan): void { const internals = planInternals.get(plan); if (internals !== undefined) { internals.disposed = true; for (const output of internals.outputs) { output.pngBytes.fill(0); output.receiptBytes.fill(0); } planInternals.delete(plan); } }

/** Internal Studio retention seam; not re-exported from the package root. */
export function inspectRasterExportPlanRetention(plan: RasterExportPlan): PlanRetentionInspection { const internals = planInternals.get(plan); if (internals === undefined) throw new Error("Raster export plan was not produced by this planner instance."); return inspectPlanRetention([plan, internals]); }

async function sync(path: string): Promise<void> {
  try {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error: any) {
    if (process.platform === "win32" && (error?.code === "EPERM" || error?.code === "EISDIR" || error?.code === "EINVAL")) {
      return;
    }
    throw error;
  }
}
async function durableWrite(path: string, bytes: Uint8Array): Promise<void> { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); await sync(path); }
async function sameState(path: string, expected: FileState, maxBytes: number): Promise<boolean> { const current = await fileState(path, maxBytes); return current.kind === expected.kind && current.dev === expected.dev && current.ino === expected.ino && current.digest === expected.digest; }

export async function executeRasterExportPlan(plan: RasterExportPlan, options: { readonly dryRun?: boolean; readonly hooks?: RasterTransactionHooks } = {}): Promise<RasterExportResult> {
  const internals = getInternals(plan); internals.executed = true; planInternals.delete(plan);
  try {
    await verifyLoadedProjectSnapshot(internals.project, "export");
    for (const output of internals.outputs) if (!await sameParent(output.outputParent) || !await sameParent(output.receiptParent) || !await sameState(output.outputAbsolute, output.outputBefore, 32 * 1_048_576) || !await sameState(output.receiptAbsolute, output.receiptBefore, 1_048_576)) fail(ctx(), "RASTER_PLAN_STALE", "Raster parent, output, or receipt changed after planning.", output.summary.destination);
    const changing = internals.outputs.filter((entry) => entry.summary.state !== "unchanged");
    if (options.dryRun === true || changing.length === 0) return deepFreeze({ profileId: plan.profileId, writtenOutputs: 0, unchangedOutputs: plan.counts.unchanged, dryRun: options.dryRun === true, destinations: plan.outputs.map((entry) => entry.destination) });
    return await withCanonicalMutationLock(internals.project.root, "export", async () => {
      const residue = await findRecoveryResidue(internals.project.root); if (residue.length > 0) fail(ctx(), "TFSB_RECOVERY_REQUIRED", `Recovery residue requires manual inspection: ${residue.join(", ")}.`, residue[0]);
      await verifyLoadedProjectSnapshot(internals.project, "export");
      for (const output of internals.outputs) if (!await sameParent(output.outputParent) || !await sameParent(output.receiptParent) || !await sameState(output.outputAbsolute, output.outputBefore, 32 * 1_048_576) || !await sameState(output.receiptAbsolute, output.receiptBefore, 1_048_576)) fail(ctx(), "RASTER_PLAN_STALE", "Raster parent or target state changed before staging.");
      const token = randomUUID().replace(/-/g, ""), staged: { target: string; relative: string; kind: "output" | "receipt"; stage: string; backup: string; bytes: Uint8Array; expected: FileState; stageState: FileState; promoted: boolean; backedUp: boolean; state: "staged" | "backed-up" | "promoted"; width?: number; height?: number; pixelDigest?: Sha256Digest; handle?: FileHandle }[] = [], createdDirectories: string[] = [];
      const journal = join(internals.project.root, `.tfsb-raster-transaction-${token}.json`); let journalWritten = false;
      const ensureParent = async (path: string): Promise<void> => { const parent = dirname(path), missing: string[] = []; let cursor = parent; for (;;) { const before = await lstat(cursor).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error)); if (before !== undefined) break; missing.push(cursor); const next = dirname(cursor); if (next === cursor || relative(internals.project.root, next).startsWith("..")) fail(ctx(), "RASTER_PARENT_CHANGED", "Raster output parent escapes the project root."); cursor = next; } if (missing.length > 0) { await mkdir(parent, { recursive: true, mode: 0o700 }); createdDirectories.push(...missing.reverse()); } await resolveConfinedPath(internals.project.root, relative(internals.project.root, path).split(sep).join("/"), "export"); const stat = await lstat(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) fail(ctx(), "RASTER_PARENT_CHANGED", "Raster output parent is unsafe."); };
      try {
        for (const output of changing) for (const item of [{ kind: "output" as const, target: output.outputAbsolute, relative: output.summary.destination, bytes: output.pngBytes, expected: output.outputBefore, width: output.summary.width, height: output.summary.height, pixelDigest: output.summary.decodedPixelDigest }, { kind: "receipt" as const, target: output.receiptAbsolute, relative: rasterReceiptPath(output.summary.profileId, output.summary.outputId), bytes: output.receiptBytes, expected: output.receiptBefore }]) {
          await ensureParent(item.target); const stage = join(dirname(item.target), `.${basename(item.target)}.tfsb-raster-stage-${token}`), backup = join(dirname(item.target), `.${basename(item.target)}.tfsb-raster-backup-${token}`); await durableWrite(stage, item.bytes); const stageEntry: (typeof staged)[number] = { ...item, stage, backup, stageState: { kind: "file" }, promoted: false, backedUp: false, state: "staged" }; staged.push(stageEntry); const stageState = await fileState(stage, item.kind === "receipt" ? 1_048_576 : 32 * 1_048_576); if (stageState.kind !== "file" || stageState.digest !== sha(item.bytes)) fail(ctx(), "RASTER_STAGE_INVALID", "Raster stage identity or bytes are invalid.", item.relative); stageEntry.stageState = stageState; if (item.kind === "output") { const decoded = decodeStrictPng(stageState.bytes!, item.width, item.height); if (decoded.decodedPixelDigest !== item.pixelDigest) fail(ctx(), "RASTER_STAGE_INVALID", "Staged PNG pixels differ from the plan.", item.relative); } else { const parsed = parseRasterReceipt(new TextDecoder("utf-8", { fatal: true }).decode(stageState.bytes!), item.relative); if (!parsed.ok) fail(ctx(), "RASTER_STAGE_INVALID", "Staged raster receipt is invalid.", item.relative); } const handle = await open(stage, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); stageEntry.handle = handle; await sync(dirname(item.target)); await options.hooks?.onEvent?.("after-stage", item.relative);
        }
        const journalBytes = Buffer.from(`${encodeCanonicalJson({ schema: "tfsb.raster-transaction", schemaVersion: 1, outputsFirst: true, entries: staged.map((entry) => ({ target: entry.relative, stage: basename(entry.stage), backup: basename(entry.backup), state: entry.state })) })}\n`, "utf8"); await durableWrite(journal, journalBytes); journalWritten = true; await sync(internals.project.root); await options.hooks?.onEvent?.("after-journal");
        const ordered = [...staged].sort((left, right) => { const leftReceipt = left.relative.startsWith(".tfsb/raster-receipts/"); const rightReceipt = right.relative.startsWith(".tfsb/raster-receipts/"); return leftReceipt === rightReceipt ? compareUtf8(left.relative, right.relative) : leftReceipt ? 1 : -1; });
        for (const item of ordered) {
          await resolveConfinedPath(internals.project.root, item.relative, "export");
          if (!await sameState(item.stage, item.stageState, item.kind === "receipt" ? 1_048_576 : 32 * 1_048_576)) fail(ctx(), "RASTER_STAGE_INVALID", "Raster stage changed before promotion.", item.relative);
          if (!await sameState(item.target, item.expected, item.relative.startsWith(".tfsb/") ? 1_048_576 : 32 * 1_048_576)) fail(ctx(), "RASTER_PLAN_STALE", "Raster target changed before promotion.", item.relative);
          if (item.expected.kind === "file") { await options.hooks?.onEvent?.("before-backup", item.relative); await rename(item.target, item.backup); item.backedUp = true; item.state = "backed-up"; await options.hooks?.onEvent?.("after-backup", item.relative); }
          else if (item.expected.kind !== "absent") fail(ctx(), "RASTER_OUTPUT_OWNED_BY_HUMAN", "Raster target is not replaceable.", item.relative);
          const receipt = item.kind === "receipt"; await options.hooks?.onEvent?.(receipt ? "before-receipt-promotion" : "before-output-promotion", item.relative); await link(item.stage, item.target); await rm(item.stage); item.promoted = true; item.state = "promoted"; await sync(dirname(item.target)); await options.hooks?.onEvent?.(receipt ? "after-receipt-promotion" : "after-output-promotion", item.relative);
        }
      } catch (error) {
        let recoveryRequired = false; try { await options.hooks?.onEvent?.("before-rollback"); } catch { recoveryRequired = true; }
        for (const item of [...staged].reverse()) try { if (item.promoted) { const current = await fileState(item.target, item.relative.startsWith(".tfsb/") ? 1_048_576 : 32 * 1_048_576); if (current.kind === "file" && current.digest === sha(item.bytes)) await rm(item.target); else recoveryRequired = true; } if (item.backedUp) { if ((await lstat(item.target).catch(() => undefined)) === undefined) await rename(item.backup, item.target); else recoveryRequired = true; } await rm(item.stage, { force: true }); await item.handle?.close(); } catch { recoveryRequired = true; }
        for (const directory of [...createdDirectories].reverse()) await rmdir(directory).catch(() => undefined);
        try { await options.hooks?.onEvent?.("after-rollback"); } catch { recoveryRequired = true; }
        if (!recoveryRequired && journalWritten) await rm(journal, { force: true });
        throw new DiagnosticError({ code: recoveryRequired ? "RASTER_RECOVERY_REQUIRED" : "RASTER_TRANSACTION_ROLLED_BACK", operation: "export", domain: "transaction", message: recoveryRequired ? "Raster transaction failed and retained recovery residue." : "Raster transaction failed and was rolled back." });
      }
      let cleanupFailed = false; try { await options.hooks?.onEvent?.("before-cleanup"); } catch { cleanupFailed = true; } for (const item of staged) try { if (item.backedUp) await rm(item.backup); await rm(item.stage, { force: true }); await item.handle?.close(); await sync(dirname(item.target)); } catch { cleanupFailed = true; }
      try { await options.hooks?.onEvent?.("after-cleanup"); } catch { cleanupFailed = true; }
      if (!cleanupFailed) { await rm(journal, { force: true }); await sync(internals.project.root); }
      if (cleanupFailed) fail(ctx(), "RASTER_RECOVERY_REQUIRED", "Raster outputs were promoted but cleanup residue remains.");
      return deepFreeze({ profileId: plan.profileId, writtenOutputs: changing.length, unchangedOutputs: plan.counts.unchanged, dryRun: false, destinations: plan.outputs.map((entry) => entry.destination) });
    });
  } finally { internals.disposed = true; for (const output of internals.outputs) { output.pngBytes.fill(0); output.receiptBytes.fill(0); } }
}

export async function exportRasterProject(root: string, options: RasterExportPlanOptions & { readonly dryRun?: boolean }): Promise<RasterExportResult> {
  const plan = await planRasterExport(root, options); return executeRasterExportPlan(plan, options.dryRun === undefined ? {} : { dryRun: options.dryRun });
}
