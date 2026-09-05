import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, relative, sep } from "node:path";
import { zipSync, type ZipOptions } from "fflate";

import { isAllowedCompanionFilename } from "../archive.js";
import { computeAssetSemanticDigest, computeRawSha256, computeSha256, computeSvgOutputDigest, type Sha256Digest } from "../digests.js";
import { DiagnosticError, fail, type DiagnosticContext } from "../diagnostics.js";
import {
  BUNDLE_MANIFEST_FILENAME,
  serializeBundleManifestV2,
  type BundleManifestGenerator,
  type BundleManifestRecordV2,
  type BundleManifestV2,
} from "../manifest.js";
import { loadCanonicalProjectFromSnapshot, type LoadedProject } from "../project.js";
import { compareUtf8, parseImportProvenance } from "../provenance.js";
import { parseImportProvenanceV2 } from "../provenance2.js";
import { parseImportProvenanceV3 } from "../provenance3.js";
import { findProjectRoot, resolveConfinedPath, validateProjectPathLayout } from "../root.js";
import { serializeSvgV2 } from "../schema2-svg.js";
import { snapshotCanonicalTree, snapshotsEqual, type CanonicalSnapshot } from "../transaction.js";
import type { AssetId, ProjectRelativePath } from "../types.js";
import { TOOL_VERSION } from "../version.js";
import {
  readOpenedFile,
  readRegularFileSnapshot,
  snapshotRegularFile,
  sameFileSnapshot,
  sameFileIdentity,
  identity,
  type PresentFileSnapshot,
  type FileIdentity,
} from "../filesystem.js";
import {
  BRAND_BUNDLE_MANIFEST_FILENAME,
  computeBrandBundleManifestDigest,
  serializeBrandBundleManifest,
  type BrandBundleManifest,
  type BrandBundleManifestCompanion,
  type BrandBundleManifestDerivedReceipt,
  type BrandBundleManifestInventoryItem,
  type BrandBundleManifestQaBaseline,
} from "./brand-bundle-manifest.js";
import { computeConsumerProfileDigest } from "./consumer-profile.js";
import { BRAND_BASELINE_MAX_AGGREGATE_BYTES, BRAND_BASELINE_MAX_FILE_BYTES, BRAND_FILE_INVENTORY, derivedReceiptPath } from "./brand-files.js";
import { inspectDerivedAuthority } from "./derive.js";
import { computeBrandPackageDigest, type BrandPackageCompanion, type BrandPackageModel } from "./brand-package.js";

export const BRAND_BUNDLE_LIMITS = {
  payloadRecords: 512,
  totalEntries: 514,
  selectedEntryBytes: 8 * 1024 * 1024,
  selectedAggregateBytes: BRAND_BASELINE_MAX_AGGREGATE_BYTES + 32 * 1024 * 1024,
  centralDirectoryBytes: 64 * 1024 * 1024,
  archiveFileBytes: 384 * 1024 * 1024,
  expansionRatio: 100,
} as const;

export interface BrandBundleOptions {
  readonly root?: string;
  readonly output: string;
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly generator?: BundleManifestGenerator;
  readonly assets?: readonly string[];
  readonly companions?: readonly string[];
}

export interface BrandBundleEntryDto {
  readonly type: "asset" | "companion" | "file" | "manifest";
  readonly name: string;
  readonly assetId?: string;
  readonly size: number;
  readonly sha256: string;
}

const brandBundlePlanBrand: unique symbol = Symbol("tfsb-brand-bundle-plan");

