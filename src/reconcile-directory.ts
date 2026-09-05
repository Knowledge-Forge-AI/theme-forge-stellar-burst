import { basename, join, resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";

import { isAllowedCompanionFilename } from "./archive.js";
import { isFixedBrandFilePath } from "./brand/brand-files.js";
import {
  closeDirectorySnapshot,
  computeDirectorySnapshotDigest,
  copyDirectorySnapshotFileBytes,
  createDirectorySnapshot,
  inspectDirectorySnapshotRetention,
  readDirectorySnapshotAuthorityFile,
  revalidateDirectorySnapshot,
  type AuthenticatedDirectorySnapshot,
  type DirectoryCompanionDto,
  type DirectoryFileDto,
} from "./directory-snapshot.js";
import { computeAssetSemanticDigest, computeCompanionByteDigest, computeSha256, type Sha256Digest } from "./digests.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import { readRegularFileSnapshot, sameFileIdentity, type PresentFileSnapshot } from "./filesystem.js";
import { normalizeCommonSvg } from "./normalizer.js";
import { inspectPlanRetention, mergePlanRetention, type PlanRetentionInspection } from "./plan-retention.js";
import type { NormalizationLedgerEntryV1, NormalizationLedgerV1 } from "./normalization-ledger.js";
import { parseNormalizationMap, unwrapNormalizationMap, type NormalizationMapV1 } from "./normalization-map.js";
import { createNormalizationPolicyIdentity, normalizationPolicyMatches, type NormalizationPolicyIdentityV1 } from "./normalization-policy.js";
import { loadCanonicalProjectFromSnapshot } from "./project.js";
import {
  parseImportProvenanceV2,
  unwrapProvenanceV2,
} from "./provenance2.js";
import {
  liftImportProvenanceV2ToV3,
  parseImportProvenanceV3,
  serializeImportProvenanceV3,
  unwrapProvenanceV3,
  type AssetProvenanceRecordV3,
  type CompanionProvenanceRecordV3,
  type DirectoryCanonicalBasisV3,
  type DirectorySourceCheckpointV3,
  type ImportProvenanceV3,
  type ProvenanceRecordV3,
  type ProvenanceSourceCheckpointV3,
} from "./provenance3.js";
import { findProjectRoot, validateProjectPathLayout } from "./root.js";
import { parseAssetTomlV2, parseProjectTomlV2, serializeAssetTomlV2, serializeProjectTomlV2 } from "./schema2-toml.js";
import { parseSvgV2, serializeSvgV2 } from "./schema2-svg.js";
import type { NormalizedAssetV2, NormalizedProjectV2 } from "./schema2-types.js";
import { scanAnalyzeSvg } from "./analyze-scanner.js";
import { computeSourceMapDigest, parseSourceMap, SOURCE_MAP_FILENAME, type SourceMapV1 } from "./source-map.js";
import { validatePortablePathValue } from "./source-identity.js";
import { SHARD_MANIFEST_MAX_BYTES, parseShardManifest, type ShardManifestV1 } from "./shard.js";
import {
  executeCanonicalTransaction,
  snapshotCanonicalTree,
  type CanonicalSnapshot,
  type CanonicalTree,
  type TransactionHooks,
} from "./transaction.js";
import type { Result } from "./types.js";
import { TOOL_VERSION } from "./version.js";

/** Directory reconcile deliberately has no archive-side classification vocabulary. */
export type DirectoryReconciliationClassification =
  | "UNCHANGED"
  | "SOURCE_CHANGED"
  | "SOURCE_FORMATTING_ONLY"
  | "CANONICAL_CHANGED"
  | "BOTH_CHANGED"
  | "CONVERGED"
  | "SOURCE_OMISSION"
  | "NEW_SOURCE"
  | "ACCEPTED_CANONICAL_DIVERGENCE"
  | "ACCEPTED_SOURCE_ABSENCE"
  | "RENAME_REQUIRED"
  | "REMOVE_REQUIRED"
  | "POLICY_AUTHORITY_REQUIRED"
  | "SOURCE_MAP_AUTHORITY_REQUIRED"
  | "SOURCE_KIND_AUTHORITY_REQUIRED";

export type DirectoryReconciliationPlannedAction =
  | "none"
  | "replace_canonical"
  | "update_provenance"
  | "add_canonical"
  | "retain"
  | "resolve"
  | "rename"
  | "remove";

export type DirectoryReconciliationRequiredAuthority = "none" | "resolve" | "rename" | "remove" | "source-map" | "source-kind" | "policy";

export interface DirectoryReconciliationRecord {
  readonly key: string;
  readonly kind: "asset" | "companion";
  readonly sourceKind: "directory";
  readonly classification: DirectoryReconciliationClassification;
  readonly action: string;
  readonly blocker: boolean;
  readonly plannedAction: DirectoryReconciliationPlannedAction;
  readonly requiredAuthority: DirectoryReconciliationRequiredAuthority;
  readonly sourcePath?: string;
  readonly canonicalPath?: string;
}

/**
 * The option aliases are intentionally input-only conveniences for dispatchers
 * still carrying the v0.3 `archive` field.  Resolution values remain closed to
 * `source|canonical`; `archive` is never accepted here.
 */
export interface DirectoryReconciliationOptions {
  readonly directory?: string;
  readonly source?: string | { readonly kind: "directory"; readonly path: string };
  readonly sourceRoot?: string;
  readonly root?: string;
  readonly sourceMap?: string;
  readonly sourceMapPath?: string;
  readonly collections?: readonly string[];
  readonly collectionIds?: readonly string[];
  readonly selections?: readonly string[];
  readonly selectedPaths?: readonly string[];
  readonly companions?: readonly string[];
  readonly resolutions?: readonly string[];
  readonly renames?: readonly string[];
  readonly removals?: readonly string[];
  readonly apply?: boolean;
  readonly normalize?: "exact-common";
  readonly normalizationMap?: string;
  readonly acceptSourceMap?: string;
  readonly acceptedSourceMapDigest?: string;
  readonly acceptSourceKindChange?: string;
  readonly acceptedSourceKindChanges?: readonly string[];
  readonly acceptNormalizationPolicy?: string;
  readonly acceptedNormalizationPolicyDigest?: string;
  readonly shardManifest?: string;
}

const planBrand: unique symbol = Symbol("tfsb-directory-reconciliation-plan");

export interface DirectoryReconciliationPlan {
  readonly records: readonly DirectoryReconciliationRecord[];
  readonly changed: boolean;
  readonly pending: boolean;
  readonly blocked: boolean;
  readonly sourceMapDigest: Sha256Digest;
  readonly snapshotDigest: Sha256Digest;
  readonly normalizationPolicy?: NormalizationPolicyIdentityV1;
  readonly normalizationLedger?: NormalizationLedgerV1;
  readonly [planBrand]: true;
}

export interface DirectoryReconciliationResult {
  readonly records: readonly DirectoryReconciliationRecord[];
  readonly changed: boolean;
  readonly pending: boolean;
  readonly blocked: boolean;
  readonly applied: boolean;
  readonly sourceMapDigest: Sha256Digest;
  readonly snapshotDigest: Sha256Digest;
  readonly normalizationPolicy?: NormalizationPolicyIdentityV1;
  readonly normalizationLedger?: NormalizationLedgerV1;
}

interface SourceMapAuthority {
  readonly kind: "canonical" | "external";
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly snapshot?: PresentFileSnapshot;
}

interface NormalizationAuthority {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly snapshot: PresentFileSnapshot;
  readonly map?: NormalizationMapV1;
}

interface DirectoryPlanInternals {
  readonly root: string;
  readonly sourceRoot: string;
  readonly canonicalSnapshot: CanonicalSnapshot;
  readonly sourceSnapshot: AuthenticatedDirectorySnapshot;
  readonly sourceMap: SourceMapV1;
  readonly sourceMapAuthority: SourceMapAuthority;
  readonly normalizationAuthority?: NormalizationAuthority;
  readonly shardManifestAuthority?: { readonly path: string; readonly bytes: Uint8Array; readonly snapshot: PresentFileSnapshot };
  readonly provenanceBytes: Uint8Array;
  readonly directives: Readonly<{
    readonly resolutions: ReadonlyMap<string, "source" | "canonical">;
    readonly renames: ReadonlyMap<string, string>;
    readonly removals: ReadonlySet<string>;
    readonly acceptedSourceMap?: Sha256Digest;
    readonly acceptedSourceKindChange: boolean;
    readonly acceptedNormalizationPolicy?: Sha256Digest;
  }>;
  readonly nextFiles: CanonicalTree;
  readonly stagedBytes: ReadonlyMap<string, Uint8Array>;
  readonly changed: boolean;
  readonly pending: boolean;
  readonly blocked: boolean;
  readonly disposed: { value: boolean };
}

const planInternals = new WeakMap<DirectoryReconciliationPlan, DirectoryPlanInternals>();

export interface DirectoryReconciliationPlanningHooks {
  readonly afterCanonicalSnapshot?: () => void | Promise<void>;
  readonly checkCancelled?: () => void | Promise<void>;
}

function context(domain: DiagnosticContext["domain"] = "project"): DiagnosticContext {
  return { operation: "reconcile", domain };
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const first = result.diagnostics[0];
  if (first === undefined) throw new Error("Directory reconciliation diagnostics were unexpectedly empty.");
  throw new DiagnosticError(first);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function equalFiles(left: CanonicalTree, right: CanonicalTree): boolean {
  if (left.size !== right.size) return false;
  for (const [path, bytes] of left) {
    const other = right.get(path);
    if (other === undefined || !equalBytes(bytes, other)) return false;
  }
  return true;
}

function sourceValue(options: DirectoryReconciliationOptions): string {
  const source = options.directory ?? options.sourceRoot ?? (typeof options.source === "string" ? options.source : options.source?.path);
  if (source === undefined || source === "") fail(context(), "DIRECTORY_SOURCE_REQUIRED", "Directory reconcile requires a source root.");
  return resolve(source);
}

function sourceMapValue(options: DirectoryReconciliationOptions): string {
  const sourceMap = options.sourceMap ?? options.sourceMapPath;
  if (sourceMap === undefined || sourceMap === "") fail(context("source-map"), "SOURCE_MAP_REQUIRED", "Directory reconcile requires source-map schema 1.", SOURCE_MAP_FILENAME);
  return resolve(sourceMap);
}

function collectionValues(options: DirectoryReconciliationOptions, inferred?: string): readonly string[] {
  const explicit = options.collections ?? options.collectionIds ?? [];
  const collections = explicit.length === 0 && inferred !== undefined ? [inferred] : explicit;
  if (collections.length === 0) fail(context("source-map"), "DIRECTORY_COLLECTION_REQUIRED", "Directory reconcile requires at least one collection.");
  if (new Set(collections).size !== collections.length) fail(context("source-map"), "DIRECTORY_DUPLICATE_COLLECTION", "Directory collection selection contains a duplicate ID.");
  return [...collections];
}

function parseAssignments(values: readonly string[], name: string, sides: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator !== value.lastIndexOf("=") || separator === value.length - 1) {
      fail(context(), "RECONCILE_INVALID_DIRECTIVE", `${name} requires exactly one non-empty key=value pair.`, value);
    }
    const key = value.slice(0, separator).normalize("NFC");
    const selected = value.slice(separator + 1).normalize("NFC");
    if (result.has(key)) fail(context(), "RECONCILE_DUPLICATE_DIRECTIVE", `${name} repeats key '${key}'.`, key);
    if (sides.length > 0 && !sides.includes(selected)) {
      fail(context(), "RECONCILE_INVALID_DIRECTIVE", `${name} value must be ${sides.join(" or ")}.`, value);
    }
    result.set(key, selected);
  }
  return result;
}

