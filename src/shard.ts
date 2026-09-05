import { constants, type Stats } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { link, lstat, open, unlink, type FileHandle } from "node:fs/promises";

import { parse as parseToml, TomlError } from "smol-toml";

import {
  ANALYZE_COMMON_V03_PROFILE,
  type CommonV03Classification,
} from "./analyze-contract.js";
import { scanAnalyzeSvg } from "./analyze-scanner.js";
import { ARCHIVE_LIMITS } from "./archive-limits.js";
import {
  DiagnosticError,
  fail,
  fromCaught,
  ok,
  type DiagnosticContext,
} from "./diagnostics.js";
import { computeSha256, type Sha256Digest } from "./digests.js";
import {
  DIRECTORY_SNAPSHOT_BASIS,
  computeDirectorySnapshotDigest,
  discoverDirectorySources,
  revalidateDirectoryDiscovery,
  type DirectoryDiscoveryResult,
  type DirectoryFileDto,
} from "./directory-snapshot.js";
import {
  NORMALIZATION_POLICY_BASIS,
} from "./normalization-policy.js";
import {
  portablePathKey,
  validatePortablePathValue,
} from "./source-identity.js";
import {
  SOURCE_MAP_DIGEST_BASIS,
  computeSourceMapDigest,
  type SourceMapCollectionV1,
  type SourceMapV1,
} from "./source-map.js";
import type { Result } from "./types.js";

export const SHARD_MANIFEST_SCHEMA_VERSION = 1 as const;
export const SHARD_MEMBERSHIP_BASIS = "tfsb-shard-membership-v1" as const;
export const SHARD_MANIFEST_MAX_BYTES = 1024 * 1024;
export const SHARD_PROFILE = ANALYZE_COMMON_V03_PROFILE;

export interface ShardAssetV1 {
  readonly sourcePath: string;
  readonly assetId: string;
  readonly sourceDigest: Sha256Digest;
  readonly sourceBytes: number;
}

export interface ShardManifestV1 {
  readonly schemaVersion: typeof SHARD_MANIFEST_SCHEMA_VERSION;
  readonly collectionId: string;
  readonly sourceMapBasis: typeof SOURCE_MAP_DIGEST_BASIS;
  readonly sourceMapDigest: Sha256Digest;
  readonly sourceSnapshotBasis: typeof DIRECTORY_SNAPSHOT_BASIS;
  readonly sourceSnapshotDigest: Sha256Digest;
  readonly membershipBasis: typeof SHARD_MEMBERSHIP_BASIS;
  readonly membershipDigest: Sha256Digest;
  readonly assetCount: number;
  readonly selectedBytes: number;
  readonly profile: typeof SHARD_PROFILE;
  readonly directlyImportable: number;
  readonly normalizationRequired: number;
  readonly unsupported: number;
  readonly unsafe: number;
  readonly normalizationPolicyBasis?: typeof NORMALIZATION_POLICY_BASIS;
  readonly normalizationPolicyDigest?: Sha256Digest;
  readonly assets: readonly ShardAssetV1[];
}

export interface ShardPlanningOptions {
  readonly collectionId: string;
  /** Collection-relative source paths. */
  readonly paths?: readonly string[];
  /** Alias accepted for callers that use the directory-import vocabulary. */
  readonly selectedPaths?: readonly string[];
}

export interface ShardManifestOutputPlan {
  readonly manifest: ShardManifestV1;
  readonly sourceRoot: string;
  readonly targetPath: string;
  readonly parentPath: string;
  readonly parentIdentity: DirectoryIdentity;
}