export interface BrandTargetSnapshot {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function createTargetSnapshot(path: string, stat: Stats): BrandTargetSnapshot {
  return {
    path,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameTargetSnapshot(left: BrandTargetSnapshot, right: BrandTargetSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export interface BrandBundleTransactionHooks {
  readonly beforeStageCreate?: () => void | Promise<void>;
  readonly beforeStageWrite?: () => void | Promise<void>;
  readonly afterStageWrite?: () => void | Promise<void>;
  readonly beforeSourceRevalidation?: () => void | Promise<void>;
  readonly beforeTargetRevalidation?: () => void | Promise<void>;
  readonly beforeCommit?: () => void | Promise<void>;
  readonly afterTargetBackup?: () => void | Promise<void>;
  readonly afterPromotion?: () => void | Promise<void>;
  readonly beforeCleanup?: () => void | Promise<void>;
}

export type ProducerCompanionSnapshot =
  | { readonly kind: "present"; readonly path: string; readonly snapshot: PresentFileSnapshot }
  | {
      readonly kind: "absent";
      readonly path: string;
      readonly configuredSource: string;
      readonly nearestExistingAncestorPath: string;
      readonly nearestExistingAncestorIdentity: FileIdentity;
    };

interface BrandBundlePlanInternals {
  readonly root: string;
  readonly outputPath: string;
  readonly zipBytes: Uint8Array;
  readonly canonicalSnapshot: CanonicalSnapshot;
  readonly targetSnapshot: BrandTargetSnapshot | undefined;
  readonly parentSnapshot: FileIdentity & { readonly path: string };
  readonly producerSnapshots: ReadonlyMap<string, ProducerCompanionSnapshot>;
  readonly parentHandle: FileHandle;
  readonly targetHandle?: FileHandle | undefined;
  readonly producerHandles: ReadonlyMap<string, FileHandle>;
  readonly force: boolean;
  readonly replaced: boolean;
  disposed: boolean;
}

const brandBundlePlanInternals = new WeakMap<BrandBundlePlan, BrandBundlePlanInternals>();

export async function disposeBrandBundlePlan(plan: BrandBundlePlan): Promise<void> {
  const internals = brandBundlePlanInternals.get(plan);
  if (internals === undefined || internals.disposed) return;
  internals.disposed = true;
  if (internals.parentHandle !== undefined) {
    await internals.parentHandle.close().catch(() => undefined);
  }
  if (internals.targetHandle !== undefined) {
    await internals.targetHandle.close().catch(() => undefined);
  }
  for (const handle of internals.producerHandles.values()) {
    await handle.close().catch(() => undefined);
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesWritten <= 0) throw new Error("short write");
    offset += result.bytesWritten;
  }
}

export interface BrandBundlePlan {
  readonly root: string;
  readonly outputPath: string;
  readonly projectRelativeOutputPath: ProjectRelativePath;
  readonly entries: readonly BrandBundleEntryDto[];
  readonly totalBytes: number;
  readonly assetCount: number;
  readonly companionCount: number;
  readonly domainCount: number;
  readonly packageId: string;
  readonly brandVersion: string;
  readonly genericManifestByteDigest: Sha256Digest;
  readonly brandPackageDigest: Sha256Digest;
  readonly brandSystemDigest: Sha256Digest;
  readonly brandManifestDigest: Sha256Digest;
  readonly replaced: boolean;
  readonly [brandBundlePlanBrand]: true;
}

export interface BrandBundleResult {
  readonly root: string;
  readonly projectRelativeOutputPath: ProjectRelativePath;
  readonly entries: readonly BrandBundleEntryDto[];
  readonly totalBytes: number;
  readonly assetCount: number;
  readonly companionCount: number;
  readonly domainCount: number;
  readonly packageId: string;
  readonly brandVersion: string;
  readonly genericManifestByteDigest: Sha256Digest;
  readonly brandPackageDigest: Sha256Digest;
  readonly brandSystemDigest: Sha256Digest;
  readonly brandManifestDigest: Sha256Digest;
  readonly written: boolean;
  readonly replaced: boolean;
}

function context(source?: string): DiagnosticContext {
  return {
    operation: "bundle",
    domain: "project",
    ...(source === undefined ? {} : { source }),
  };
}

function validateOutputConfinement(
  root: string,
  outputPath: string,
  project: LoadedProject,
  ctx: DiagnosticContext,
): ProjectRelativePath {
  const relativePath = relative(root, outputPath).split(sep).join("/") as ProjectRelativePath;
  const normalizedOutput = relativePath.normalize("NFC");

  if (!normalizedOutput.endsWith(".zip")) {
    fail(ctx, "BUNDLE_INVALID_OUTPUT_PATH", "Output path must end in '.zip'.", relativePath);
  }

  const overlaps = (target: string, prefix: string): boolean => {
    return target === prefix || target.startsWith(`${prefix}/`);
  };

  if (overlaps(normalizedOutput, ".tfsb")) {
    fail(ctx, "ROOT_PATH_OVERLAP", "Output path cannot be inside or overlap '.tfsb'.", relativePath);
  }
  if (overlaps(normalizedOutput, project.project.buildDirectory)) {
    fail(ctx, "ROOT_PATH_OVERLAP", "Output path cannot be inside or overlap the build directory.", relativePath);
  }
  if (overlaps(normalizedOutput, ".tfsb-preview")) {
    fail(ctx, "ROOT_PATH_OVERLAP", "Output path cannot be inside or overlap '.tfsb-preview'.", relativePath);
  }

  for (const install of project.project.installs) {
    for (const dest of install.destinations) {
      if (overlaps(normalizedOutput, dest) || overlaps(dest, normalizedOutput)) {
        fail(ctx, "ROOT_PATH_OVERLAP", `Output path overlaps install destination '${dest}'.`, relativePath);
      }
    }
  }

  for (const companion of project.project.companions ?? []) {
    for (const dest of companion.destinations) {
      if (overlaps(normalizedOutput, dest) || overlaps(dest, normalizedOutput)) {
        fail(ctx, "ROOT_PATH_OVERLAP", `Output path overlaps companion destination '${dest}'.`, relativePath);
      }
    }
  }

  return normalizedOutput as ProjectRelativePath;
}

async function resolveCompanionAuthorityBytes(
  root: string,
  companion: BrandPackageCompanion,
  canonicalSnapshot: CanonicalSnapshot,
  producerSnapshots: Map<string, ProducerCompanionSnapshot>,
  producerHandles: Map<string, FileHandle>,
  ctx: DiagnosticContext,
): Promise<Uint8Array | undefined> {
  const sourceResolved = await resolveConfinedPath(root, companion.source, "bundle");
  let sourceStat: Stats | undefined;
  try {
    sourceStat = await lstat(sourceResolved);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      sourceStat = undefined;
    } else {
      throw err;
    }
  }

  if (sourceStat !== undefined) {
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      fail(ctx, "COMPANION_SOURCE_UNSAFE", `Companion source '${companion.source}' must be a regular non-symlink file.`, companion.source);
    }
    if (sourceStat.size > BRAND_BUNDLE_LIMITS.selectedEntryBytes) {
      fail(ctx, "COMPANION_SOURCE_UNSAFE", `Companion source '${companion.source}' exceeds 8 MiB limit.`, companion.source);
    }
    const handle = await open(sourceResolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const openedBefore = await handle.stat();
      if (!openedBefore.isFile() || openedBefore.isSymbolicLink() || !sameFileIdentity(identity(sourceStat), identity(openedBefore))) {
        fail(ctx, "COMPANION_SOURCE_UNSAFE", `Companion source '${companion.source}' changed during open.`, companion.source);
      }
      if (openedBefore.size > BRAND_BUNDLE_LIMITS.selectedEntryBytes) {
        fail(ctx, "COMPANION_SOURCE_UNSAFE", `Companion source '${companion.source}' exceeds 8 MiB limit.`, companion.source);
      }
      const bytes = await readOpenedFile(handle, openedBefore.size, BRAND_BUNDLE_LIMITS.selectedEntryBytes);
      const openedAfter = await handle.stat();
      const afterStat = await lstat(sourceResolved);
      if (
        bytes.byteLength !== openedBefore.size ||
        !sameFileIdentity(identity(openedBefore), identity(openedAfter)) ||
        afterStat === undefined ||
        !afterStat.isFile() ||
        afterStat.isSymbolicLink() ||
        !sameFileIdentity(identity(openedAfter), identity(afterStat))
      ) {
        fail(ctx, "COMPANION_SOURCE_UNSAFE", `Companion source '${companion.source}' changed during read.`, companion.source);
      }

      const computedDigest: Sha256Digest = `sha256:${computeRawSha256(bytes)}`;
      if (computedDigest !== companion.digest) {
        fail(
          ctx,
          "COMPANION_DIGEST_MISMATCH",
          `Companion source '${companion.source}' digest '${computedDigest}' does not match declared digest '${companion.digest}'.`,
          companion.source,
        );
      }

      const canonicalRelPath = `.tfsb/companions/${companion.canonicalCompanionFile}`;
      const canonicalEntry = canonicalSnapshot.files.get(canonicalRelPath);
      if (canonicalEntry !== undefined) {
        const canonicalDigest = computeSha256(canonicalEntry.bytes);
        if (canonicalDigest !== companion.digest) {
          fail(
            ctx,
            "COMPANION_DIGEST_MISMATCH",
            `Canonical companion '${canonicalRelPath}' digest '${canonicalDigest}' does not match declared digest '${companion.digest}'.`,
            canonicalRelPath,
          );
        }
      }

      producerSnapshots.set(companion.id, {
        kind: "present",
        path: sourceResolved,
        snapshot: { kind: "file", ...identity(openedAfter), sha256: computeRawSha256(bytes), bytes },
      });
      producerHandles.set(companion.id, handle);
      return bytes;
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
  }

  // Source is absent (ENOENT) on disk -> snapshot nearest existing ancestor directory
  let nearestExistingAncestorPath = dirname(sourceResolved);
  let nearestExistingAncestorStat: Stats | undefined;
  while (true) {
    try {
      nearestExistingAncestorStat = await lstat(nearestExistingAncestorPath);
      break;
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        const parent = dirname(nearestExistingAncestorPath);
        if (parent === nearestExistingAncestorPath || !parent.startsWith(root)) {
          nearestExistingAncestorPath = root;
          nearestExistingAncestorStat = await lstat(root);
          break;
        }
        nearestExistingAncestorPath = parent;
      } else {
        throw err;
      }
    }
  }

  if (
    nearestExistingAncestorStat === undefined ||
    !nearestExistingAncestorStat.isDirectory() ||
    nearestExistingAncestorStat.isSymbolicLink()
  ) {
    fail(
      ctx,
      "COMPANION_SOURCE_UNSAFE",
      `Nearest existing ancestor '${nearestExistingAncestorPath}' is not a valid directory.`,
      nearestExistingAncestorPath,
    );
  }