function parseResolutions(values: readonly string[]): Map<string, "source" | "canonical"> {
  const parsed = parseAssignments(values, "--resolve", ["source", "canonical"]);
  return new Map([...parsed].map(([key, value]) => [key.startsWith("asset:") || key.startsWith("companion:") ? key : `asset:${key}`, value as "source" | "canonical"]));
}

function parseRenames(values: readonly string[]): Map<string, string> {
  const result = parseAssignments(values, "--rename", []);
  for (const [oldId, sourcePath] of result) {
    if (oldId.startsWith("asset:") || oldId.startsWith("companion:")) fail(context(), "RECONCILE_INVALID_DIRECTIVE", "Directory reconcile rename accepts asset IDs only.", oldId);
    validatePortablePathValue(sourcePath, context("source-map"), sourcePath);
  }
  return result;
}

function parseRemovals(values: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    const normalized = value.normalize("NFC");
    if (normalized === "" || normalized.startsWith("asset:") || normalized.startsWith("companion:")) {
      fail(context(), "RECONCILE_INVALID_DIRECTIVE", "Directory reconcile removal accepts asset IDs only.", value);
    }
    if (result.has(normalized)) fail(context(), "RECONCILE_DUPLICATE_DIRECTIVE", `--remove repeats '${normalized}'.`, normalized);
    result.add(normalized);
  }
  return result;
}

function acceptedDigest(options: DirectoryReconciliationOptions, kind: "source-map" | "policy"): Sha256Digest | undefined {
  const candidate = kind === "source-map"
    ? options.acceptSourceMap ?? options.acceptedSourceMapDigest
    : options.acceptNormalizationPolicy ?? options.acceptedNormalizationPolicyDigest;
  if (candidate === undefined) return undefined;
  if (!/^sha256:[0-9a-f]{64}$/.test(candidate)) fail(context(), "RECONCILE_INVALID_DIRECTIVE", `Accepted ${kind} authority must be a lowercase sha256 digest.`, candidate);
  return candidate as Sha256Digest;
}

function sourceKindAccepted(options: DirectoryReconciliationOptions): boolean {
  const values = [
    ...(options.acceptSourceKindChange === undefined ? [] : [options.acceptSourceKindChange]),
    ...(options.acceptedSourceKindChanges ?? []),
  ];
  if (values.some((value) => value !== "archive=directory")) {
    fail(context(), "RECONCILE_INVALID_DIRECTIVE", "Source-kind acceptance must be exactly archive=directory.");
  }
  if (values.length > 1) fail(context(), "RECONCILE_DUPLICATE_DIRECTIVE", "Source-kind acceptance may be supplied exactly once.");
  return values.length === 1;
}

function sourcePathForRecord(record: ProvenanceRecordV3): string | undefined {
  return record.source?.kind === "directory" ? record.source.sourcePath : undefined;
}

function recordKey(record: ProvenanceRecordV3): string {
  return record.type === "asset" ? `asset:${record.assetId}` : `companion:${record.canonicalPath.slice(".tfsb/companions/".length)}`;
}

function canonicalAssetPath(id: string): string {
  return `.tfsb/assets/${id}.toml`;
}

function canonicalCompanionPath(filename: string): string {
  return `.tfsb/companions/${filename}`;
}

function decodeUtf8(bytes: Uint8Array, code: string, message: string, location?: string): string {
  try { return new TextDecoder("utf8", { fatal: true }).decode(bytes); }
  catch { fail(context(), code, message, location); }
}

async function readSourceMap(sourceRoot: string, path: string): Promise<{ readonly map: SourceMapV1; readonly authority: SourceMapAuthority }> {
  const canonicalPath = join(sourceRoot, SOURCE_MAP_FILENAME);
  const read = await readRegularFileSnapshot(path, context("source-map"), "SOURCE_MAP_UNSAFE", "Source map must be a stable regular non-symlink file.", 1024 * 1024);
  const map = unwrap(parseSourceMap(decodeUtf8(read.bytes, "SOURCE_MAP_INVALID_UTF8", "Source map must be valid UTF-8.", path), path));
  return path === canonicalPath
    ? { map, authority: { kind: "canonical", path: SOURCE_MAP_FILENAME, bytes: Buffer.from(read.bytes), snapshot: read.snapshot } }
    : { map, authority: { kind: "external", path, bytes: Buffer.from(read.bytes), snapshot: read.snapshot } };
}

async function readNormalizationAuthority(options: DirectoryReconciliationOptions): Promise<{ readonly policy?: NormalizationPolicyIdentityV1; readonly authority?: NormalizationAuthority }> {
  if (options.normalizationMap === undefined) {
    if (options.normalize === undefined) return {};
    return { policy: createNormalizationPolicyIdentity() };
  }
  if (options.normalize !== "exact-common") fail(context(), "NORMALIZATION_POLICY_REQUIRED", "A normalization map requires exact-common normalization.");
  const path = resolve(options.normalizationMap);
  const read = await readRegularFileSnapshot(path, context(), "NORMALIZATION_MAP_UNSAFE", "Normalization map must be a stable regular non-symlink file.", 1024 * 1024);
  const map = unwrapNormalizationMap(parseNormalizationMap(decodeUtf8(read.bytes, "NORMALIZATION_MAP_INVALID_UTF8", "Normalization map must be valid UTF-8.", path), path));
  return { policy: createNormalizationPolicyIdentity(map), authority: { path, bytes: Buffer.from(read.bytes), snapshot: read.snapshot, map } };
}

async function readShardManifestAuthority(pathValue: string): Promise<{
  readonly manifest: ShardManifestV1;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly snapshot: PresentFileSnapshot;
}> {
  const path = resolve(pathValue);
  const read = await readRegularFileSnapshot(path, context("manifest"), "SHARD_MANIFEST_UNSAFE", "Shard manifest must be a stable regular non-symlink file.", SHARD_MANIFEST_MAX_BYTES);
  const manifest = unwrap(parseShardManifest(decodeUtf8(read.bytes, "SHARD_INVALID_UTF8", "Shard manifest must be valid UTF-8.", basename(path)), basename(path)));
  return { manifest, path, bytes: Buffer.from(read.bytes), snapshot: read.snapshot };
}

async function readProvenance(snapshot: CanonicalSnapshot): Promise<{ readonly bytes: Uint8Array; readonly value: ImportProvenanceV3; readonly wasV2: boolean }> {
  const bytes = snapshot.files.get(".tfsb/provenance.json")?.bytes;
  if (bytes === undefined) fail(context("provenance"), "RECONCILE_PROVENANCE_REQUIRED", "Directory reconcile requires provenance schema 2 or 3.", ".tfsb/provenance.json");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown; }
  catch { fail(context("provenance"), "PROVENANCE_INVALID_JSON", "Provenance JSON is invalid.", ".tfsb/provenance.json"); }
  const schemaVersion = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as { readonly schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (schemaVersion === 2) {
    const v2 = unwrapProvenanceV2(parseImportProvenanceV2(Buffer.from(bytes).toString("utf8"), ".tfsb/provenance.json"));
    return { bytes: Buffer.from(bytes), value: liftImportProvenanceV2ToV3(v2), wasV2: true };
  }
  if (schemaVersion === 3) {
    return { bytes: Buffer.from(bytes), value: unwrapProvenanceV3(parseImportProvenanceV3(Buffer.from(bytes).toString("utf8"), ".tfsb/provenance.json")), wasV2: false };
  }
  fail(context("provenance"), "PROVENANCE_UNSUPPORTED_VERSION", "Directory reconcile supports provenance schema 2 only through explicit lift and schema 3.", ".tfsb/provenance.json");
}