export interface ShardManifestPublicationResult {
  readonly published: true;
  readonly targetPath: string;
  readonly cleanupResidue: null;
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

const TOP_KEYS = [
  "schema_version",
  "collection_id",
  "source_map_basis",
  "source_map_digest",
  "source_snapshot_basis",
  "source_snapshot_digest",
  "membership_basis",
  "membership_digest",
  "asset_count",
  "selected_bytes",
  "profile",
  "directly_importable",
  "normalization_required",
  "unsupported",
  "unsafe",
  "normalization_policy_basis",
  "normalization_policy_digest",
  "asset",
] as const;
const ASSET_KEYS = ["source_path", "asset_id", "source_digest", "source_bytes"] as const;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function context(source?: string): DiagnosticContext {
  const safeSource = source !== undefined
    && !source.startsWith("/")
    && !source.includes("\\")
    && !/^[A-Za-z]:/.test(source)
    ? source
    : undefined;
  return {
    operation: "discover",
    domain: "manifest",
    ...(safeSource === undefined ? {} : { source: safeSource }),
  };
}

function outputContext(source?: string): DiagnosticContext {
  const safeSource = source !== undefined
    && !source.startsWith("/")
    && !source.includes("\\")
    && !/^[A-Za-z]:/.test(source)
    ? source
    : undefined;
  return {
    operation: "discover",
    domain: "filesystem",
    ...(safeSource === undefined ? {} : { source: safeSource }),
  };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function record(value: unknown, ctx: DiagnosticContext, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(ctx, "SHARD_INVALID_TYPE", "Shard manifest value must be a table.", location);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  ctx: DiagnosticContext,
  location: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    fail(ctx, "SHARD_UNKNOWN_FIELD", `Unknown shard manifest field '${unknown}'.`, `${location}.${unknown}`);
  }
}

function string(value: unknown, ctx: DiagnosticContext, location: string): string {
  if (typeof value !== "string") fail(ctx, "SHARD_INVALID_TYPE", "Expected a string.", location);
  return value;
}

function digest(value: unknown, ctx: DiagnosticContext, location: string): Sha256Digest {
  const text = string(value, ctx, location);
  if (!DIGEST.test(text)) {
    fail(ctx, "SHARD_INVALID_DIGEST", "Expected a lowercase sha256 digest.", location);
  }
  return text as Sha256Digest;
}

function nonNegativeInteger(value: unknown, ctx: DiagnosticContext, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(ctx, "SHARD_INVALID_NUMBER", "Expected a non-negative safe integer.", location);
  }
  return value;
}

function collectionId(value: unknown, ctx: DiagnosticContext, location: string): string {
  const text = string(value, ctx, location);
  if (!ID.test(text)) fail(ctx, "SHARD_INVALID_COLLECTION_ID", "Collection id must use canonical kebab grammar.", location);
  return text;
}

function assetId(value: unknown, ctx: DiagnosticContext, location: string): string {
  const text = string(value, ctx, location);
  if (!ID.test(text)) fail(ctx, "SHARD_INVALID_ASSET_ID", "Asset id must use canonical kebab grammar.", location);
  if (Buffer.byteLength(text, "utf8") > 64) fail(ctx, "SHARD_INVALID_ASSET_ID", "Asset id exceeds 64 UTF-8 bytes.", location);
  return text;
}

function sourcePath(value: unknown, ctx: DiagnosticContext, location: string): string {
  const text = string(value, ctx, location);
  try {
    validatePortablePathValue(text, ctx, location);
  } catch (error) {
    if (error instanceof DiagnosticError) {
      fail(ctx, "SHARD_INVALID_SOURCE_PATH", error.diagnostic.message, location);
    }
    throw error;
  }
  if (!text.endsWith(".svg")) fail(ctx, "SHARD_INVALID_SOURCE_PATH", "Shard source paths must use the lowercase .svg suffix.", location);
  return text;
}

function parseAsset(value: unknown, index: number, ctx: DiagnosticContext): ShardAssetV1 {
  const location = `asset[${index}]`;
  const raw = record(value, ctx, location);
  exactKeys(raw, ASSET_KEYS, ctx, location);
  const sourcePathValue = sourcePath(raw.source_path, ctx, `${location}.source_path`);
  const id = assetId(raw.asset_id, ctx, `${location}.asset_id`);
  const sourceDigest = digest(raw.source_digest, ctx, `${location}.source_digest`);
  const sourceBytes = nonNegativeInteger(raw.source_bytes, ctx, `${location}.source_bytes`);
  if (sourceBytes > ARCHIVE_LIMITS.selectedEntryBytes) {
    fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `A shard asset exceeds ${ARCHIVE_LIMITS.selectedEntryBytes} bytes.`, `${location}.source_bytes`);
  }
  return { sourcePath: sourcePathValue, assetId: id, sourceDigest, sourceBytes };
}

function membershipPreimage(collection: string, assets: readonly Pick<ShardAssetV1, "sourcePath" | "assetId">[]): string {
  const sorted = [...assets].sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath));
  return `${SHARD_MEMBERSHIP_BASIS}\n${collection}\n${sorted.map((asset) => `${asset.sourcePath}\t${asset.assetId}\n`).join("")}`;
}

export function computeShardMembershipDigest(
  collection: string,
  assets: readonly Pick<ShardAssetV1, "sourcePath" | "assetId">[],
): Sha256Digest;
export function computeShardMembershipDigest(
  manifest: Pick<ShardManifestV1, "collectionId" | "assets">,
): Sha256Digest;
export function computeShardMembershipDigest(
  collectionOrManifest: string | Pick<ShardManifestV1, "collectionId" | "assets">,
  assets?: readonly Pick<ShardAssetV1, "sourcePath" | "assetId">[],
): Sha256Digest {
  const collection = typeof collectionOrManifest === "string" ? collectionOrManifest : collectionOrManifest.collectionId;
  const members = typeof collectionOrManifest === "string" ? assets ?? [] : collectionOrManifest.assets;
  return computeSha256(Buffer.from(membershipPreimage(collection, members), "utf8"));
}