  const ancestorHandle = await open(
    nearestExistingAncestorPath,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  const openedAncestorStat = await ancestorHandle.stat();
  if (
    !openedAncestorStat.isDirectory() ||
    openedAncestorStat.isSymbolicLink() ||
    !sameFileIdentity(identity(nearestExistingAncestorStat), identity(openedAncestorStat))
  ) {
    await ancestorHandle.close().catch(() => undefined);
    fail(
      ctx,
      "COMPANION_SOURCE_UNSAFE",
      `Nearest existing ancestor '${nearestExistingAncestorPath}' changed during open.`,
      nearestExistingAncestorPath,
    );
  }

  producerHandles.set(`${companion.id}:ancestor`, ancestorHandle);
  producerSnapshots.set(companion.id, {
    kind: "absent",
    path: sourceResolved,
    configuredSource: companion.source,
    nearestExistingAncestorPath,
    nearestExistingAncestorIdentity: identity(openedAncestorStat),
  });

  // Source is absent on disk -> check import provenance and canonical companion
  const canonicalRelPath = `.tfsb/companions/${companion.canonicalCompanionFile}`;
  const canonicalEntry = canonicalSnapshot.files.get(canonicalRelPath);
  if (canonicalEntry === undefined) {
    if (companion.required === false) {
      return undefined;
    }
    fail(
      ctx,
      "COMPANION_SOURCE_UNAVAILABLE",
      `Companion source '${companion.source}' is absent and canonical companion '${canonicalRelPath}' does not exist.`,
      companion.source,
    );
  }

  const provenanceFile = canonicalSnapshot.files.get(".tfsb/provenance.json");
  if (provenanceFile === undefined) {
    if (companion.required === false) {
      return undefined;
    }
    fail(
      ctx,
      "COMPANION_SOURCE_UNAVAILABLE",
      `Companion source '${companion.source}' is absent and import provenance is missing.`,
      companion.source,
    );
  }

  let provenanceText: string;
  try {
    provenanceText = new TextDecoder("utf-8", { fatal: true }).decode(provenanceFile.bytes);
  } catch {
    fail(ctx, "COMPANION_SOURCE_UNAVAILABLE", "Provenance JSON is invalid UTF-8.", ".tfsb/provenance.json");
  }

  let provenanceMatched = false;
  try {
    const raw = JSON.parse(provenanceText);
    if (raw.schemaVersion === 2) {
      const parsed2 = parseImportProvenanceV2(provenanceText, ".tfsb/provenance.json");
      if (parsed2.ok) {
        const compRec = parsed2.value.records.find(
          (r) => r.type === "companion" && r.canonicalPath === canonicalRelPath,
        );
        if (compRec !== undefined && compRec.archive?.sourceDigest === companion.digest) {
          provenanceMatched = true;
        }
      }
    } else if (raw.schemaVersion === 3) {
      const parsed3 = parseImportProvenanceV3(provenanceText, ".tfsb/provenance.json");
      if (parsed3.ok) {
        const compRec = parsed3.value.records.find(
          (r) => r.type === "companion" && r.canonicalPath === canonicalRelPath,
        );
        if (compRec !== undefined && compRec.source?.sourceDigest === companion.digest) {
          provenanceMatched = true;
        }
      }
    } else if (raw.schemaVersion === 1) {
      const parsed1 = parseImportProvenance(provenanceText, ".tfsb/provenance.json");
      if (parsed1.ok) {
        const compRec = parsed1.value.records.find(
          (r) => r.type === "companion" && r.canonicalPath === canonicalRelPath,
        );
        if (compRec !== undefined && (compRec as any).archiveDigest === companion.digest) {
          provenanceMatched = true;
        }
      }
    }
  } catch {
    fail(ctx, "COMPANION_SOURCE_UNAVAILABLE", "Failed to parse provenance JSON.", ".tfsb/provenance.json");
  }

  if (!provenanceMatched) {
    if (companion.required === false) {
      return undefined;
    }
    fail(
      ctx,
      "COMPANION_SOURCE_UNAVAILABLE",
      `Companion source '${companion.source}' is absent and canonical companion '${canonicalRelPath}' lacks valid matching import provenance.`,
      companion.source,
    );
  }

  const canonicalDigest = computeSha256(canonicalEntry.bytes);
  if (canonicalDigest !== companion.digest) {
    fail(
      ctx,
      "COMPANION_DIGEST_MISMATCH",
      `Canonical companion '${canonicalRelPath}' digest '${canonicalDigest}' does not match declared digest '${companion.digest}'.`,
      canonicalRelPath,
    );
  }

  return canonicalEntry.bytes;
}

export async function planBrandBundle(options: BrandBundleOptions): Promise<BrandBundlePlan> {
  const ctx = context(options.output);

  if (typeof options.output !== "string" || options.output.trim() === "") {
    fail(ctx, "BUNDLE_OUTPUT_REQUIRED", "Brand bundle requires --output <project-relative.zip>.");
  }

  if ((options.assets !== undefined && options.assets.length > 0) || (options.companions !== undefined && options.companions.length > 0)) {
    fail(ctx, "BUNDLE_SUBSET_UNSUPPORTED", "Brand package bundling does not accept subset --asset or --companion flags; brand package bundles are always complete.");
  }

  const root = await findProjectRoot(options.root, "bundle", options.root !== undefined);
  const resolvedOutput = await resolveConfinedPath(root, options.output, "bundle");

  const canonicalSnapshot = await snapshotCanonicalTree(root);
  const project = await loadCanonicalProjectFromSnapshot(canonicalSnapshot, "bundle");
  validateProjectPathLayout(project.project);

  const projectRelativeOutputPath = validateOutputConfinement(root, resolvedOutput, project, ctx);

  let parentHandle: FileHandle | undefined;
  let targetHandle: FileHandle | undefined;
  const producerHandles = new Map<string, FileHandle>();

  try {
    // Validate parent directory and open handle
    const parentDir = dirname(resolvedOutput);
    const parentStat = await lstat(parentDir).catch(() => undefined);
    if (parentStat === undefined || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      fail(ctx, "BUNDLE_PARENT_INVALID", "Output parent directory must exist and be a non-symlink directory.", parentDir);
    }
    const parentFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
    parentHandle = await open(parentDir, parentFlags);
    const openedParentStat = await parentHandle.stat();
    if (
      !openedParentStat.isDirectory() ||
      openedParentStat.isSymbolicLink() ||
      openedParentStat.dev !== parentStat.dev ||
      openedParentStat.ino !== parentStat.ino
    ) {
      fail(ctx, "BUNDLE_PARENT_INVALID", "Output parent directory changed during planning.", parentDir);
    }
    const parentSnapshot = {
      path: parentDir,
      ...identity(openedParentStat),
    };

    // Inspect existing target and open handle if present
    const targetStat = await lstat(resolvedOutput).catch(() => undefined);
    let targetSnapshot: BrandTargetSnapshot | undefined;
    let replaced = false;

    if (targetStat !== undefined) {
      if (targetStat.isSymbolicLink()) {
        fail(ctx, "BUNDLE_TARGET_IS_SYMLINK", "Output target is a symbolic link.", options.output);
      }
      if (targetStat.isDirectory()) {
        fail(ctx, "BUNDLE_TARGET_IS_DIRECTORY", "Output target is a directory.", options.output);
      }
      if (!targetStat.isFile()) {
        fail(ctx, "BUNDLE_TARGET_UNSAFE_TYPE", "Output target is not a regular file.", options.output);
      }
      if (!options.force) {
        fail(ctx, "BUNDLE_TARGET_EXISTS", "Output file already exists; use --force to overwrite.", options.output);
      }
      targetHandle = await open(resolvedOutput, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const openedTargetStat = await targetHandle.stat();
      if (!openedTargetStat.isFile() || openedTargetStat.isSymbolicLink() || !sameFileIdentity(identity(targetStat), identity(openedTargetStat))) {
        fail(ctx, "BUNDLE_TARGET_CHANGED", "Output target changed during open.", options.output);
      }
      targetSnapshot = createTargetSnapshot(resolvedOutput, openedTargetStat);
      replaced = true;
    }

    if (project.brand === undefined) {
      fail(ctx, "BRAND_PROJECT_REQUIRED", "Brand package bundling requires a branded project (.tfsb/brand.toml).");
    }

    const brandModel = project.brand.model;
    const packageModel = project.brand.packageModel;
    if (packageModel === undefined) {
      fail(ctx, "BRAND_PACKAGE_REQUIRED", "Brand package bundling requires .tfsb/brand-package.toml.");
    }

    // Check declared-unavailable domains
    const unavailableDomain = project.brand.domains.find((d) => d.state === "declared-unavailable");
    if (unavailableDomain !== undefined) {
      fail(
        ctx,
        "BRAND_DOMAIN_UNAVAILABLE",
        `Brand domain '${unavailableDomain.domain}' is declared enabled but unavailable in TFSB47B; capability blocks package creation.`,
      );
    }

    const brandSystemDigest = project.brand.brandSystemDigest;
    if (brandSystemDigest === undefined) {
      fail(ctx, "BRAND_SYSTEM_DIGEST_UNAVAILABLE", "Brand system digest could not be computed.");
    }
    if (packageModel.brandSystemDigest !== brandSystemDigest) {
      fail(
        ctx,
        "BRAND_SYSTEM_DIGEST_MISMATCH",
        `Package brand system digest '${packageModel.brandSystemDigest}' does not match computed digest '${brandSystemDigest}'.`,
        ".tfsb/brand-package.toml",
      );
    }

    const brandPackageDigest = project.brand.brandPackageDigest ?? computeBrandPackageDigest(packageModel);
    const derivedInspection = project.brand.recipesModel === undefined
      ? undefined
      : inspectDerivedAuthority(project.snapshot.files, { operation: "bundle", domain: "brand" });
    const blockedDerived = derivedInspection?.entries.find((entry) => entry.state !== "unchanged");
    if (blockedDerived !== undefined) {
      fail(ctx, "DERIVED_AUTHORITY_BLOCKED", `Brand bundle requires current derived authority; '${blockedDerived.targetAssetId}' is ${blockedDerived.state}.`, blockedDerived.targetAssetId);
    }

    // Asset validation and payload preparation
    const assetMap = new Map(project.assets.map((a) => [a.id, a]));
    const payloadEntriesByName = new Map<string, Uint8Array>();
    const manifestRecordsV2: BundleManifestRecordV2[] = [];
    const entriesDto: BrandBundleEntryDto[] = [];
    const seenPortablePaths = new Map<string, string>();
    let aggregateBytes = 0;

    const brandManifestInventory: BrandBundleManifestInventoryItem[] = [];
    const seenPayloadAssets = new Set<string>();

    for (const item of packageModel.inventory) {
      const asset = assetMap.get(item.asset as AssetId);
      if (asset === undefined) {
        fail(
          ctx,
          "BRAND_PACKAGE_UNKNOWN_ASSET",
          `Inventory references asset '${item.asset}' which does not exist in canonical project.`,
          item.asset,
        );
      }

      const canonicalAssetDigest = project.brand.referencedAssets.find((r) => r.assetId === item.asset)?.canonicalAssetDigest;
      if (canonicalAssetDigest !== item.canonicalAssetDigest) {
        fail(
          ctx,
          "ASSET_DIGEST_MISMATCH",
          `Inventory asset '${item.asset}' canonical digest '${canonicalAssetDigest}' does not match package declaration '${item.canonicalAssetDigest}'.`,
          item.asset,
        );
      }

      const svgBytes = project.outputs.get(asset.filename);
      if (svgBytes === undefined) {
        fail(ctx, "ASSET_OUTPUT_MISSING", `Rendered SVG output for '${asset.filename}' is missing.`, asset.filename);
      }

      if (svgBytes.length > BRAND_BUNDLE_LIMITS.selectedEntryBytes) {
        fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Rendered SVG '${asset.filename}' exceeds 8 MiB limit.`, asset.filename);
      }

      const computedSvgSha256Hex = computeRawSha256(svgBytes);
      const expectedSvgSha256Hex = item.svgDigest.startsWith("sha256:") ? item.svgDigest.slice("sha256:".length) : item.svgDigest;
      if (computedSvgSha256Hex !== expectedSvgSha256Hex) {
        fail(
          ctx,
          "SVG_DIGEST_MISMATCH",
          `Rendered SVG '${asset.filename}' digest '${computedSvgSha256Hex}' does not match package declaration '${expectedSvgSha256Hex}'.`,
          asset.filename,
        );
      }

      const bundlePath = `assets/${asset.filename}`;
      if (!seenPayloadAssets.has(asset.id)) {
        seenPayloadAssets.add(asset.id);
        const portableKey = bundlePath.toLowerCase();
        const prev = seenPortablePaths.get(portableKey);
        if (prev !== undefined) {
          fail(ctx, "BUNDLE_COLLISION", `Portable path collision between '${prev}' and '${bundlePath}'.`, bundlePath);
        }
        seenPortablePaths.set(portableKey, bundlePath);

        aggregateBytes += svgBytes.length;
        if (aggregateBytes > BRAND_BUNDLE_LIMITS.selectedAggregateBytes) {
          fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Selected bundle entries exceed the brand-bundle aggregate limit.");
        }

        payloadEntriesByName.set(bundlePath, svgBytes);
        manifestRecordsV2.push({
          type: "asset",
          path: bundlePath,
          assetId: item.asset as AssetId,
          sha256: computedSvgSha256Hex,
        });
        entriesDto.push({
          type: "asset",
          name: bundlePath,
          assetId: item.asset,
          size: svgBytes.length,
          sha256: computedSvgSha256Hex,
        });
      }

      brandManifestInventory.push({
        assetId: item.asset,
        family: item.family,
        role: item.role,
        variant: item.variant,
        bundlePath,
        canonicalAssetDigest: item.canonicalAssetDigest,
        svgDigest: item.svgDigest,
      });
    }

    brandManifestInventory.sort((a, b) =>
      compareUtf8(a.family, b.family) ||
      compareUtf8(a.role, b.role) ||
      compareUtf8(a.variant, b.variant) ||
      compareUtf8(a.assetId, b.assetId),
    );

    const brandManifestDerivedReceipts: BrandBundleManifestDerivedReceipt[] = [];
    if (derivedInspection !== undefined) {
      for (const entry of derivedInspection.entries) {
        if (!seenPayloadAssets.has(entry.targetAssetId)) continue;
        const canonicalPath = derivedReceiptPath(entry.targetAssetId);
        const receiptBytes = canonicalSnapshot.files.get(canonicalPath)?.bytes;
        if (receiptBytes === undefined || entry.recipeId === undefined || entry.receiptDigest === undefined || entry.targetModelDigest === undefined || entry.targetSvgDigest === undefined) {
          fail(ctx, "DERIVED_RECEIPT_INVALID", `Packaged derived target '${entry.targetAssetId}' lacks exact receipt authority.`, canonicalPath);
        }
        const bundlePath = `derived/${entry.targetAssetId}.receipt.json`;
        const portableKey = bundlePath.toLowerCase();
        const previous = seenPortablePaths.get(portableKey);
        if (previous !== undefined) fail(ctx, "BUNDLE_COLLISION", `Portable path collision between '${previous}' and '${bundlePath}'.`, bundlePath);
        seenPortablePaths.set(portableKey, bundlePath);
        aggregateBytes += receiptBytes.byteLength;
        if (aggregateBytes > BRAND_BUNDLE_LIMITS.selectedAggregateBytes) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Selected bundle entries exceed the brand-bundle aggregate limit.");
        const sha256 = computeRawSha256(receiptBytes);
        payloadEntriesByName.set(bundlePath, receiptBytes);
        manifestRecordsV2.push({ type: "file", path: bundlePath, sha256 });
        entriesDto.push({ type: "file", name: bundlePath, size: receiptBytes.byteLength, sha256 });
        brandManifestDerivedReceipts.push({
          targetId: entry.targetAssetId,
          recipeId: entry.recipeId,
          bundlePath,
          receiptDigest: entry.receiptDigest,
          canonicalAssetDigest: entry.targetModelDigest,
          targetSvgDigest: entry.targetSvgDigest,
        });
      }
      brandManifestDerivedReceipts.sort((left, right) => compareUtf8(left.targetId, right.targetId));
    }

    // Brand files mapping (1:1 normative mapping)
    const domainDigests: Record<string, Sha256Digest> = {
      brand: project.brand.brandDigest,
    };
    if (project.brand.tokensDigest !== undefined) {
      domainDigests.tokens = project.brand.tokensDigest;
    }
    if (project.brand.recipesDigest !== undefined) {
      domainDigests.recipes = project.brand.recipesDigest;
    }
    if (project.brand.qaDigest !== undefined) {
      domainDigests.qa = project.brand.qaDigest;
    }
    if (project.brand.consumerProfilesDigest !== undefined) {
      domainDigests.consumer_profiles = project.brand.consumerProfilesDigest;
    }
    if (project.brand.exportsDigest !== undefined) {
      domainDigests.exports = project.brand.exportsDigest;
    }

    for (const entry of BRAND_FILE_INVENTORY) {
      const fileBytes = project.brand.brandFiles.get(entry.canonicalPath);
      if (fileBytes !== undefined) {
        const bundlePath = `brand/${entry.filename}`;
        const portableKey = bundlePath.toLowerCase();
        const prev = seenPortablePaths.get(portableKey);
        if (prev !== undefined) {
          fail(ctx, "BUNDLE_COLLISION", `Portable path collision between '${prev}' and '${bundlePath}'.`, bundlePath);
        }
        seenPortablePaths.set(portableKey, bundlePath);

        if (fileBytes.length > BRAND_BUNDLE_LIMITS.selectedEntryBytes) {
          fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Brand file '${entry.canonicalPath}' exceeds 8 MiB limit.`, bundlePath);
        }

        aggregateBytes += fileBytes.length;
        if (aggregateBytes > BRAND_BUNDLE_LIMITS.selectedAggregateBytes) {
          fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Selected bundle entries exceed the brand-bundle aggregate limit.");
        }

        const sha256 = computeRawSha256(fileBytes);
        payloadEntriesByName.set(bundlePath, fileBytes);
        manifestRecordsV2.push({
          type: "file",
          path: bundlePath,
          sha256,
        });
        entriesDto.push({
          type: "file",
          name: bundlePath,
          size: fileBytes.length,
          sha256,
        });
      }
    }

    const brandManifestQaBaselines: BrandBundleManifestQaBaseline[] = [];
    if (project.brand.qaModel !== undefined) {
      for (const qaCase of project.brand.qaModel.cases) {
        if (qaCase.kind !== "baseline") continue;
        const profile = project.brand.qaModel.profiles.find((candidate) => candidate.cases.includes(qaCase.id));
        if (profile === undefined) fail(ctx, "BRAND_QA_BASELINE_UNOWNED", `Baseline case '${qaCase.id}' has no owning profile.`);
        const canonicalEntry = canonicalSnapshot.files.get(qaCase.baselinePath);
        if (canonicalEntry === undefined) fail(ctx, "BRAND_QA_BASELINE_MISSING", `Baseline '${qaCase.baselinePath}' is missing.`, qaCase.baselinePath);
        const actualDigest: Sha256Digest = `sha256:${computeRawSha256(canonicalEntry.bytes)}`;
        if (actualDigest !== qaCase.baselineDigest) fail(ctx, "BRAND_QA_BASELINE_DRIFT", `Baseline '${qaCase.baselinePath}' digest does not match QA metadata.`, qaCase.baselinePath);
        const matches = qaCase.asset === undefined ? brandModel.bindings.filter((binding) => binding.family === qaCase.family && (qaCase.role === undefined || binding.role === qaCase.role) && (qaCase.variant === undefined || binding.variant === qaCase.variant)) : [];
        const targetId = qaCase.asset ?? (matches.length === 1 ? matches[0]!.asset : undefined);
        const target = targetId === undefined ? undefined : assetMap.get(targetId as AssetId);
        const targetSvg = target === undefined ? undefined : project.outputs.get(target.filename);
        if (target === undefined || targetSvg === undefined || computeAssetSemanticDigest(target) !== qaCase.canonicalAssetDigest || computeSvgOutputDigest(Buffer.from(targetSvg).toString("utf8")) !== qaCase.svgDigest) fail(ctx, "BRAND_QA_BASELINE_INPUT_MISMATCH", `Baseline '${qaCase.baselinePath}' input identity differs.`, qaCase.baselinePath);
        const bundlePath = `baselines/${profile.id}/${qaCase.id}.png`;
        const portableKey = bundlePath.toLowerCase();
        const previous = seenPortablePaths.get(portableKey);
        if (previous !== undefined) fail(ctx, "BUNDLE_COLLISION", `Portable path collision between '${previous}' and '${bundlePath}'.`, bundlePath);
        seenPortablePaths.set(portableKey, bundlePath);
        aggregateBytes += canonicalEntry.bytes.byteLength;
        if (aggregateBytes > BRAND_BUNDLE_LIMITS.selectedAggregateBytes) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Selected bundle entries exceed aggregate limit.");
        const sha256 = computeRawSha256(canonicalEntry.bytes);
        payloadEntriesByName.set(bundlePath, canonicalEntry.bytes);
        manifestRecordsV2.push({ type: "file", path: bundlePath, sha256 });
        entriesDto.push({ type: "file", name: bundlePath, size: canonicalEntry.bytes.byteLength, sha256 });
        brandManifestQaBaselines.push({ profileId: profile.id, caseId: qaCase.id, bundlePath, baselineDigest: qaCase.baselineDigest, rendererId: qaCase.rendererId, rendererVersion: qaCase.rendererVersion, platformClaim: qaCase.platformClaim, canonicalAssetDigest: qaCase.canonicalAssetDigest, svgDigest: qaCase.svgDigest, width: qaCase.sizes[0]![0], height: qaCase.sizes[0]![1], background: qaCase.backgrounds[0]! });
      }
      brandManifestQaBaselines.sort((a, b) => compareUtf8(a.profileId, b.profileId) || compareUtf8(a.caseId, b.caseId));
    }

    // Companions handling (Option A)
    const producerSnapshots = new Map<string, ProducerCompanionSnapshot>();
    const brandManifestCompanions: BrandBundleManifestCompanion[] = [];

    for (const comp of packageModel.companions) {
      const compBytes = await resolveCompanionAuthorityBytes(
        root,
        comp,
        canonicalSnapshot,
        producerSnapshots,
        producerHandles,
        ctx,
      );
      if (compBytes === undefined) {
        continue; // Optional companion omitted
      }
      const bundlePath = comp.bundlePath;
      const portableKey = bundlePath.toLowerCase();
      const prev = seenPortablePaths.get(portableKey);
      if (prev !== undefined) {
        fail(ctx, "BUNDLE_COLLISION", `Portable path collision between '${prev}' and '${bundlePath}'.`, bundlePath);
      }
      seenPortablePaths.set(portableKey, bundlePath);

      aggregateBytes += compBytes.length;
      if (aggregateBytes > BRAND_BUNDLE_LIMITS.selectedAggregateBytes) {
        fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Selected bundle entries exceed the brand-bundle aggregate limit.");
      }

      const sha256 = computeRawSha256(compBytes);
      payloadEntriesByName.set(bundlePath, compBytes);
      manifestRecordsV2.push({
        type: "companion",
        path: bundlePath,
        sha256,
      });
      entriesDto.push({
        type: "companion",
        name: bundlePath,
        size: compBytes.length,
        sha256,
      });

      brandManifestCompanions.push({
        id: comp.id,
        purpose: comp.purpose,
        bundlePath: comp.bundlePath,
        canonicalCompanionFile: comp.canonicalCompanionFile,
        mediaType: comp.mediaType,
        digest: comp.digest,
        required: comp.required,
      });
    }

    brandManifestCompanions.sort((a, b) => compareUtf8(a.id, b.id));

    // Enforce payload record limit (<= 512)
    if (manifestRecordsV2.length > BRAND_BUNDLE_LIMITS.payloadRecords) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        `Payload record count ${manifestRecordsV2.length} exceeds limit ${BRAND_BUNDLE_LIMITS.payloadRecords}.`,
      );
    }