function directorySource(
  file: DirectoryFileDto | DirectoryCompanionDto,
  snapshot: AuthenticatedDirectorySnapshot,
  canonicalBasis: DirectoryCanonicalBasisV3,
  sourceDigest: Sha256Digest,
  sourceCanonicalDigest: Sha256Digest | null,
  canonicalDigest: Sha256Digest | null,
  resolution: "aligned" | "canonical",
  sourceState: "present" | "absent" = "present",
): DirectorySourceCheckpointV3 {
  return {
    kind: "directory",
    collectionId: file.collectionId,
    sourcePath: file.sourcePath,
    sourceMapBasis: "tfsb-source-map-v1",
    sourceMapDigest: snapshot.sourceMapDigest,
    snapshotBasis: "tfsb-directory-snapshot-v1",
    snapshotDigest: snapshot.inventoryDigest,
    sourceBasis: "tfsb-directory-file-bytes-v1",
    sourceState,
    sourceDigest: sourceState === "present" ? sourceDigest : null,
    sourceCanonicalBasis: canonicalBasis,
    sourceCanonicalDigest: sourceCanonicalDigest,
    canonicalBasis,
    canonicalState: canonicalDigest === null ? "absent" : "present",
    canonicalDigest,
    resolution,
    toolVersion: TOOL_VERSION,
  };
}

function directoryAbsentSource(
  prior: DirectorySourceCheckpointV3,
  snapshot: AuthenticatedDirectorySnapshot,
  canonicalDigest: Sha256Digest | null,
): DirectorySourceCheckpointV3 {
  return {
    ...prior,
    sourceMapDigest: snapshot.sourceMapDigest,
    snapshotDigest: snapshot.inventoryDigest,
    sourceState: "absent",
    sourceDigest: null,
    sourceCanonicalDigest: null,
    canonicalState: canonicalDigest === null ? "absent" : "present",
    canonicalDigest,
    resolution: "canonical",
  };
}

function sourceDigestFor(file: DirectoryFileDto | DirectoryCompanionDto, bytes: Uint8Array): Sha256Digest {
  return "assetId" in file ? computeSha256(bytes) : computeCompanionByteDigest(bytes);
}

function sourceCanonicalDigestFor(value: NormalizedAssetV2 | Uint8Array): Sha256Digest {
  return value instanceof Uint8Array ? computeCompanionByteDigest(value) : computeAssetSemanticDigest(value);
}

function priorCanonicalDigest(record: ProvenanceRecordV3): Sha256Digest | null {
  return record.source?.canonicalState === "present" ? record.source.canonicalDigest : null;
}

function priorSourceDigest(record: ProvenanceRecordV3): Sha256Digest | null {
  return record.source?.kind === "directory" && record.source.sourceState === "present" ? record.source.sourceDigest : record.source?.kind === "archive" ? record.source.sourceDigest : null;
}

function resolutionFor(resolutions: ReadonlyMap<string, "source" | "canonical">, key: string): "source" | "canonical" | undefined {
  return resolutions.get(key) ?? resolutions.get(key.startsWith("asset:") || key.startsWith("companion:") ? key.slice(key.indexOf(":") + 1) : key);
}

function actionFor(classification: DirectoryReconciliationClassification, key: string, kind: "asset" | "companion"): { readonly action: string; readonly blocker: boolean; readonly plannedAction: DirectoryReconciliationPlannedAction; readonly requiredAuthority: DirectoryReconciliationRequiredAuthority } {
  const subject = kind === "asset" ? "asset" : "companion";
  switch (classification) {
    case "UNCHANGED": return { action: "none", blocker: false, plannedAction: "none", requiredAuthority: "none" };
    case "SOURCE_CHANGED": return { action: `replace canonical ${subject}`, blocker: false, plannedAction: "replace_canonical", requiredAuthority: "none" };
    case "SOURCE_FORMATTING_ONLY": return { action: "update source checkpoint", blocker: false, plannedAction: "update_provenance", requiredAuthority: "none" };
    case "CONVERGED": return { action: "update provenance", blocker: false, plannedAction: "update_provenance", requiredAuthority: "none" };
    case "SOURCE_OMISSION": return { action: "retain canonical state; source absent", blocker: false, plannedAction: "retain", requiredAuthority: "none" };
    case "ACCEPTED_SOURCE_ABSENCE": return { action: "retain canonical state after accepted source absence", blocker: false, plannedAction: "retain", requiredAuthority: "none" };
    case "NEW_SOURCE": return { action: `add canonical ${subject}`, blocker: false, plannedAction: "add_canonical", requiredAuthority: "none" };
    case "ACCEPTED_CANONICAL_DIVERGENCE": return { action: "retain canonical divergence", blocker: false, plannedAction: "update_provenance", requiredAuthority: "none" };
    case "RENAME_REQUIRED": return { action: `requires --rename for ${subject}`, blocker: true, plannedAction: "rename", requiredAuthority: "rename" };
    case "REMOVE_REQUIRED": return { action: `remove canonical ${subject}`, blocker: false, plannedAction: "remove", requiredAuthority: "remove" };
    case "POLICY_AUTHORITY_REQUIRED": return { action: "exact normalization policy authority required", blocker: true, plannedAction: "resolve", requiredAuthority: "policy" };
    case "SOURCE_MAP_AUTHORITY_REQUIRED": return { action: "exact source-map authority required", blocker: true, plannedAction: "resolve", requiredAuthority: "source-map" };
    case "SOURCE_KIND_AUTHORITY_REQUIRED": return { action: "exact archive=directory authority required", blocker: true, plannedAction: "resolve", requiredAuthority: "source-kind" };
    case "CANONICAL_CHANGED":
    case "BOTH_CHANGED":
      return { action: `requires --resolve ${key}=source|canonical`, blocker: true, plannedAction: "resolve", requiredAuthority: "resolve" };
  }
}

function makeRecord(key: string, kind: "asset" | "companion", classification: DirectoryReconciliationClassification, sourcePath?: string, canonicalPath?: string, override?: Partial<ReturnType<typeof actionFor>>): DirectoryReconciliationRecord {
  const action = actionFor(classification, key, kind);
  return Object.freeze({ key, kind, sourceKind: "directory" as const, classification, action: override?.action ?? action.action, blocker: override?.blocker ?? action.blocker, plannedAction: override?.plannedAction ?? action.plannedAction, requiredAuthority: override?.requiredAuthority ?? action.requiredAuthority, ...(sourcePath === undefined ? {} : { sourcePath }), ...(canonicalPath === undefined ? {} : { canonicalPath }) });
}

function cloneTree(snapshot: CanonicalSnapshot): Map<string, Uint8Array> {
  return new Map([...snapshot.files].map(([path, file]) => [path, Buffer.from(file.bytes)]));
}

function cloneRecord(record: ProvenanceRecordV3): ProvenanceRecordV3 {
  return record.type === "asset"
    ? { ...record, source: record.source === null ? null : { ...record.source }, migration: record.migration === null ? null : { ...record.migration }, normalizationPolicy: record.normalizationPolicy === null ? null : { ...record.normalizationPolicy } }
    : { ...record, source: { ...record.source } };
}

function validateNextTree(files: CanonicalTree): void {
  const projectBytes = files.get(".tfsb/project.toml");
  if (projectBytes === undefined) fail(context("transaction"), "RECONCILE_INVALID_PLAN", "Next canonical tree lacks project.toml.");
  const project = unwrap(parseProjectTomlV2(Buffer.from(projectBytes).toString("utf8"), ".tfsb/project.toml"));
  validateProjectPathLayout(project as never);
  const ids = new Set<string>();
  const filenames = new Set<string>();
  const companions = new Set<string>();
  for (const [path, bytes] of files) {
    if (path.startsWith(".tfsb/assets/")) {
      const asset = unwrap(parseAssetTomlV2(Buffer.from(bytes).toString("utf8"), path));
      if (path !== canonicalAssetPath(asset.id) || ids.has(asset.id) || filenames.has(asset.filename)) fail(context("transaction"), "RECONCILE_COLLISION", "Proposed canonical asset identity collides.", path);
      ids.add(asset.id); filenames.add(asset.filename);
    } else if (path.startsWith(".tfsb/companions/")) {
      const name = path.slice(".tfsb/companions/".length);
      if (name.includes("/") || !isAllowedCompanionFilename(name)) fail(context("transaction"), "PROJECT_UNSUPPORTED_SOURCE", "Proposed companion path is unsupported.", path);
      companions.add(name);
    } else if (path !== ".tfsb/project.toml" && path !== ".tfsb/provenance.json" && !isFixedBrandFilePath(path)) {
      fail(context("transaction"), "PROJECT_UNSUPPORTED_SOURCE", "Proposed canonical path is unsupported.", path);
    }
  }
  if (ids.size > 128) fail(context("transaction"), "RESOURCE_LIMIT_EXCEEDED", "Complete next canonical project exceeds 128 assets.");
  for (const install of project.installs) if (!ids.has(install.asset)) fail(context("transaction"), "PROJECT_UNKNOWN_INSTALL_ASSET", `Install rule refers to unknown asset '${install.asset}'.`);
  for (const companion of project.companions) if (!companions.has(companion.file)) fail(context("transaction"), "PROJECT_UNKNOWN_COMPANION", `Companion rule refers to unknown file '${companion.file}'.`);
  const provenance = files.get(".tfsb/provenance.json");
  if (provenance === undefined) fail(context("transaction"), "RECONCILE_INVALID_PLAN", "Proposed canonical tree lacks provenance schema 3.", ".tfsb/provenance.json");
  unwrapProvenanceV3(parseImportProvenanceV3(Buffer.from(provenance).toString("utf8"), ".tfsb/provenance.json"));
}