function parseDocument(value: unknown, ctx: DiagnosticContext): ShardManifestV1 {
  const root = record(value, ctx, "shard_manifest");
  exactKeys(root, TOP_KEYS, ctx, "shard_manifest");

  if (root.schema_version !== SHARD_MANIFEST_SCHEMA_VERSION) {
    fail(ctx, "SHARD_UNSUPPORTED_VERSION", "Shard manifest schema_version must be 1.", "schema_version");
  }
  const collection = collectionId(root.collection_id, ctx, "collection_id");
  if (root.source_map_basis !== SOURCE_MAP_DIGEST_BASIS) {
    fail(ctx, "SHARD_UNSUPPORTED_BASIS", "Unsupported source-map digest basis.", "source_map_basis");
  }
  const sourceMapDigest = digest(root.source_map_digest, ctx, "source_map_digest");
  if (root.source_snapshot_basis !== DIRECTORY_SNAPSHOT_BASIS) {
    fail(ctx, "SHARD_UNSUPPORTED_BASIS", "Unsupported source snapshot digest basis.", "source_snapshot_basis");
  }
  const sourceSnapshotDigest = digest(root.source_snapshot_digest, ctx, "source_snapshot_digest");
  if (root.membership_basis !== SHARD_MEMBERSHIP_BASIS) {
    fail(ctx, "SHARD_UNSUPPORTED_BASIS", "Unsupported shard membership digest basis.", "membership_basis");
  }
  const membershipDigest = digest(root.membership_digest, ctx, "membership_digest");
  const assetCount = nonNegativeInteger(root.asset_count, ctx, "asset_count");
  if (assetCount === 0 || assetCount > ARCHIVE_LIMITS.selectedSvgEntries) {
    fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `A shard must contain between 1 and ${ARCHIVE_LIMITS.selectedSvgEntries} assets.`, "asset_count");
  }
  const selectedBytes = nonNegativeInteger(root.selected_bytes, ctx, "selected_bytes");
  if (selectedBytes > ARCHIVE_LIMITS.selectedAggregateBytes) {
    fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `A shard may contain at most ${ARCHIVE_LIMITS.selectedAggregateBytes} selected bytes.`, "selected_bytes");
  }
  const profile = string(root.profile, ctx, "profile");
  if (profile !== SHARD_PROFILE) fail(ctx, "SHARD_UNSUPPORTED_PROFILE", "Unsupported shard analyzer profile.", "profile");
  const directlyImportable = nonNegativeInteger(root.directly_importable, ctx, "directly_importable");
  const normalizationRequired = nonNegativeInteger(root.normalization_required, ctx, "normalization_required");
  const unsupported = nonNegativeInteger(root.unsupported, ctx, "unsupported");
  const unsafe = nonNegativeInteger(root.unsafe, ctx, "unsafe");
  const hasNormalizationPolicyBasis = root.normalization_policy_basis !== undefined;
  const hasNormalizationPolicyDigest = root.normalization_policy_digest !== undefined;
  if (hasNormalizationPolicyBasis !== hasNormalizationPolicyDigest) {
    fail(ctx, "SHARD_INVALID_NORMALIZATION_SUMMARY", "Normalization-policy basis and digest must be supplied together.", "normalization_policy_basis");
  }
  if (hasNormalizationPolicyBasis && root.normalization_policy_basis !== NORMALIZATION_POLICY_BASIS) {
    fail(ctx, "SHARD_UNSUPPORTED_BASIS", "Unsupported normalization-policy basis.", "normalization_policy_basis");
  }
  const normalizationPolicyDigest = hasNormalizationPolicyDigest
    ? digest(root.normalization_policy_digest, ctx, "normalization_policy_digest")
    : undefined;

  if (!Array.isArray(root.asset)) fail(ctx, "SHARD_INVALID_TYPE", "asset must be an array of tables.", "asset");
  if (root.asset.length !== assetCount) fail(ctx, "SHARD_SUMMARY_MISMATCH", "asset_count must equal the number of asset records.", "asset_count");
  const assets = root.asset.map((value, index) => parseAsset(value, index, ctx))
    .sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath));
  const paths = new Map<string, string>();
  const ids = new Map<string, string>();
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index]!;
    const previous = paths.get(portablePathKey(asset.sourcePath));
    if (previous !== undefined) fail(ctx, "SHARD_DUPLICATE_SOURCE_PATH", `Duplicate or portably-colliding source path '${asset.sourcePath}'.`, `asset[${index}].source_path`);
    paths.set(portablePathKey(asset.sourcePath), asset.sourcePath);
    const previousId = ids.get(asset.assetId);
    if (previousId !== undefined) fail(ctx, "SHARD_DUPLICATE_ASSET_ID", `Duplicate asset id '${asset.assetId}'.`, `asset[${index}].asset_id`);
    ids.set(asset.assetId, asset.sourcePath);
  }
  const countedBytes = assets.reduce((total, asset) => total + asset.sourceBytes, 0);
  if (countedBytes !== selectedBytes) fail(ctx, "SHARD_SUMMARY_MISMATCH", "selected_bytes must equal the sum of asset source_bytes.", "selected_bytes");
  if (countedBytes > ARCHIVE_LIMITS.selectedAggregateBytes) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Shard selected bytes exceed the aggregate limit.", "selected_bytes");
  if (directlyImportable + normalizationRequired + unsupported + unsafe !== assetCount) {
    fail(ctx, "SHARD_SUMMARY_MISMATCH", "Analyzer summary counts must equal asset_count.", "profile");
  }
  if (unsupported !== 0 || unsafe !== 0) {
    fail(ctx, "SHARD_UNMATERIALIZABLE", "Shard manifests may contain only directly importable or normalization-required assets.", "profile");
  }
  const expectedMembership = computeShardMembershipDigest(collection, assets);
  if (expectedMembership !== membershipDigest) fail(ctx, "SHARD_MEMBERSHIP_MISMATCH", "membership_digest does not match source paths and asset ids.", "membership_digest");
  return {
    schemaVersion: SHARD_MANIFEST_SCHEMA_VERSION,
    collectionId: collection,
    sourceMapBasis: SOURCE_MAP_DIGEST_BASIS,
    sourceMapDigest,
    sourceSnapshotBasis: DIRECTORY_SNAPSHOT_BASIS,
    sourceSnapshotDigest,
    membershipBasis: SHARD_MEMBERSHIP_BASIS,
    membershipDigest,
    assetCount,
    selectedBytes,
    profile: SHARD_PROFILE,
    directlyImportable,
    normalizationRequired,
    unsupported,
    unsafe,
    ...(normalizationPolicyDigest === undefined ? {} : {
      normalizationPolicyBasis: NORMALIZATION_POLICY_BASIS,
      normalizationPolicyDigest,
    }),
    assets,
  };
}