    // Sort generic manifest v2 files by ascending UTF-8 bytes of path
    manifestRecordsV2.sort((a, b) => compareUtf8(a.path, b.path));

    // Construct and serialize Generic Manifest v2
    const manifestGenerator: BundleManifestGenerator = options.generator ?? {
      name: "@knowledge-forge-ai/theme-forge-stellar-burst",
      version: TOOL_VERSION,
    };

    const genericManifest: BundleManifestV2 = {
      kind: "tfsb-bundle-manifest",
      schemaVersion: 2,
      generator: manifestGenerator,
      projectName: project.project.name,
      files: Object.freeze(manifestRecordsV2),
    };

    const genericManifestText = serializeBundleManifestV2(genericManifest);
    const genericManifestBytes = Buffer.from(genericManifestText, "utf8");
    if (genericManifestBytes.length > BRAND_BUNDLE_LIMITS.selectedEntryBytes) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Generic manifest exceeds 8 MiB limit.");
    }
    const genericManifestByteDigest: Sha256Digest = `sha256:${computeRawSha256(genericManifestBytes)}`;

    // Construct and serialize Brand Bundle Manifest
    const brandManifestWithoutDigest: Omit<BrandBundleManifest, "brandManifestDigest"> = {
      schema: "tfsb.brand-bundle-manifest",
      schemaVersion: 1,
      packageId: packageModel.packageId,
      name: packageModel.name,
      brandVersion: packageModel.brandVersion,
      genericManifestByteDigest,
      brandPackageDigest,
      brandSystemDigest,
      domainDigests: Object.freeze(domainDigests),
      inventory: Object.freeze(brandManifestInventory),
      companions: Object.freeze(brandManifestCompanions),
      profiles: Object.freeze((project.brand.consumerProfilesModel?.profiles ?? []).map((profile) => Object.freeze({ profileId: profile.qualifiedId, version: profile.version, digest: computeConsumerProfileDigest(profile) })).sort((a, b) => compareUtf8(a.profileId, b.profileId))),
      ...(brandManifestDerivedReceipts.length === 0 ? {} : { derivedReceipts: Object.freeze(brandManifestDerivedReceipts) }),
      ...(brandManifestQaBaselines.length === 0 ? {} : { qaBaselines: Object.freeze(brandManifestQaBaselines) }),
    };

    const brandManifestDigest = computeBrandBundleManifestDigest(brandManifestWithoutDigest);
    const fullBrandManifest: BrandBundleManifest = Object.freeze({
      ...brandManifestWithoutDigest,
      brandManifestDigest,
    });

    const brandManifestText = serializeBrandBundleManifest(fullBrandManifest);
    const brandManifestBytes = Buffer.from(brandManifestText, "utf8");
    if (brandManifestBytes.length > BRAND_BUNDLE_LIMITS.selectedEntryBytes) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Brand bundle manifest exceeds 8 MiB limit.");
    }

    // Add the two reserved root manifests to archive entries
    const allArchiveEntries = new Map<string, Uint8Array>(payloadEntriesByName);
    allArchiveEntries.set(BUNDLE_MANIFEST_FILENAME, genericManifestBytes);
    allArchiveEntries.set(BRAND_BUNDLE_MANIFEST_FILENAME, brandManifestBytes);

    entriesDto.push({
      type: "manifest",
      name: BUNDLE_MANIFEST_FILENAME,
      size: genericManifestBytes.length,
      sha256: computeRawSha256(genericManifestBytes),
    });
    entriesDto.push({
      type: "manifest",
      name: BRAND_BUNDLE_MANIFEST_FILENAME,
      size: brandManifestBytes.length,
      sha256: computeRawSha256(brandManifestBytes),
    });

    if (allArchiveEntries.size > BRAND_BUNDLE_LIMITS.totalEntries) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        `Total archive entries ${allArchiveEntries.size} exceeds limit ${BRAND_BUNDLE_LIMITS.totalEntries}.`,
      );
    }

    // Build Store-Only Deterministic ZIP sorted by ascending UTF-8 bytes of path
    const sortedEntryPaths = [...allArchiveEntries.keys()].sort(compareUtf8);
    entriesDto.sort((a, b) => compareUtf8(a.name, b.name));

    const zipData: Record<string, [Uint8Array, ZipOptions]> = {};
    for (const entryPath of sortedEntryPaths) {
      zipData[entryPath] = [
        allArchiveEntries.get(entryPath)!,
        {
          level: 0,
          mtime: new Date(1980, 0, 1, 0, 0, 0, 0),
          os: 3,
          attrs: (0o100644 << 16) | 0x20,
        },
      ];
    }

    const zipBytes = zipSync(zipData);
    if (zipBytes.length > BRAND_BUNDLE_LIMITS.archiveFileBytes) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Planned brand ZIP archive exceeds 384 MiB limit.");
    }

    const currentCanonicalSnapshot = await snapshotCanonicalTree(root, false, "bundle");
    if (!snapshotsEqual(canonicalSnapshot, currentCanonicalSnapshot)) {
      fail(ctx, "CANONICAL_CHANGED_DURING_PLAN", "Canonical tree changed during brand bundle planning.", ".tfsb");
    }

    const plan: BrandBundlePlan = {
      root,
      outputPath: resolvedOutput,
      projectRelativeOutputPath,
      entries: Object.freeze(entriesDto),
      totalBytes: zipBytes.length,
      assetCount: brandManifestInventory.length,
      companionCount: brandManifestCompanions.length,
      domainCount: Object.keys(domainDigests).length,
      packageId: packageModel.packageId,
      brandVersion: packageModel.brandVersion,
      genericManifestByteDigest,
      brandPackageDigest,
      brandSystemDigest,
      brandManifestDigest,
      replaced,
      [brandBundlePlanBrand]: true,
    };

    brandBundlePlanInternals.set(plan, {
      root,
      outputPath: resolvedOutput,
      zipBytes,
      canonicalSnapshot,
      targetSnapshot,
      parentSnapshot,
      producerSnapshots,
      parentHandle,
      targetHandle,
      producerHandles,
      force: options.force === true,
      replaced,
      disposed: false,
    });

    return Object.freeze(plan);
  } catch (error) {
    if (parentHandle !== undefined) {
      await parentHandle.close().catch(() => undefined);
    }
    if (targetHandle !== undefined) {
      await targetHandle.close().catch(() => undefined);
    }
    for (const h of producerHandles.values()) {
      await h.close().catch(() => undefined);
    }
    throw error;
  }
}