async function stagedPaths(root: string, prefix = ""): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await stagedPaths(root, path));
    else if (entry.isFile() && !entry.isSymbolicLink()) paths.push(path);
    else fail(context("transaction"), "RECONCILE_STAGE_INVALID", "Staged reconciliation contains a symlink or special file.", path);
  }
  return paths.sort(compareUtf8);
}

async function validateStagedTree(stageRoot: string, expected: CanonicalTree): Promise<void> {
  const expectedPaths = [...expected.keys()].map((path) => path.slice(".tfsb/".length)).sort(compareUtf8);
  const actualPaths = await stagedPaths(stageRoot);
  if (expectedPaths.length !== actualPaths.length || expectedPaths.some((path, index) => path !== actualPaths[index])) {
    fail(context("transaction"), "RECONCILE_STAGE_INVALID", "Staged reconciliation contains an unexpected or missing file.");
  }
  for (const [path, bytes] of expected) {
    const actual = await readFile(join(stageRoot, path.slice(".tfsb/".length)));
    if (!equalBytes(actual, bytes)) fail(context("transaction"), "RECONCILE_STAGE_INVALID", "Staged reconciliation bytes differ from the authentic private plan.", path);
  }
  validateNextTree(new Map(await Promise.all(actualPaths.map(async (path) => [`.tfsb/${path}`, await readFile(join(stageRoot, path))] as const))));
}

function candidateAsset(
  bytes: Uint8Array,
  file: DirectoryFileDto,
  record: AssetProvenanceRecordV3 | undefined,
  policy: NormalizationPolicyIdentityV1 | undefined,
  normalizationMap: NormalizationMapV1 | undefined,
): { readonly asset?: NormalizedAssetV2; readonly ledger?: NormalizationLedgerEntryV1; readonly policy?: NormalizationPolicyIdentityV1 } {
  const analysis = scanAnalyzeSvg(bytes, file.sourcePath, file.assetId).file.profiles.commonV03.classification;
  if (analysis === "unsafe") fail(context("directory-snapshot"), "IMPORT_UNSAFE_SOURCE", "Unsafe SVG content cannot be reconciled.", file.sourcePath);
  if (analysis === "unsupported") fail(context("directory-snapshot"), "IMPORT_UNSUPPORTED_SOURCE", "Unsupported SVG content cannot be reconciled.", file.sourcePath);
  const text = decodeUtf8(bytes, "ARCHIVE_INVALID_UTF8", "Selected SVG must be valid UTF-8.", file.sourcePath);
  const parsed = parseSvgV2(text, file.sourcePath);
  const canonical = parsed.ok ? unwrap(serializeSvgV2(parsed.value, file.sourcePath)) : undefined;
  if (parsed.ok && (canonical === text || policy === undefined)) return { asset: { schemaVersion: 2, id: file.assetId as NormalizedAssetV2["id"], filename: `${file.assetId}.svg` as NormalizedAssetV2["filename"], svg: parsed.value } };
  if (policy === undefined) {
    if (record?.normalizationPolicy !== null && record?.normalizationPolicy !== undefined) return {};
    fail(context("directory-snapshot"), "IMPORT_NORMALIZATION_REQUIRED", `Schema-2 source '${file.sourcePath}' requires exact-common normalization.`, file.sourcePath);
  }
  const normalized = normalizeCommonSvg({ bytes, source: file.sourcePath, assetId: file.assetId as NormalizedAssetV2["id"], filename: `${file.assetId}.svg` as NormalizedAssetV2["filename"], ...(normalizationMap === undefined ? {} : { map: normalizationMap }), policy });
  return { asset: normalized.asset, ledger: normalized.ledger, policy };
}

function isDirectorySource(source: ProvenanceSourceCheckpointV3 | null | undefined): source is DirectorySourceCheckpointV3 {
  return source?.kind === "directory";
}

function sourceMapDrift(records: readonly ProvenanceRecordV3[], digest: Sha256Digest): boolean {
  return records.some((record) => isDirectorySource(record.source) && record.source.sourceMapDigest !== digest);
}

function activeSourcePath(record: ProvenanceRecordV3, selectedPaths: readonly string[] | undefined): boolean {
  if (selectedPaths === undefined || selectedPaths.length === 0) return true;
  const path = sourcePathForRecord(record);
  return path !== undefined && selectedPaths.includes(path);
}

function companionSourceFileForRecord(record: CompanionProvenanceRecordV3, files: ReadonlyMap<string, DirectoryCompanionDto>): DirectoryCompanionDto | undefined {
  const path = sourcePathForRecord(record);
  return path === undefined ? undefined : files.get(path);
}

function currentSourcePath(file: DirectoryFileDto | DirectoryCompanionDto | undefined): string | undefined {
  return file?.sourcePath;
}

function nextProjectWithRename(project: NormalizedProjectV2, oldId: string, newId: string): NormalizedProjectV2 {
  if (oldId === newId) return project;
  return { ...project, installs: project.installs.map((install) => install.asset === oldId ? { ...install, asset: newId as NormalizedProjectV2["installs"][number]["asset"] } : install) };
}

async function verifySourceMapAuthority(internals: DirectoryPlanInternals): Promise<SourceMapV1> {
  let bytes: Uint8Array;
  if (internals.sourceMapAuthority.kind === "canonical") {
    bytes = readDirectorySnapshotAuthorityFile(internals.sourceSnapshot, internals.sourceMapAuthority.path, 1024 * 1024);
    if (!equalBytes(bytes, internals.sourceMapAuthority.bytes)) fail(context("source-map"), "SOURCE_MAP_CHANGED", "Source map bytes changed after planning.", SOURCE_MAP_FILENAME);
    const pathRead = await readRegularFileSnapshot(join(internals.sourceRoot, SOURCE_MAP_FILENAME), context("source-map"), "SOURCE_MAP_CHANGED", "Source map changed after planning.", 1024 * 1024);
    if (internals.sourceMapAuthority.snapshot !== undefined && !sameFileIdentity(internals.sourceMapAuthority.snapshot, pathRead.snapshot)) fail(context("source-map"), "SOURCE_MAP_CHANGED", "Source map identity changed after planning.", SOURCE_MAP_FILENAME);
  } else {
    const read = await readRegularFileSnapshot(internals.sourceMapAuthority.path, context("source-map"), "SOURCE_MAP_CHANGED", "Source map changed after planning.", 1024 * 1024);
    if (internals.sourceMapAuthority.snapshot === undefined || !sameFileIdentity(internals.sourceMapAuthority.snapshot, read.snapshot) || !equalBytes(read.bytes, internals.sourceMapAuthority.bytes)) fail(context("source-map"), "SOURCE_MAP_CHANGED", "Source map identity or bytes changed after planning.", internals.sourceMapAuthority.path);
    bytes = read.bytes;
  }
  const map = unwrap(parseSourceMap(decodeUtf8(bytes, "SOURCE_MAP_INVALID_UTF8", "Source map must be valid UTF-8.", internals.sourceMapAuthority.path), internals.sourceMapAuthority.path));
  if (computeSourceMapDigest(map) !== computeSourceMapDigest(internals.sourceMap)) fail(context("source-map"), "SOURCE_MAP_CHANGED", "Source-map semantics changed after planning.");
  return map;
}

async function verifyNormalizationAuthority(internals: DirectoryPlanInternals): Promise<void> {
  const authority = internals.normalizationAuthority;
  if (authority === undefined) return;
  const read = await readRegularFileSnapshot(authority.path, context("project"), "NORMALIZATION_MAP_CHANGED", "Normalization map identity or bytes changed after planning.", 1024 * 1024);
  if (!sameFileIdentity(authority.snapshot, read.snapshot) || !equalBytes(authority.bytes, read.bytes)) fail(context(), "NORMALIZATION_MAP_CHANGED", "Normalization map identity or bytes changed after planning.", authority.path);
}

async function verifyShardManifestAuthority(internals: DirectoryPlanInternals): Promise<void> {
  const authority = internals.shardManifestAuthority;
  if (authority === undefined) return;
  const read = await readRegularFileSnapshot(authority.path, context("manifest"), "SHARD_MANIFEST_CHANGED", "Shard manifest identity or bytes changed after planning.", SHARD_MANIFEST_MAX_BYTES);
  if (!sameFileIdentity(authority.snapshot, read.snapshot) || !equalBytes(authority.bytes, read.bytes)) {
    fail(context("manifest"), "SHARD_MANIFEST_CHANGED", "Shard manifest identity or bytes changed after planning.");
  }
}

async function verifyDirectoryAuthority(internals: DirectoryPlanInternals): Promise<void> {
  const map = await verifySourceMapAuthority(internals);
  await verifyNormalizationAuthority(internals);
  await verifyShardManifestAuthority(internals);
  unwrap(await revalidateDirectorySnapshot(internals.sourceSnapshot, map));
}