export function parseShardManifest(text: string, source = "shard-manifest.toml"): Result<ShardManifestV1> {
  const ctx = context(source);
  try {
    if (Buffer.byteLength(text, "utf8") > SHARD_MANIFEST_MAX_BYTES) {
      fail(ctx, "SHARD_SIZE_LIMIT", "Shard manifest exceeds the 1 MiB size limit.", source);
    }
    return ok(parseDocument(parseToml(text.replace(/^\uFEFF/, "")), ctx));
  } catch (error) {
    return fromCaught(error, ctx, "SHARD_INVALID_TOML", "Shard manifest TOML is invalid.", (caught) => caught instanceof TomlError);
  }
}

function basic(value: string): string {
  return JSON.stringify(value)
    .replace(/\u007f/g, "\\u007F")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function manifestValue(value: ShardManifestV1): Record<string, unknown> {
  return {
    schema_version: value.schemaVersion,
    collection_id: value.collectionId,
    source_map_basis: value.sourceMapBasis,
    source_map_digest: value.sourceMapDigest,
    source_snapshot_basis: value.sourceSnapshotBasis,
    source_snapshot_digest: value.sourceSnapshotDigest,
    membership_basis: value.membershipBasis,
    membership_digest: value.membershipDigest,
    asset_count: value.assetCount,
    selected_bytes: value.selectedBytes,
    profile: value.profile,
    directly_importable: value.directlyImportable,
    normalization_required: value.normalizationRequired,
    unsupported: value.unsupported,
    unsafe: value.unsafe,
    ...(value.normalizationPolicyBasis === undefined ? {} : {
      normalization_policy_basis: value.normalizationPolicyBasis,
      normalization_policy_digest: value.normalizationPolicyDigest,
    }),
    asset: [...value.assets]
      .sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath))
      .map((asset) => ({
        source_path: asset.sourcePath,
        asset_id: asset.assetId,
        source_digest: asset.sourceDigest,
        source_bytes: asset.sourceBytes,
      })),
  };
}