export async function executeBrandBundle(
  plan: BrandBundlePlan,
  hooks?: BrandBundleTransactionHooks,
): Promise<BrandBundleResult> {
  const internals = brandBundlePlanInternals.get(plan);
  if (internals === undefined || internals.disposed) {
    fail(context(plan.outputPath), "BUNDLE_UNAUTHORIZED_PLAN", "Brand bundle plan is not authorized for execution.");
  }

  const ctx = context(internals.outputPath);
  const stagePath = `${internals.outputPath}.stage-${randomUUID()}`;
  const backupPath = `${internals.outputPath}.backup-${randomUUID()}`;
  let stageHandle: FileHandle | undefined;
  let targetBackedUp = false;

  const revalidateParent = async () => {
    const openedStat = await internals.parentHandle.stat();
    const namedStat = await lstat(internals.parentSnapshot.path).catch(() => undefined);
    if (
      namedStat === undefined ||
      !namedStat.isDirectory() ||
      namedStat.isSymbolicLink() ||
      openedStat.dev !== namedStat.dev ||
      openedStat.ino !== namedStat.ino ||
      (namedStat.mode & 0o170000) !== (internals.parentSnapshot.mode & 0o170000)
    ) {
      fail(ctx, "BUNDLE_PARENT_INVALID", "Output parent directory changed or became invalid after brand bundle planning.", internals.parentSnapshot.path);
    }
  };

  const revalidateProducers = async () => {
    for (const [id, entry] of internals.producerSnapshots) {
      if (entry.kind === "present") {
        const producerHandle = internals.producerHandles.get(id);
        if (producerHandle === undefined) {
          fail(ctx, "COMPANION_SOURCE_CHANGED", `Companion handle for '${entry.path}' missing.`);
        }
        const openedStat = await producerHandle.stat();
        if (
          !openedStat.isFile() ||
          openedStat.isSymbolicLink() ||
          !sameFileIdentity(identity(openedStat), entry.snapshot)
        ) {
          fail(ctx, "COMPANION_SOURCE_CHANGED", `Companion source '${entry.path}' changed after planning.`, entry.path);
        }
        if (openedStat.size > BRAND_BUNDLE_LIMITS.selectedEntryBytes) {
          fail(ctx, "COMPANION_SOURCE_CHANGED", `Companion source '${entry.path}' exceeds 8 MiB limit.`, entry.path);
        }
        const reReadBytes = await readOpenedFile(producerHandle, openedStat.size, BRAND_BUNDLE_LIMITS.selectedEntryBytes);
        if (
          reReadBytes.byteLength !== entry.snapshot.size ||
          computeRawSha256(reReadBytes) !== entry.snapshot.sha256
        ) {
          fail(ctx, "COMPANION_SOURCE_CHANGED", `Companion source '${entry.path}' content changed after planning.`, entry.path);
        }
        const openedAfterRead = await producerHandle.stat();
        if (!sameFileIdentity(identity(openedAfterRead), entry.snapshot)) {
          fail(ctx, "COMPANION_SOURCE_CHANGED", `Companion source '${entry.path}' changed after read.`, entry.path);
        }
        let namedStat: Stats | undefined;
        try {
          namedStat = await lstat(entry.path);
        } catch {
          fail(ctx, "COMPANION_SOURCE_CHANGED", `Companion source '${entry.path}' is no longer accessible.`, entry.path);
        }
        if (
          !namedStat.isFile() ||
          namedStat.isSymbolicLink() ||
          !sameFileIdentity(identity(openedStat), identity(namedStat))
        ) {
          fail(ctx, "COMPANION_SOURCE_CHANGED", `Companion source '${entry.path}' named path changed after planning.`, entry.path);
        }
      } else {
        await resolveConfinedPath(internals.root, entry.configuredSource, "bundle");

        const ancestorHandle = internals.producerHandles.get(`${id}:ancestor`);
        if (ancestorHandle !== undefined) {
          const openedAncestorStat = await ancestorHandle.stat();
          if (
            !openedAncestorStat.isDirectory() ||
            openedAncestorStat.isSymbolicLink() ||
            openedAncestorStat.dev !== entry.nearestExistingAncestorIdentity.dev ||
            openedAncestorStat.ino !== entry.nearestExistingAncestorIdentity.ino ||
            (openedAncestorStat.mode & 0o170000) !== (entry.nearestExistingAncestorIdentity.mode & 0o170000)
          ) {
            fail(ctx, "COMPANION_SOURCE_CHANGED", `Companion source ancestor directory '${entry.nearestExistingAncestorPath}' changed after fallback planning.`, entry.path);
          }
        }
        let namedAncestorStat: Stats | undefined;
        try {
          namedAncestorStat = await lstat(entry.nearestExistingAncestorPath);
        } catch {
          fail(ctx, "COMPANION_SOURCE_CHANGED", `Companion source ancestor directory '${entry.nearestExistingAncestorPath}' is no longer accessible.`, entry.path);
        }
        if (
          namedAncestorStat === undefined ||
          !namedAncestorStat.isDirectory() ||
          namedAncestorStat.isSymbolicLink() ||
          namedAncestorStat.dev !== entry.nearestExistingAncestorIdentity.dev ||
          namedAncestorStat.ino !== entry.nearestExistingAncestorIdentity.ino ||
          (namedAncestorStat.mode & 0o170000) !== (entry.nearestExistingAncestorIdentity.mode & 0o170000)
        ) {
          fail(ctx, "COMPANION_SOURCE_CHANGED", `Companion source ancestor directory '${entry.nearestExistingAncestorPath}' changed after fallback planning.`, entry.path);
        }

        try {
          const current = await lstat(entry.path);
          fail(ctx, "COMPANION_SOURCE_CHANGED", `Companion source '${entry.path}' appeared after fallback planning.`, entry.path);
        } catch (err: any) {
          if (err instanceof DiagnosticError) throw err;
          if (err?.code !== "ENOENT") {
            fail(ctx, "COMPANION_SOURCE_CHANGED", `Companion source '${entry.path}' resolution failed: ${err.message}`, entry.path);
          }
        }
      }
    }
  };

  const revalidateStage = async () => {
    if (stageHandle === undefined) {
      fail(ctx, "BUNDLE_TRANSACTION_FAILED", "Stage handle missing.");
    }
    const openedStat = await stageHandle.stat();
    const namedStat = await lstat(stagePath).catch(() => undefined);
    if (
      namedStat === undefined ||
      !namedStat.isFile() ||
      namedStat.isSymbolicLink() ||
      openedStat.dev !== namedStat.dev ||
      openedStat.ino !== namedStat.ino ||
      openedStat.size !== internals.zipBytes.length
    ) {
      fail(ctx, "BUNDLE_TRANSACTION_FAILED", "Stage file was modified or substituted before commit.");
    }
    const readBack = await readOpenedFile(stageHandle, openedStat.size);
    if (readBack.byteLength !== internals.zipBytes.length || Buffer.compare(readBack, internals.zipBytes) !== 0) {
      fail(ctx, "BUNDLE_TRANSACTION_FAILED", "Stage file content corrupted before commit.");
    }
  };

  const revalidateTarget = async () => {
    const currentTargetStat = await lstat(internals.outputPath).catch(() => undefined);
    if (internals.targetSnapshot === undefined) {
      if (currentTargetStat !== undefined) {
        fail(ctx, "BUNDLE_TARGET_EXISTS", "Output target was created concurrently after brand bundle planning.", internals.outputPath);
      }
    } else {
      if (internals.targetHandle === undefined) {
        fail(ctx, "BUNDLE_TARGET_CHANGED", "Target handle missing.");
      }
      const openedStat = await internals.targetHandle.stat();
      if (
        currentTargetStat === undefined ||
        currentTargetStat.isSymbolicLink() ||
        !currentTargetStat.isFile() ||
        openedStat.dev !== currentTargetStat.dev ||
        openedStat.ino !== currentTargetStat.ino ||
        !sameTargetSnapshot(internals.targetSnapshot, createTargetSnapshot(internals.outputPath, currentTargetStat))
      ) {
        fail(ctx, "BUNDLE_TARGET_CHANGED", "Output target was modified concurrently after brand bundle planning.", internals.outputPath);
      }
    }
  };

  const revalidateCanonical = async () => {
    const current = await snapshotCanonicalTree(internals.root);
    if (!snapshotsEqual(current, internals.canonicalSnapshot)) {
      fail(ctx, "BUNDLE_TRANSACTION_FAILED", "Canonical project changed after brand bundle planning.");
    }
  };

  try {
    await hooks?.beforeStageCreate?.();
    await revalidateParent();
    await revalidateTarget();
    await revalidateProducers();

    await hooks?.beforeStageWrite?.();
    await revalidateParent();
    await revalidateProducers();

    // Create sibling temporary stage file exclusively
    stageHandle = await open(stagePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o644);
    const stageStat = await stageHandle.stat();
    const stageLstat = await lstat(stagePath);
    if (!stageStat.isFile() || stageStat.isSymbolicLink() || !sameFileIdentity(identity(stageStat), identity(stageLstat))) {
      fail(ctx, "BUNDLE_TRANSACTION_FAILED", "Stage file creation failed identity verification.");
    }

    await writeAll(stageHandle, internals.zipBytes);
    await stageHandle.sync();

    await revalidateStage();

    await hooks?.afterStageWrite?.();

    // Revalidate canonical source snapshot
    await hooks?.beforeSourceRevalidation?.();
    await revalidateCanonical();
    await revalidateProducers();
    await revalidateParent();

    // Revalidate target before commit hook
    await hooks?.beforeTargetRevalidation?.();
    await revalidateTarget();

    // Hook: beforeCommit
    await hooks?.beforeCommit?.();

    // REVALIDATE ALL CONSEQUENCE-BEARING AUTHORITY IMMEDIATELY AFTER beforeCommit
    await revalidateParent();
    await revalidateStage();
    await revalidateCanonical();
    await revalidateProducers();
    await revalidateTarget();

    // Publication
    if (!internals.force) {
      try {
        await link(stagePath, internals.outputPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          fail(
            ctx,
            "BUNDLE_TARGET_EXISTS",
            "Output target was created concurrently after brand bundle planning.",
            internals.outputPath,
          );
        }
        throw err;
      }
      await unlink(stagePath);
      await internals.parentHandle.sync();
    } else {
      if (internals.targetSnapshot !== undefined) {
        await revalidateTarget();
        if (internals.targetHandle !== undefined) {
          await internals.targetHandle.close().catch(() => undefined);
        }
        await rename(internals.outputPath, backupPath);
        targetBackedUp = true;
        await hooks?.afterTargetBackup?.();
      }
      try {
        await link(stagePath, internals.outputPath);
      } catch (linkErr) {
        if ((linkErr as NodeJS.ErrnoException).code === "EEXIST") {
          if (targetBackedUp) {
            targetBackedUp = false;
            fail(
              ctx,
              "BUNDLE_TRANSACTION_FAILED",
              `Concurrent target appeared during publication; prior target preserved at '${basename(backupPath)}' and unowned target preserved.`,
              internals.outputPath,
            );
          }
          fail(
            ctx,
            "BUNDLE_TARGET_EXISTS",
            "Output target was created concurrently after brand bundle planning.",
            internals.outputPath,
          );
        }
        throw linkErr;
      }
      await unlink(stagePath);
      await internals.parentHandle.sync();
      await hooks?.afterPromotion?.();
      if (targetBackedUp) {
        await unlink(backupPath);
        targetBackedUp = false;
      }
    }

    await hooks?.beforeCleanup?.();

    return {
      root: internals.root,
      projectRelativeOutputPath: plan.projectRelativeOutputPath,
      entries: plan.entries,
      totalBytes: plan.totalBytes,
      assetCount: plan.assetCount,
      companionCount: plan.companionCount,
      domainCount: plan.domainCount,
      packageId: plan.packageId,
      brandVersion: plan.brandVersion,
      genericManifestByteDigest: plan.genericManifestByteDigest,
      brandPackageDigest: plan.brandPackageDigest,
      brandSystemDigest: plan.brandSystemDigest,
      brandManifestDigest: plan.brandManifestDigest,
      written: true,
      replaced: internals.replaced,
    };
  } catch (error) {
    if (targetBackedUp) {
      const currentStat = await lstat(internals.outputPath).catch(() => undefined);
      if (currentStat === undefined) {
        const restored = await rename(backupPath, internals.outputPath).then(() => true).catch(() => false);
        if (!restored) {
          fail(
            ctx,
            "BUNDLE_TRANSACTION_FAILED",
            `Transaction failed and prior target could not be restored; backup residue at '${basename(backupPath)}'.`,
          );
        }
        targetBackedUp = false;
      } else {
        fail(
          ctx,
          "BUNDLE_TRANSACTION_FAILED",
          `Transaction failed and prior target could not be restored because unowned target exists; backup residue at '${basename(backupPath)}'.`,
        );
      }
    }
    await unlink(stagePath).catch(() => undefined);
    if (error instanceof DiagnosticError) throw error;
    throw error;
  } finally {
    if (stageHandle !== undefined) {
      await stageHandle.close().catch(() => undefined);
    }
    await disposeBrandBundlePlan(plan);
  }
}

export async function bundleBrandProject(options: BrandBundleOptions): Promise<BrandBundleResult> {
  const plan = await planBrandBundle(options);
  if (options.dryRun === true) {
    await disposeBrandBundlePlan(plan);
    return {
      root: plan.root,
      projectRelativeOutputPath: plan.projectRelativeOutputPath,
      entries: plan.entries,
      totalBytes: plan.totalBytes,
      assetCount: plan.assetCount,
      companionCount: plan.companionCount,
      domainCount: plan.domainCount,
      packageId: plan.packageId,
      brandVersion: plan.brandVersion,
      genericManifestByteDigest: plan.genericManifestByteDigest,
      brandPackageDigest: plan.brandPackageDigest,
      brandSystemDigest: plan.brandSystemDigest,
      brandManifestDigest: plan.brandManifestDigest,
      written: false,
      replaced: plan.replaced,
    };
  }
  return executeBrandBundle(plan);
}