function requirePlanInternals(plan: DirectoryReconciliationPlan): DirectoryPlanInternals {
  const internals = planInternals.get(plan);
  if (internals === undefined) fail(context(), "RECONCILE_INVALID_PLAN", "Directory reconciliation plan was not produced by this planner instance.");
  return internals;
}

function sourceKindRecord(record: ProvenanceRecordV3): DirectoryReconciliationRecord {
  return makeRecord(recordKey(record), record.type, "SOURCE_KIND_AUTHORITY_REQUIRED", sourcePathForRecord(record), record.canonicalPath);
}

async function planDirectoryReconciliationInternal(options: DirectoryReconciliationOptions, hooks: DirectoryReconciliationPlanningHooks = {}): Promise<DirectoryReconciliationPlan> {
  await hooks.checkCancelled?.();
  const sourceRoot = sourceValue(options);
  const sourceMapPath = sourceMapValue(options);
  const adHocSelectedPaths = options.selections ?? options.selectedPaths;
  if (options.shardManifest !== undefined && (adHocSelectedPaths?.length ?? 0) > 0) {
    fail(context("manifest"), "SHARD_MANIFEST_SELECTION_CONFLICT", "A shard manifest is mutually exclusive with ad-hoc source selection.");
  }
  const loadedShard = options.shardManifest === undefined ? undefined : await readShardManifestAuthority(options.shardManifest);
  const resolutions = parseResolutions(options.resolutions ?? []);
  const renames = parseRenames(options.renames ?? []);
  const removals = parseRemovals(options.removals ?? []);
  for (const id of renames.keys()) {
    if (removals.has(id)) fail(context(), "RECONCILE_CONTRADICTORY_DIRECTIVE", `Asset '${id}' is both renamed and removed.`, id);
    if (resolutions.has(`asset:${id}`) || resolutions.has(id)) fail(context(), "RECONCILE_CONTRADICTORY_DIRECTIVE", `Asset '${id}' has contradictory rename and resolution authority.`, id);
  }
  const acceptedSourceMap = acceptedDigest(options, "source-map");
  const acceptedNormalizationPolicy = acceptedDigest(options, "policy");
  const acceptedSourceKindChange = sourceKindAccepted(options);
  const companionRenameValues = (options as DirectoryReconciliationOptions & { readonly companionRenames?: readonly string[] }).companionRenames;
  const companionRemoveValues = (options as DirectoryReconciliationOptions & { readonly companionRemovals?: readonly string[] }).companionRemovals;
  if ((companionRenameValues?.length ?? 0) > 0 || (companionRemoveValues?.length ?? 0) > 0) fail(context(), "RECONCILE_INVALID_DIRECTIVE", "Directory reconcile has no companion rename/remove grammar.");

  const root = await findProjectRoot(options.root, "reconcile", options.root !== undefined);
  const canonicalSnapshot = await snapshotCanonicalTree(root, false, "reconcile");
  await hooks.afterCanonicalSnapshot?.();
  await hooks.checkCancelled?.();
  const project = await loadCanonicalProjectFromSnapshot(canonicalSnapshot, "reconcile");
  if (project.project.schemaVersion !== 2) fail(context(), "DIRECTORY_SCHEMA_UNSUPPORTED", "Directory reconcile supports schema-2 canonical projects only.");
  const provenance = await readProvenance(canonicalSnapshot);
  const loadedMap = await readSourceMap(sourceRoot, sourceMapPath);
  if (loadedShard !== undefined && computeSourceMapDigest(loadedMap.map) !== loadedShard.manifest.sourceMapDigest) {
    fail(context("manifest"), "SHARD_MANIFEST_STALE", "Current source-map semantics differ from the shard manifest.", basename(loadedShard.path));
  }
  const collections = collectionValues(options, loadedShard?.manifest.collectionId);
  if (loadedShard !== undefined && (collections.length !== 1 || collections[0] !== loadedShard.manifest.collectionId)) {
    fail(context("manifest"), "SHARD_MANIFEST_COLLECTION_MISMATCH", "Explicit collection must exactly match the shard manifest collection.");
  }
  const shardCollection = loadedShard === undefined
    ? undefined
    : loadedMap.map.collections.find((collection) => collection.id === loadedShard.manifest.collectionId);
  if (loadedShard !== undefined && shardCollection === undefined) {
    fail(context("manifest"), "SHARD_MANIFEST_COLLECTION_MISMATCH", "Shard manifest collection is absent from the current source map.");
  }
  const selectedPathsInput = loadedShard === undefined
    ? adHocSelectedPaths
    : loadedShard.manifest.assets.map((asset) => shardCollection!.root === "." ? asset.sourcePath : `${shardCollection!.root}/${asset.sourcePath}`);
  const normalization = await readNormalizationAuthority(options);
  const initialSourceMapDigest = computeSourceMapDigest(loadedMap.map);
  if (acceptedSourceMap !== undefined && acceptedSourceMap !== initialSourceMapDigest) fail(context("source-map"), "SOURCE_MAP_AUTHORITY_REQUIRED", "Accepted source-map digest does not match the current semantic map.");
  if (acceptedNormalizationPolicy !== undefined && normalization.policy?.policyDigest !== acceptedNormalizationPolicy) fail(context(), "POLICY_AUTHORITY_REQUIRED", "Accepted normalization-policy digest does not match the current policy.");

  const provisionalCompanions: { readonly collectionId: string; readonly sourcePath: string }[] = [];
  const companionSelection = options.companions === undefined ? undefined : [...options.companions];
  for (const record of provenance.value.records) {
    await hooks.checkCancelled?.();
    if (record.type !== "companion" || !isDirectorySource(record.source)) continue;
    if (companionSelection !== undefined && companionSelection.length > 0 && !companionSelection.includes(record.source.sourcePath)) continue;
    provisionalCompanions.push({ collectionId: record.source.collectionId, sourcePath: record.source.sourcePath });
  }
  for (const path of companionSelection ?? []) {
    await hooks.checkCancelled?.();
    const owner = loadedMap.map.collections.find((collection) => collection.root === "." || path.startsWith(`${collection.root}/`));
    if (owner === undefined || !isAllowedCompanionFilename(basename(path))) fail(context("source-map"), "DIRECTORY_COMPANION_OUTSIDE_COLLECTION", "Companion path must be rooted in a selected collection and use the approved filename grammar.", path);
    if (!provisionalCompanions.some((candidate) => candidate.sourcePath === path)) provisionalCompanions.push({ collectionId: owner.id, sourcePath: path });
  }
  const uniqueCompanions = [...new Map(provisionalCompanions.map((item) => [item.collectionId + "\0" + item.sourcePath, item])).values()];
  const selectedPaths = selectedPathsInput === undefined
    ? undefined
    : [...new Set([...selectedPathsInput, ...renames.values()])];
  let shardDirectoryPaths: ReadonlySet<string> | undefined;
  if (loadedShard !== undefined && uniqueCompanions.length > 0) {
    await hooks.checkCancelled?.();
    const shardSnapshot = unwrap(await createDirectorySnapshot(sourceRoot, loadedMap.map, collections, {
      ...(selectedPaths === undefined ? {} : { selectedPaths }),
    }));
    try {
      shardDirectoryPaths = new Set(shardSnapshot.directories.map((directory) => directory.path));
    } finally {
      closeDirectorySnapshot(shardSnapshot);
    }
  }
  const sourceSnapshot = unwrap(await createDirectorySnapshot(sourceRoot, loadedMap.map, collections, {
    ...(selectedPaths === undefined ? {} : { selectedPaths }),
    ...(uniqueCompanions.length === 0 ? {} : { optionalCompanions: uniqueCompanions }),
  }));
  let transferred = false;
  try {
    await hooks.checkCancelled?.();
    if (loadedMap.authority.kind === "canonical") {
      const authenticated = readDirectorySnapshotAuthorityFile(sourceSnapshot, SOURCE_MAP_FILENAME, 1024 * 1024);
      if (!equalBytes(authenticated, loadedMap.authority.bytes)) fail(context("source-map"), "SOURCE_MAP_CHANGED", "Canonical source map changed during authenticated planning.", SOURCE_MAP_FILENAME);
    }
    if (loadedShard !== undefined) {
      const manifestDirectories = shardDirectoryPaths === undefined
        ? sourceSnapshot.directories
        : sourceSnapshot.directories.filter((directory) => shardDirectoryPaths.has(directory.path));
      const comparableSnapshotDigest = computeDirectorySnapshotDigest(sourceSnapshot.sourceMapDigest, manifestDirectories, sourceSnapshot.files);
      if (comparableSnapshotDigest !== loadedShard.manifest.sourceSnapshotDigest) {
        fail(context("manifest"), "SHARD_MANIFEST_STALE", "Current selected-view snapshot differs from the shard manifest.", basename(loadedShard.path));
      }
      const currentByPath = new Map(sourceSnapshot.files.map((file) => [file.collectionPath, file]));
      let directlyImportable = 0;
      let normalizationRequired = 0;
      if (currentByPath.size !== loadedShard.manifest.assets.length) {
        fail(context("manifest"), "SHARD_MANIFEST_STALE", "Current selected membership differs from the shard manifest.", basename(loadedShard.path));
      }
      for (const expected of loadedShard.manifest.assets) {
        const current = currentByPath.get(expected.sourcePath);
        if (current === undefined || current.collectionId !== loadedShard.manifest.collectionId || current.assetId !== expected.assetId) {
          fail(context("manifest"), "SHARD_MANIFEST_STALE", "Current selected path or derived identity differs from the shard manifest.", expected.sourcePath);
        }
        const bytes = copyDirectorySnapshotFileBytes(sourceSnapshot, current.sourcePath);
        if (bytes.byteLength !== expected.sourceBytes || computeSha256(bytes) !== expected.sourceDigest) {
          fail(context("manifest"), "SHARD_MANIFEST_STALE", "Current source bytes differ from the shard manifest.", expected.sourcePath);
        }
        const classification = scanAnalyzeSvg(bytes, current.sourcePath, current.assetId).file.profiles.commonV03.classification;
        if (classification === "unsafe" || classification === "unsupported") {
          fail(context("manifest"), "SHARD_MANIFEST_STALE", "Current analyzer classification is no longer materializable.", expected.sourcePath);
        }
        if (classification === "directly_importable") directlyImportable += 1;
        else normalizationRequired += 1;
      }
      if (directlyImportable !== loadedShard.manifest.directlyImportable
        || normalizationRequired !== loadedShard.manifest.normalizationRequired) {
        fail(context("manifest"), "SHARD_MANIFEST_STALE", "Current analyzer summary differs from the shard manifest.", basename(loadedShard.path));
      }
    }
    const sourceMapDigest = sourceSnapshot.sourceMapDigest;
    const sourceFiles = new Map(sourceSnapshot.files.map((file) => [file.sourcePath, file]));
    const sourceCompanions = new Map(sourceSnapshot.companions.map((file) => [file.sourcePath, file]));
    const sourceBytes = new Map<string, Uint8Array>();
    const copySource = (path: string): Uint8Array => {
      const prior = sourceBytes.get(path);
      if (prior !== undefined) return prior;
      const bytes = copyDirectorySnapshotFileBytes(sourceSnapshot, path);
      sourceBytes.set(path, bytes);
      return bytes;
    };
    const currentAssets = new Map<string, NormalizedAssetV2>((project.assets as readonly NormalizedAssetV2[]).map((asset) => [asset.id, asset]));
    const currentCompanions = new Map<string, Uint8Array>([...project.companions].map(([name]) => [name, canonicalSnapshot.files.get(canonicalCompanionPath(name))?.bytes ?? new Uint8Array()]));
    const nextFiles = cloneTree(canonicalSnapshot);
    const nextProject: { value: NormalizedProjectV2 } = { value: project.project };
    const records: DirectoryReconciliationRecord[] = [];
    const usedResolutions = new Set<string>();
    const nextRecords = new Map<string, ProvenanceRecordV3>(provenance.value.records.map((record) => [recordKey(record), cloneRecord(record)]));
    const ledgers: NormalizationLedgerEntryV1[] = [];
    const candidateCache = new Map<string, { readonly asset?: NormalizedAssetV2; readonly ledger?: NormalizationLedgerEntryV1; readonly policy?: NormalizationPolicyIdentityV1 }>();
    const candidateFor = (file: DirectoryFileDto, prior: AssetProvenanceRecordV3 | undefined) => {
      const cached = candidateCache.get(file.sourcePath);
      if (cached !== undefined) return cached;
      const value = candidateAsset(copySource(file.sourcePath), file, prior?.type === "asset" ? prior : undefined, normalization.policy, normalization.authority?.map);
      candidateCache.set(file.sourcePath, value);
      return value;
    };
    const assetFiles = sourceFiles;
    const selectedCollectionIds = new Set(collections);
    const activePriorRecords = provenance.value.records.filter((record) => {
      if (record.source?.kind !== "directory") return true;
      return selectedCollectionIds.has(record.source.collectionId) && activeSourcePath(record, selectedPathsInput);
    });
    const sourceMapBlocked = sourceMapDrift(activePriorRecords, sourceMapDigest) && acceptedSourceMap !== sourceMapDigest;
    const sourcePolicyAllowed = (prior: Pick<AssetProvenanceRecordV3, "normalizationPolicy">, sourceChanged: boolean): boolean => {
      const stored = prior.normalizationPolicy;
      if (stored === null) return true;
      if (normalization.policy === undefined) return !sourceChanged;
      if (normalizationPolicyMatches(stored, normalization.policy)) return true;
      return acceptedNormalizationPolicy === normalization.policy.policyDigest;
    };

    const updateAssetRecord = (id: string, source: DirectorySourceCheckpointV3 | null, prior: AssetProvenanceRecordV3 | undefined, policy: NormalizationPolicyIdentityV1 | null | undefined): void => {
      const existing = prior?.type === "asset" ? prior : undefined;
      nextRecords.set(`asset:${id}`, { type: "asset", assetId: id, canonicalPath: canonicalAssetPath(id), source, migration: existing?.migration ?? null, normalizationPolicy: policy ?? null });
    };

    const processAsset = (prior: AssetProvenanceRecordV3 | undefined, id: string, file: DirectoryFileDto | undefined, forcedRename = false, outputId = id): void => {
      const key = `asset:${id}`;
      const current = currentAssets.get(id);
      const currentDigest = current === undefined ? null : computeAssetSemanticDigest(current as NormalizedAssetV2);
      const priorCanonical = prior === undefined ? null : priorCanonicalDigest(prior);
      const canonicalChanged = currentDigest !== priorCanonical;
      if (outputId !== id && currentAssets.has(outputId)) {
        records.push(makeRecord(key, "asset", "RENAME_REQUIRED", file?.sourcePath, canonicalAssetPath(outputId)));
        return;
      }
      if (removals.has(id)) {
        nextFiles.delete(canonicalAssetPath(id));
        nextRecords.delete(key);
        nextProject.value = { ...nextProject.value, installs: nextProject.value.installs.filter((install) => install.asset !== id) };
        records.push(makeRecord(key, "asset", "REMOVE_REQUIRED", currentSourcePath(file), canonicalAssetPath(id), { blocker: false }));
        if (file !== undefined) sourceFiles.delete(file.sourcePath);
        return;
      }
      if (prior?.source?.kind === "archive" && !acceptedSourceKindChange) {
        records.push(sourceKindRecord(prior));
        return;
      }
      if (sourceMapBlocked && prior !== undefined) {
        records.push(makeRecord(key, "asset", "SOURCE_MAP_AUTHORITY_REQUIRED", sourcePathForRecord(prior), canonicalAssetPath(id)));
        return;
      }
      if (file === undefined) {
        if (forcedRename || renames.has(id)) {
          records.push(makeRecord(key, "asset", "RENAME_REQUIRED", undefined, canonicalAssetPath(id)));
          return;
        }
        if (prior?.source?.kind === "directory") {
          const absent = directoryAbsentSource(prior.source, sourceSnapshot, currentDigest);
          updateAssetRecord(id, absent, prior, prior.normalizationPolicy);
          const classification: DirectoryReconciliationClassification = canonicalChanged ? "ACCEPTED_SOURCE_ABSENCE" : "SOURCE_OMISSION";
          records.push(makeRecord(key, "asset", classification, undefined, canonicalAssetPath(id)));
        } else if (prior !== undefined && prior.source?.kind === "archive") {
          records.push(makeRecord(key, "asset", "SOURCE_KIND_AUTHORITY_REQUIRED", undefined, canonicalAssetPath(id)));
        }
        return;
      }
      if (file.assetId !== id && !forcedRename) {
        records.push(makeRecord(key, "asset", "RENAME_REQUIRED", file.sourcePath, canonicalAssetPath(file.assetId)));
        return;
      }
      const bytes = copySource(file.sourcePath);
      const sourceDigest = sourceDigestFor(file, bytes);
      const priorSource = priorSourceDigest(prior ?? ({ source: null } as ProvenanceRecordV3));
      const sourceChanged = prior === undefined || priorSource !== sourceDigest || sourcePathForRecord(prior) !== file.sourcePath || forcedRename;
      if (!sourcePolicyAllowed(prior ?? { normalizationPolicy: null }, sourceChanged)) {
        records.push(makeRecord(key, "asset", "POLICY_AUTHORITY_REQUIRED", file.sourcePath, canonicalAssetPath(outputId)));
        return;
      }
      if (!sourceChanged && !canonicalChanged && prior?.source?.kind === "directory" && prior.source.sourceMapDigest === sourceMapDigest) {
        if (outputId !== id) {
          nextFiles.delete(canonicalAssetPath(id));
          nextProject.value = nextProjectWithRename(nextProject.value, id, outputId);
          nextRecords.delete(key);
        }
        updateAssetRecord(outputId, directorySource(file, sourceSnapshot, "tfsb-asset-toml-v2", sourceDigest, prior.source.sourceCanonicalDigest, currentDigest, prior.source.resolution), prior, prior.normalizationPolicy);
        records.push(makeRecord(key, "asset", outputId === id ? "UNCHANGED" : "RENAME_REQUIRED", file.sourcePath, canonicalAssetPath(outputId), outputId === id ? {} : { action: "rename canonical asset and preserve destinations", blocker: false, plannedAction: "rename", requiredAuthority: "none" }));
        sourceFiles.delete(file.sourcePath);
        return;
      }
      const candidateResult = candidateFor(file, prior);
      if (candidateResult.asset === undefined) {
        records.push(makeRecord(key, "asset", "POLICY_AUTHORITY_REQUIRED", file.sourcePath, canonicalAssetPath(id)));
        return;
      }
      if (candidateResult.ledger !== undefined) ledgers.push(candidateResult.ledger);
      const candidate = candidateResult.asset;
      const candidateDigest = computeAssetSemanticDigest(candidate);
      const resolution = resolutionFor(resolutions, key);
      if (resolution !== undefined) usedResolutions.add(key);
      let classification: DirectoryReconciliationClassification;
      let selected: "source" | "canonical" | undefined = resolution;
      if (forcedRename || sourcePathForRecord(prior ?? ({ source: null } as ProvenanceRecordV3)) !== file.sourcePath) {
        if (!forcedRename && prior !== undefined && sourcePathForRecord(prior) !== undefined) {
          records.push(makeRecord(key, "asset", "RENAME_REQUIRED", file.sourcePath, canonicalAssetPath(id)));
          return;
        }
        selected ??= canonicalChanged ? undefined : "source";
      }
      if (selected === undefined && !canonicalChanged) selected = "source";
      if (selected === undefined && canonicalChanged) {
        if (candidateDigest === currentDigest) selected = "canonical";
        else {
          classification = sourceChanged ? "BOTH_CHANGED" : "CANONICAL_CHANGED";
          records.push(makeRecord(key, "asset", classification, file.sourcePath, canonicalAssetPath(id)));
          return;
        }
      }
      if (selected === "source") {
        if (outputId !== id) {
          nextFiles.delete(canonicalAssetPath(id));
          nextProject.value = nextProjectWithRename(nextProject.value, id, outputId);
          nextRecords.delete(key);
        }
        nextFiles.set(canonicalAssetPath(outputId), Buffer.from(serializeAssetTomlV2(candidate), "utf8"));
        updateAssetRecord(outputId, directorySource(file, sourceSnapshot, "tfsb-asset-toml-v2", sourceDigest, candidateDigest, candidateDigest, "aligned"), prior, candidateResult.policy ?? (candidateResult.ledger === undefined ? prior?.normalizationPolicy : normalization.policy));
        classification = canonicalChanged && candidateDigest === currentDigest ? "CONVERGED" : sourceChanged && candidateDigest === currentDigest && !canonicalChanged ? "SOURCE_FORMATTING_ONLY" : sourceChanged ? "SOURCE_CHANGED" : "ACCEPTED_CANONICAL_DIVERGENCE";
      } else {
        updateAssetRecord(outputId, directorySource(file, sourceSnapshot, "tfsb-asset-toml-v2", sourceDigest, candidateDigest, currentDigest, currentDigest === candidateDigest ? "aligned" : "canonical"), prior, prior?.normalizationPolicy);
        classification = currentDigest === candidateDigest ? "CONVERGED" : "ACCEPTED_CANONICAL_DIVERGENCE";
      }
      records.push(makeRecord(
        key,
        "asset",
        forcedRename ? "RENAME_REQUIRED" : classification,
        file.sourcePath,
        canonicalAssetPath(outputId),
        forcedRename ? { action: outputId === id ? "move tracked source path" : "rename canonical asset and preserve destinations", blocker: false, plannedAction: "rename", requiredAuthority: "none" } : {},
      ));
      sourceFiles.delete(file.sourcePath);
    };

    const priorAssets = provenance.value.records.filter((record): record is AssetProvenanceRecordV3 => record.type === "asset");
    const consumedSourcePaths = new Set<string>();
    for (const prior of priorAssets) {
      await hooks.checkCancelled?.();
      const id = prior.assetId;
      const renamePath = renames.get(id);
      const priorPath = sourcePathForRecord(prior);
      const file = renamePath === undefined
        ? (priorPath === undefined ? [...assetFiles.values()].find((candidate) => candidate.assetId === id) : assetFiles.get(priorPath))
        : assetFiles.get(renamePath);
      const active = removals.has(id)
        || renamePath !== undefined
        || (prior.source?.kind === "directory"
          ? selectedCollectionIds.has(prior.source.collectionId) && activeSourcePath(prior, selectedPathsInput)
          : file !== undefined);
      if (!active) continue;
      if (file !== undefined) consumedSourcePaths.add(file.sourcePath);
      processAsset(prior, id, file, renamePath !== undefined, file === undefined ? id : file.assetId);
    }
    for (const file of [...assetFiles.values()].sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath))) {
      await hooks.checkCancelled?.();
      if (consumedSourcePaths.has(file.sourcePath)) continue;
      const id = file.assetId;
      if (removals.has(id)) continue;
      const current = currentAssets.get(id);
      if (current !== undefined) {
        records.push(makeRecord(`asset:${id}`, "asset", "RENAME_REQUIRED", file.sourcePath, canonicalAssetPath(id)));
        continue;
      }
      if (sourceMapBlocked) {
        records.push(makeRecord(`asset:${id}`, "asset", "SOURCE_MAP_AUTHORITY_REQUIRED", file.sourcePath, canonicalAssetPath(id)));
        continue;
      }
      const candidateResult = candidateFor(file, undefined);
      if (candidateResult.asset === undefined) {
        records.push(makeRecord(`asset:${id}`, "asset", "POLICY_AUTHORITY_REQUIRED", file.sourcePath, canonicalAssetPath(id)));
        continue;
      }
      if (candidateResult.ledger !== undefined) ledgers.push(candidateResult.ledger);
      nextFiles.set(canonicalAssetPath(id), Buffer.from(serializeAssetTomlV2(candidateResult.asset), "utf8"));
      updateAssetRecord(id, directorySource(file, sourceSnapshot, "tfsb-asset-toml-v2", sourceDigestFor(file, copySource(file.sourcePath)), computeAssetSemanticDigest(candidateResult.asset), computeAssetSemanticDigest(candidateResult.asset), "aligned"), undefined, candidateResult.policy);
      records.push(makeRecord(`asset:${id}`, "asset", "NEW_SOURCE", file.sourcePath, canonicalAssetPath(id)));
    }

    const priorCompanions = provenance.value.records.filter((record): record is CompanionProvenanceRecordV3 => record.type === "companion");
    const companionFilesByPath = sourceCompanions;
    const consumedCompanionPaths = new Set<string>();
    for (const prior of priorCompanions) {
      await hooks.checkCancelled?.();
      const key = recordKey(prior);
      const canonicalName = prior.canonicalPath.slice(".tfsb/companions/".length);
      const file = prior.source.kind === "directory"
        ? companionSourceFileForRecord(prior, companionFilesByPath)
        : [...companionFilesByPath.values()].find((candidate) => basename(candidate.sourcePath) === canonicalName);
      const active = prior.source.kind === "directory"
        ? selectedCollectionIds.has(prior.source.collectionId)
          && (companionSelection === undefined || companionSelection.length === 0 || companionSelection.includes(prior.source.sourcePath))
        : file !== undefined;
      if (!active) continue;
      if (prior.source.kind === "archive" && !acceptedSourceKindChange) {
        records.push(sourceKindRecord(prior));
        continue;
      }
      if (sourceMapBlocked && prior.source.kind === "directory") {
        records.push(makeRecord(key, "companion", "SOURCE_MAP_AUTHORITY_REQUIRED", prior.source.sourcePath, prior.canonicalPath));
        continue;
      }
      if (file !== undefined) consumedCompanionPaths.add(file.sourcePath);
      const current = currentCompanions.get(canonicalName);
      const currentDigest = current === undefined ? null : computeCompanionByteDigest(current);
      const priorSource = prior.source.kind === "directory" && prior.source.sourceState === "present" ? prior.source.sourceDigest : prior.source.kind === "archive" ? prior.source.sourceDigest : null;
      if (file === undefined) {
        if (prior.source.kind === "directory") {
          const absent = directoryAbsentSource(prior.source, sourceSnapshot, currentDigest);
          nextRecords.set(key, { ...prior, source: absent });
          records.push(makeRecord(key, "companion", currentDigest !== priorCanonicalDigest(prior) ? "ACCEPTED_SOURCE_ABSENCE" : "SOURCE_OMISSION", undefined, prior.canonicalPath));
        }
        continue;
      }
      const bytes = copySource(file.sourcePath);
      const digest = sourceDigestFor(file, bytes);
      const sourceChanged = prior.source.kind !== "directory" || priorSource !== digest || prior.source.sourcePath !== file.sourcePath;
      const canonicalChanged = currentDigest !== priorCanonicalDigest(prior);
      const resolution = resolutionFor(resolutions, key);
      if (resolution !== undefined) usedResolutions.add(key);
      if (!sourceChanged && !canonicalChanged && prior.source.kind === "directory") {
        const source = directorySource(file, sourceSnapshot, "tfsb-companion-bytes-v1", digest, digest, currentDigest, currentDigest === digest ? "aligned" : "canonical");
        nextRecords.set(key, { ...prior, source });
        records.push(makeRecord(key, "companion", "UNCHANGED", file.sourcePath, prior.canonicalPath));
        continue;
      }
      if (sourceChanged && canonicalChanged && resolution === undefined) {
        records.push(makeRecord(key, "companion", "BOTH_CHANGED", file.sourcePath, prior.canonicalPath));
        continue;
      }
      if (!sourceChanged && canonicalChanged && resolution === undefined) {
        records.push(makeRecord(key, "companion", "CANONICAL_CHANGED", file.sourcePath, prior.canonicalPath));
        continue;
      }
      if (sourceChanged && !canonicalChanged && resolution === undefined) {
        nextFiles.set(prior.canonicalPath, Buffer.from(bytes));
        nextRecords.set(key, { ...prior, source: directorySource(file, sourceSnapshot, "tfsb-companion-bytes-v1", digest, digest, digest, "aligned") });
        records.push(makeRecord(key, "companion", "SOURCE_CHANGED", file.sourcePath, prior.canonicalPath));
        continue;
      }
      if (resolution === "source") {
        nextFiles.set(prior.canonicalPath, Buffer.from(bytes));
        nextRecords.set(key, { ...prior, source: directorySource(file, sourceSnapshot, "tfsb-companion-bytes-v1", digest, digest, digest, "aligned") });
        records.push(makeRecord(key, "companion", sourceChanged && canonicalChanged ? "CONVERGED" : "SOURCE_CHANGED", file.sourcePath, prior.canonicalPath));
      } else if (resolution === "canonical") {
        nextRecords.set(key, { ...prior, source: directorySource(file, sourceSnapshot, "tfsb-companion-bytes-v1", digest, digest, currentDigest, currentDigest === digest ? "aligned" : "canonical") });
        records.push(makeRecord(key, "companion", "ACCEPTED_CANONICAL_DIVERGENCE", file.sourcePath, prior.canonicalPath));
      }
    }
    for (const file of [...companionFilesByPath.values()].sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath))) {
      await hooks.checkCancelled?.();
      if (consumedCompanionPaths.has(file.sourcePath)) continue;
      const name = basename(file.sourcePath);
      const key = `companion:${name}`;
      if (currentCompanions.has(name) || nextFiles.has(canonicalCompanionPath(name))) {
        records.push(makeRecord(key, "companion", "RENAME_REQUIRED", file.sourcePath, canonicalCompanionPath(name)));
        continue;
      }
      const bytes = copySource(file.sourcePath);
      const digest = sourceDigestFor(file, bytes);
      nextFiles.set(canonicalCompanionPath(name), Buffer.from(bytes));
      nextRecords.set(key, { type: "companion", canonicalPath: canonicalCompanionPath(name), source: directorySource(file, sourceSnapshot, "tfsb-companion-bytes-v1", digest, digest, digest, "aligned") });
      records.push(makeRecord(key, "companion", "NEW_SOURCE", file.sourcePath, canonicalCompanionPath(name)));
    }

    for (const key of resolutions.keys()) {
      await hooks.checkCancelled?.();
      const normalized = key.startsWith("asset:") || key.startsWith("companion:") ? key : `asset:${key}`;
      if (!usedResolutions.has(normalized)) fail(context(), "RECONCILE_UNKNOWN_RESOLUTION", `Resolution key '${key}' is unknown, unnecessary, or out of scope.`, key);
    }
    for (const id of renames.keys()) {
      await hooks.checkCancelled?.();
      if (!records.some((record) => record.key === `asset:${id}` && record.plannedAction === "rename" && !record.blocker)) {
        fail(context(), "RECONCILE_UNKNOWN_RENAME", `Rename asset '${id}' is unknown, invalid, or out of scope.`, id);
      }
    }
    for (const id of removals) {
      await hooks.checkCancelled?.();
      if (!records.some((record) => record.key === `asset:${id}` && record.classification === "REMOVE_REQUIRED")) {
        fail(context(), "RECONCILE_UNKNOWN_REMOVAL", `Removal asset '${id}' is unknown or out of scope.`, id);
      }
    }

    if (nextProject.value !== project.project) nextFiles.set(".tfsb/project.toml", Buffer.from(serializeProjectTomlV2(nextProject.value), "utf8"));
    const nextProvenance: ImportProvenanceV3 = { kind: "tfsb-import-provenance", schemaVersion: 3, records: [...nextRecords.values()] };
    const renderedProvenance = serializeImportProvenanceV3(nextProvenance);
    nextFiles.set(".tfsb/provenance.json", Buffer.from(renderedProvenance, "utf8"));

    validateNextTree(nextFiles);
    await hooks.checkCancelled?.();
    records.sort((left, right) => compareUtf8(left.key, right.key));
    const currentFiles = new Map([...canonicalSnapshot.files].map(([path, file]) => [path, file.bytes]));
    const changed = !equalFiles(currentFiles, nextFiles);
    const blocked = records.some((record) => record.blocker);
    const pending = records.some((record) => record.classification !== "UNCHANGED");
    const publicRecords = Object.freeze(records.map((record) => Object.freeze(record)));
    const publicPlan: DirectoryReconciliationPlan = Object.freeze({ records: publicRecords, changed, pending, blocked, sourceMapDigest, snapshotDigest: sourceSnapshot.inventoryDigest, ...(normalization.policy === undefined ? {} : { normalizationPolicy: Object.freeze(normalization.policy) }), ...(ledgers.length === 0 ? {} : { normalizationLedger: Object.freeze({ schemaVersion: 1 as const, entries: Object.freeze(ledgers.sort((left, right) => compareUtf8(left.source, right.source)).map((entry) => Object.freeze(entry))) }) }), [planBrand]: true as const });
    const stagedBytes = new Map([...nextFiles].map(([path, bytes]) => [path, Buffer.from(bytes)]));
    const directives = Object.freeze({ resolutions: new Map(resolutions), renames: new Map(renames), removals: new Set(removals), ...(acceptedSourceMap === undefined ? {} : { acceptedSourceMap }), acceptedSourceKindChange, ...(acceptedNormalizationPolicy === undefined ? {} : { acceptedNormalizationPolicy }) });
    const internals: DirectoryPlanInternals = { root, sourceRoot, canonicalSnapshot, sourceSnapshot, sourceMap: loadedMap.map, sourceMapAuthority: loadedMap.authority, ...(normalization.authority === undefined ? {} : { normalizationAuthority: normalization.authority }), ...(loadedShard === undefined ? {} : { shardManifestAuthority: { path: loadedShard.path, bytes: loadedShard.bytes, snapshot: loadedShard.snapshot } }), provenanceBytes: Buffer.from(provenance.bytes), directives, nextFiles, stagedBytes, changed, pending, blocked, disposed: { value: false } };
    planInternals.set(publicPlan, internals);
    transferred = true;
    return publicPlan;
  } finally {
    if (!transferred) closeDirectorySnapshot(sourceSnapshot);
  }
}