export function serializeShardManifest(value: ShardManifestV1): string {
  const parsed = parseDocument(manifestValue(value), context());
  const lines = [
    "schema_version = 1",
    `collection_id = ${basic(parsed.collectionId)}`,
    `source_map_basis = ${basic(parsed.sourceMapBasis)}`,
    `source_map_digest = ${basic(parsed.sourceMapDigest)}`,
    `source_snapshot_basis = ${basic(parsed.sourceSnapshotBasis)}`,
    `source_snapshot_digest = ${basic(parsed.sourceSnapshotDigest)}`,
    `membership_basis = ${basic(parsed.membershipBasis)}`,
    `membership_digest = ${basic(parsed.membershipDigest)}`,
    `asset_count = ${parsed.assetCount}`,
    `selected_bytes = ${parsed.selectedBytes}`,
    `profile = ${basic(parsed.profile)}`,
    `directly_importable = ${parsed.directlyImportable}`,
    `normalization_required = ${parsed.normalizationRequired}`,
    `unsupported = ${parsed.unsupported}`,
    `unsafe = ${parsed.unsafe}`,
  ];
  if (parsed.normalizationPolicyBasis !== undefined && parsed.normalizationPolicyDigest !== undefined) {
    lines.push(
      `normalization_policy_basis = ${basic(parsed.normalizationPolicyBasis)}`,
      `normalization_policy_digest = ${basic(parsed.normalizationPolicyDigest)}`,
    );
  }
  for (const asset of parsed.assets) {
    lines.push(
      "",
      "[[asset]]",
      `source_path = ${basic(asset.sourcePath)}`,
      `asset_id = ${basic(asset.assetId)}`,
      `source_digest = ${basic(asset.sourceDigest)}`,
      `source_bytes = ${asset.sourceBytes}`,
    );
  }
  const serialized = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(serialized, "utf8") > SHARD_MANIFEST_MAX_BYTES) {
    fail(context(), "SHARD_SIZE_LIMIT", "Shard manifest exceeds the 1 MiB size limit.", "shard-manifest.toml");
  }
  return serialized;
}

function identity(stat: Stats): DirectoryIdentity {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function within(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.startsWith(sep));
}