export async function planDirectoryReconciliation(options: DirectoryReconciliationOptions): Promise<DirectoryReconciliationPlan> {
  return planDirectoryReconciliationInternal(options);
}

/** Internal deterministic seam used by race tests and dispatch qualification. */
export async function planDirectoryReconciliationWithHooks(options: DirectoryReconciliationOptions, hooks: DirectoryReconciliationPlanningHooks): Promise<DirectoryReconciliationPlan> {
  return planDirectoryReconciliationInternal(options, hooks);
}

export function disposeDirectoryReconciliationPlan(plan: DirectoryReconciliationPlan): void {
  const internals = planInternals.get(plan);
  if (internals === undefined || internals.disposed.value) return;
  internals.disposed.value = true;
  closeDirectorySnapshot(internals.sourceSnapshot);
}

export async function executeDirectoryReconciliationPlan(plan: DirectoryReconciliationPlan, hooks?: TransactionHooks): Promise<void> {
  const internals = requirePlanInternals(plan);
  if (internals.disposed.value) fail(context(), "RECONCILE_INVALID_PLAN", "Directory reconciliation plan authority has been disposed.");
  try {
    if (internals.blocked) fail(context(), "RECONCILE_UNRESOLVED", "One unresolved directory record blocks reconciliation apply.");
    if (!internals.changed) return;
    await executeCanonicalTransaction({
      root: internals.root,
      nextFiles: internals.stagedBytes,
      expectedSnapshot: internals.canonicalSnapshot,
      operation: "reconcile",
      ...(hooks === undefined ? {} : { hooks }),
      validateStagedTree: (stageRoot) => validateStagedTree(stageRoot, internals.stagedBytes),
      verifyExternalState: () => verifyDirectoryAuthority(internals),
    });
  } finally {
    disposeDirectoryReconciliationPlan(plan);
  }
}

/** Internal retention seam; not re-exported by the package root. */
export function inspectDirectoryReconciliationPlanRetention(plan: DirectoryReconciliationPlan): PlanRetentionInspection {
  const internals = planInternals.get(plan);
  if (internals === undefined) throw new Error("Directory reconciliation plan was not produced by this planner instance.");
  const { sourceSnapshot, ...withoutSourceSnapshot } = internals;
  return mergePlanRetention(
    inspectPlanRetention([plan, withoutSourceSnapshot]),
    inspectDirectorySnapshotRetention(sourceSnapshot),
  );
}

export async function reconcileDirectoryProject(options: DirectoryReconciliationOptions): Promise<DirectoryReconciliationResult> {
  const plan = await planDirectoryReconciliation(options);
  try {
    let applied = false;
    if (options.apply === true && !plan.blocked) {
      await executeDirectoryReconciliationPlan(plan);
      applied = plan.changed;
    }
    return { records: plan.records, changed: plan.changed, pending: plan.pending, blocked: plan.blocked, applied, sourceMapDigest: plan.sourceMapDigest, snapshotDigest: plan.snapshotDigest, ...(plan.normalizationPolicy === undefined ? {} : { normalizationPolicy: plan.normalizationPolicy, ...(plan.normalizationLedger === undefined ? {} : { normalizationLedger: plan.normalizationLedger }) }) };
  } finally {
    if (options.apply !== true || plan.blocked) disposeDirectoryReconciliationPlan(plan);
  }
}

// Dispatcher-friendly aliases; all aliases preserve the same private WeakMap authority.
export const planDirectoryReconcile = planDirectoryReconciliation;
export const executeDirectoryReconcilePlan = executeDirectoryReconciliationPlan;
export const reconcileDirectory = reconcileDirectoryProject;