async function readStableBytes(
  root: string,
  sourcePathValue: string,
  ctx: DiagnosticContext,
  location: string,
): Promise<Buffer> {
  const absolute = resolve(root, ...sourcePathValue.split("/"));
  const before = await lstat(absolute).catch(() => undefined);
  if (before === undefined || before.isSymbolicLink() || !before.isFile() || before.nlink > 1) {
    fail(ctx, "SHARD_SOURCE_CHANGED", "Selected source must remain a stable regular file.", location);
  }
  if (before.size > ARCHIVE_LIMITS.selectedEntryBytes) {
    fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Selected SVG exceeds ${ARCHIVE_LIMITS.selectedEntryBytes} bytes.`, location);
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedBefore = await handle.stat();
    if (!openedBefore.isFile() || openedBefore.isSymbolicLink() || openedBefore.nlink > 1 || !sameStats(before, openedBefore)) {
      fail(ctx, "SHARD_SOURCE_CHANGED", "Selected source changed before read.", location);
    }
    const bytes = Buffer.allocUnsafe(openedBefore.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead <= 0) fail(ctx, "SHARD_SOURCE_CHANGED", "Selected source became truncated during read.", location);
      offset += read.bytesRead;
    }
    const openedAfter = await handle.stat();
    const after = await lstat(absolute);
    if (!sameStats(openedBefore, openedAfter) || !sameStats(openedAfter, after) || bytes.byteLength !== after.size) {
      fail(ctx, "SHARD_SOURCE_CHANGED", "Selected source changed during read.", location);
    }
    return bytes;
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    fail(ctx, "SHARD_SOURCE_CHANGED", "Selected source could not be read safely.", location);
    return Buffer.alloc(0);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameStats(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.nlink === right.nlink;
}

function selectedPaths(options: ShardPlanningOptions | undefined, explicit: readonly string[] | undefined): readonly string[] {
  if (explicit !== undefined) return explicit;
  if (options?.paths !== undefined) return options.paths;
  return options?.selectedPaths ?? [];
}

function withinTree(path: string, tree: string): boolean {
  return tree === "." || path === tree || path.startsWith(`${tree}/`);
}

function selectedByCollection(collection: SourceMapCollectionV1, path: string): boolean {
  const included = collection.includePaths.includes(path) || collection.includeTrees.some((tree) => withinTree(path, tree));
  if (!included) return false;
  return !collection.excludePaths.includes(path)
    && !collection.excludeTrees.some((tree) => withinTree(path, tree))
    && !collection.entries.some((entry) => entry.kind === "exclusion" && entry.sourcePath === path);
}

function collectionMap(
  map: SourceMapV1,
  collection: SourceMapCollectionV1,
  paths: readonly string[],
  ctx: DiagnosticContext,
): SourceMapV1 {
  for (const path of paths) {
    if (!selectedByCollection(collection, path)) {
      fail(ctx, "SHARD_UNKNOWN_SELECTION", "Explicit source path is not included by the selected source map collection.", path);
    }
  }
  return { ...map, collections: [collection] };
}

function validateExplicitPaths(
  values: readonly string[],
  ctx: DiagnosticContext,
): readonly string[] {
  if (values.length === 0) fail(ctx, "SHARD_EMPTY_SELECTION", "A shard requires at least one explicit source path.", "paths");
  if (values.length > ARCHIVE_LIMITS.selectedSvgEntries) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `A shard supports at most ${ARCHIVE_LIMITS.selectedSvgEntries} assets.`, "paths");
  const exact = new Set<string>();
  const portable = new Set<string>();
  for (const [index, value] of values.entries()) {
    validatePortablePathValue(value, ctx, `paths[${index}]`);
    if (!value.endsWith(".svg")) fail(ctx, "SHARD_INVALID_SOURCE_PATH", "Shard source paths must use the lowercase .svg suffix.", `paths[${index}]`);
    const key = portablePathKey(value);
    if (exact.has(value) || portable.has(key)) fail(ctx, "SHARD_DUPLICATE_SOURCE_PATH", "Shard source paths must be exact and portably unique.", `paths[${index}]`);
    exact.add(value);
    portable.add(key);
  }
  return [...values].sort(compareUtf8);
}

function discoveryError(result: Result<DirectoryDiscoveryResult>): DirectoryDiscoveryResult {
  if (result.ok) return result.value;
  throw new DiagnosticError(result.diagnostics[0]!);
}

export async function planShard(
  root: string,
  map: SourceMapV1,
  collection: string,
  explicit: readonly string[],
): Promise<Result<ShardManifestV1>>;
export async function planShard(
  root: string,
  map: SourceMapV1,
  options: ShardPlanningOptions,
): Promise<Result<ShardManifestV1>>;
export async function planShard(
  root: string,
  map: SourceMapV1,
  collectionOrOptions: string | ShardPlanningOptions,
  explicit?: readonly string[],
): Promise<Result<ShardManifestV1>> {
  const ctx = context();
  try {
    const options = typeof collectionOrOptions === "string"
      ? { collectionId: collectionOrOptions, paths: explicit ?? [] }
      : collectionOrOptions;
    const collectionId = collectionIdValue(options.collectionId, ctx);
    const selected = validateExplicitPaths(selectedPaths(options, explicit), ctx);
    const owner = map.collections.find((item) => item.id === collectionId);
    if (owner === undefined) fail(ctx, "SHARD_UNKNOWN_COLLECTION", `Unknown collection '${collectionId}'.`, collectionId);

    const scopedMap = collectionMap(map, owner, selected, ctx);
    const rootRelativeSelections = selected.map((path) => owner.root === "." ? path : `${owner.root}/${path}`);
    const discovery = discoveryError(await discoverDirectorySources(root, scopedMap, [collectionId], { selectedPaths: rootRelativeSelections }));
    const byCollectionPath = new Map<string, DirectoryFileDto>();
    for (const file of discovery.files) byCollectionPath.set(file.collectionPath, file);
    const files = selected.map((path) => {
      const file = byCollectionPath.get(path);
      if (file === undefined) fail(ctx, "SHARD_UNKNOWN_SELECTION", "Explicit source path is not an included asset in the selected collection.", path);
      return file;
    });

    const assets: ShardAssetV1[] = [];
    let selectedBytes = 0;
    let directlyImportable = 0;
    let normalizationRequired = 0;
    let unsupported = 0;
    let unsafe = 0;
    for (const file of files) {
      const bytes = await readStableBytes(root, file.sourcePath, ctx, file.collectionPath);
      const analysis = scanAnalyzeSvg(bytes, file.collectionPath, file.assetId).file;
      const classification: CommonV03Classification = analysis.profiles.commonV03.classification;
      if (classification === "unsafe") {
        fail(ctx, "SHARD_UNSAFE_SOURCE", "Unsafe SVG content cannot enter a shard.", file.collectionPath);
      }
      if (classification === "unsupported") {
        fail(ctx, "SHARD_UNSUPPORTED_SOURCE", "Unsupported SVG content cannot enter a shard.", file.collectionPath);
      }
      if (classification === "directly_importable") directlyImportable += 1;
      else normalizationRequired += 1;
      selectedBytes += bytes.byteLength;
      if (selectedBytes > ARCHIVE_LIMITS.selectedAggregateBytes) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `A shard may contain at most ${ARCHIVE_LIMITS.selectedAggregateBytes} selected bytes.`, "selected_bytes");
      assets.push({
        sourcePath: file.collectionPath,
        assetId: file.assetId,
        sourceDigest: computeSha256(bytes),
        sourceBytes: bytes.byteLength,
      });
    }
    const revalidated = await revalidateDirectoryDiscovery(root, scopedMap, discovery, [collectionId]);
    if (!revalidated.ok) throw new DiagnosticError(revalidated.diagnostics[0]!);
    assets.sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath));
    const manifest: ShardManifestV1 = {
      schemaVersion: SHARD_MANIFEST_SCHEMA_VERSION,
      collectionId,
      sourceMapBasis: SOURCE_MAP_DIGEST_BASIS,
      sourceMapDigest: computeSourceMapDigest(map),
      sourceSnapshotBasis: DIRECTORY_SNAPSHOT_BASIS,
      sourceSnapshotDigest: computeDirectorySnapshotDigest(
        computeSourceMapDigest(map),
        discovery.directories,
        files,
      ),
      membershipBasis: SHARD_MEMBERSHIP_BASIS,
      membershipDigest: computeShardMembershipDigest(collectionId, assets),
      assetCount: assets.length,
      selectedBytes,
      profile: SHARD_PROFILE,
      directlyImportable,
      normalizationRequired,
      unsupported,
      unsafe,
      assets,
    };
    return ok(parseDocument(manifestValue(manifest), ctx));
  } catch (error) {
    return fromCaught(error, ctx, "SHARD_PLANNING_FAILED", "Shard planning failed safely.", (caught) => caught instanceof DiagnosticError);
  }
}

export function planShardManifest(
  root: string,
  map: SourceMapV1,
  collectionOrOptions: string | ShardPlanningOptions,
  explicit?: readonly string[],
): Promise<Result<ShardManifestV1>> {
  return typeof collectionOrOptions === "string"
    ? planShard(root, map, collectionOrOptions, explicit ?? [])
    : planShard(root, map, collectionOrOptions);
}

interface ShardManifestPlanInternal {
  readonly parentHandle: FileHandle;
  readonly parentDev: number;
  readonly parentIno: number;
  readonly parentMode: number;
  disposed: boolean;
}

const PLAN_REGISTRY = new WeakMap<ShardManifestOutputPlan, ShardManifestPlanInternal>();

export async function disposeShardManifestOutputPlan(
  plan: ShardManifestOutputPlan,
): Promise<void> {
  const internal = PLAN_REGISTRY.get(plan);
  if (internal === undefined || internal.disposed) return;
  internal.disposed = true;
  await internal.parentHandle.close().catch(() => undefined);
}

export async function planShardManifestOutput(
  manifest: ShardManifestV1,
  target: string,
  sourceRoot: string,
): Promise<ShardManifestOutputPlan> {
  const ctx = outputContext();
  if (target === "" || target.includes("\0")) fail(ctx, "SHARD_OUTPUT_INVALID", "A non-empty manifest output target is required.");
  const targetPath = resolve(target);
  const rootPath = resolve(sourceRoot);
  const parentPath = dirname(targetPath);

  const parentStat = await lstat(parentPath).catch(() => undefined);
  if (parentStat === undefined || parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    fail(ctx, "SHARD_OUTPUT_INVALID", "Output parent must be an existing real directory.", parentPath);
  }

  let parentHandle: FileHandle | undefined;
  try {
    const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
    parentHandle = await open(parentPath, flags);
    const openedStat = await parentHandle.stat();
    if (openedStat.isSymbolicLink() || !openedStat.isDirectory() || !sameIdentity(identity(parentStat), identity(openedStat))) {
      fail(ctx, "SHARD_OUTPUT_INVALID", "Output parent changed during planning.", parentPath);
    }
    const parentIdentity = identity(openedStat);

    const sourceStat = await lstat(rootPath).catch(() => undefined);
    if (sourceStat === undefined || sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
      fail(ctx, "SHARD_OUTPUT_INVALID", "Shard source root must be an existing real directory.");
    }
    if (within(rootPath, targetPath)) {
      fail(ctx, "SHARD_OUTPUT_INVALID", "Manifest output must be outside the shard source root.");
    }
    if (await lstat(targetPath).catch(() => undefined) !== undefined) {
      fail(ctx, "SHARD_OUTPUT_EXISTS", "Manifest output target must be absent.");
    }
    serializeShardManifest(manifest);

    const plan: ShardManifestOutputPlan = Object.freeze({
      manifest,
      sourceRoot: rootPath,
      targetPath,
      parentPath,
      parentIdentity,
    });
    PLAN_REGISTRY.set(plan, {
      parentHandle,
      parentDev: openedStat.dev,
      parentIno: openedStat.ino,
      parentMode: openedStat.mode,
      disposed: false,
    });
    return plan;
  } catch (error) {
    if (parentHandle !== undefined) {
      await parentHandle.close().catch(() => undefined);
    }
    throw error;
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw new Error("short write");
    offset += result.bytesWritten;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function publishShardManifest(
  plan: ShardManifestOutputPlan,
): Promise<ShardManifestPublicationResult> {
  const ctx = outputContext();
  const internal = PLAN_REGISTRY.get(plan);
  if (internal === undefined || internal.disposed) {
    fail(ctx, "SHARD_OUTPUT_INVALID", "Manifest output plan is invalid or has already been consumed.");
  }
  internal.disposed = true;

  const serialized = serializeShardManifest(plan.manifest);
  const temporary = `${plan.targetPath}.tfsb-shard-${Math.random().toString(16).slice(2)}.tmp`;
  let handle: FileHandle | undefined;
  let temporaryOwned = false;
  let published = false;
  try {
    const parentBeforeTemp = await lstat(plan.parentPath).catch(() => undefined);
    if (parentBeforeTemp === undefined || parentBeforeTemp.isSymbolicLink() || !parentBeforeTemp.isDirectory()) {
      fail(ctx, "SHARD_OUTPUT_INVALID", "Manifest output parent changed before publication.");
    }
    const handleStatBeforeTemp = await internal.parentHandle.stat().catch(() => undefined);
    if (
      handleStatBeforeTemp === undefined
      || !sameIdentity(identity(parentBeforeTemp), identity(handleStatBeforeTemp))
      || !sameIdentity(identity(parentBeforeTemp), plan.parentIdentity)
    ) {
      fail(ctx, "SHARD_OUTPUT_INVALID", "Manifest output parent changed before publication.");
    }
    if (await lstat(plan.targetPath).catch(() => undefined) !== undefined) {
      fail(ctx, "SHARD_OUTPUT_EXISTS", "Manifest output target was created concurrently.");
    }

    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    temporaryOwned = true;
    await writeAll(handle, Buffer.from(serialized, "utf8"));
    await handle.sync();
    await handle.close();
    handle = undefined;

    const parentBeforeLink = await lstat(plan.parentPath).catch(() => undefined);
    if (parentBeforeLink === undefined || parentBeforeLink.isSymbolicLink() || !parentBeforeLink.isDirectory()) {
      fail(ctx, "SHARD_OUTPUT_INVALID", "Manifest output parent changed before publication.");
    }
    const handleStatBeforeLink = await internal.parentHandle.stat().catch(() => undefined);
    if (
      handleStatBeforeLink === undefined
      || !sameIdentity(identity(parentBeforeLink), identity(handleStatBeforeLink))
      || !sameIdentity(identity(parentBeforeLink), plan.parentIdentity)
    ) {
      fail(ctx, "SHARD_OUTPUT_INVALID", "Manifest output parent changed before publication.");
    }
    if (await lstat(plan.targetPath).catch(() => undefined) !== undefined) {
      fail(ctx, "SHARD_OUTPUT_EXISTS", "Manifest output target was created concurrently.");
    }
    try {
      await link(temporary, plan.targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        fail(ctx, "SHARD_OUTPUT_EXISTS", "Manifest output target was created concurrently.");
      }
      throw error;
    }
    published = true;
    await syncDirectory(plan.parentPath);
    await unlink(temporary);
    temporaryOwned = false;
    await syncDirectory(plan.parentPath);
    return { published: true, targetPath: plan.targetPath, cleanupResidue: null };
  } catch (error) {
    if (published) await unlink(plan.targetPath).catch(() => undefined);
    if (temporaryOwned) await unlink(temporary).catch(() => undefined);
    if (error instanceof DiagnosticError) throw error;
    throw new DiagnosticError({
      operation: "discover",
      domain: "filesystem",
      code: "SHARD_OUTPUT_FAILED",
      message: "Manifest output could not be published without partial output.",
    });
  } finally {
    await handle?.close().catch(() => undefined);
    await internal.parentHandle.close().catch(() => undefined);
  }
}

export async function writeShardManifest(
  manifest: ShardManifestV1,
  target: string,
  sourceRoot: string,
): Promise<ShardManifestPublicationResult> {
  const plan = await planShardManifestOutput(manifest, target, sourceRoot);
  try {
    return await publishShardManifest(plan);
  } finally {
    await disposeShardManifestOutputPlan(plan).catch(() => undefined);
  }
}

function collectionIdValue(value: unknown, ctx: DiagnosticContext): string {
  return collectionId(value, ctx, "collection_id");
}
