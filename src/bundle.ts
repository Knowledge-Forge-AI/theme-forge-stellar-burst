import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { zipSync, type ZipOptions } from "fflate";

import { computeRawSha256 } from "./digests.js";
import { DiagnosticError, fail, ok, type DiagnosticContext } from "./diagnostics.js";
import {
  BUNDLE_MANIFEST_FILENAME,
  parseBundleManifest,
  serializeBundleManifest,
  unwrapBundleManifest,
  type BundleManifestGenerator,
  type BundleManifestV1,
} from "./manifest.js";
import { loadCanonicalProjectFromSnapshot, type LoadedProject } from "./project.js";
import { compareUtf8 } from "./provenance.js";
import { defaultProjectName, findProjectRoot, resolveConfinedPath, validateProjectPathLayout } from "./root.js";
import type { AnyNormalizedAsset } from "./schema-dispatch.js";
import { snapshotCanonicalTree, snapshotsEqual, type CanonicalSnapshot } from "./transaction.js";
import type { AssetId, ProjectRelativePath, Result, SvgFilename } from "./types.js";
import { TOOL_VERSION } from "./version.js";

export const BUNDLE_LIMITS = {
  totalEntries: 1_024,
  selectedSvgEntries: 128,
  selectedEntryBytes: 8 * 1024 * 1024,
  selectedAggregateBytes: 32 * 1024 * 1024,
  archiveFileBytes: 128 * 1024 * 1024,
} as const;

export interface BundleOptions {
  readonly root?: string;
  readonly output: string;
  readonly assets?: readonly string[];
  readonly companions?: readonly string[];
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly generator?: BundleManifestGenerator;
}

export interface BundleEntryDto {
  readonly type: "asset" | "companion" | "manifest";
  readonly name: string;
  readonly assetId?: string;
  readonly size: number;
  readonly sha256: string;
}

const bundlePlanBrand: unique symbol = Symbol("tfsb-bundle-plan");

export interface TargetSnapshot {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function createTargetSnapshot(path: string, stat: Stats): TargetSnapshot {
  return {
    path,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameTargetSnapshot(left: TargetSnapshot, right: TargetSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export interface BundleTransactionHooks {
  readonly afterStageWrite?: () => void | Promise<void>;
  readonly beforeSourceRevalidation?: () => void | Promise<void>;
  readonly beforeTargetRevalidation?: () => void | Promise<void>;
  readonly beforeCommit?: () => void | Promise<void>;
  readonly afterTargetBackup?: () => void | Promise<void>;
  readonly afterPromotion?: () => void | Promise<void>;
  readonly beforeCleanup?: () => void | Promise<void>;
}

interface BundlePlanInternals {
  readonly root: string;
  readonly outputPath: string;
  readonly zipBytes: Uint8Array;
  readonly canonicalSnapshot: CanonicalSnapshot;
  readonly targetSnapshot: TargetSnapshot | undefined;
  readonly force: boolean;
  readonly replaced: boolean;
}

const bundlePlanInternals = new WeakMap<BundlePlan, BundlePlanInternals>();

export interface BundlePlan {
  readonly root: string;
  readonly outputPath: string;
  readonly projectRelativeOutputPath: ProjectRelativePath;
  readonly entries: readonly BundleEntryDto[];
  readonly totalBytes: number;
  readonly assetCount: number;
  readonly companionCount: number;
  readonly replaced: boolean;
  readonly [bundlePlanBrand]: true;
}

export interface BundleResult {
  readonly root: string;
  readonly projectRelativeOutputPath: ProjectRelativePath;
  readonly entries: readonly BundleEntryDto[];
  readonly totalBytes: number;
  readonly assetCount: number;
  readonly companionCount: number;
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

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const first = result.diagnostics[0];
  if (first === undefined) throw new Error("Diagnostic result was unexpectedly empty.");
  throw new DiagnosticError(first);
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

export async function planBundle(options: BundleOptions): Promise<BundlePlan> {
  const ctx = context(options.output);

  if (typeof options.output !== "string" || options.output.trim() === "") {
    fail(ctx, "BUNDLE_OUTPUT_REQUIRED", "Bundle requires --output <project-relative.zip>.");
  }

  const root = await findProjectRoot(options.root, "bundle", options.root !== undefined);
  const resolvedOutput = await resolveConfinedPath(root, options.output, "bundle");

  const canonicalSnapshot = await snapshotCanonicalTree(root);
  const project = await loadCanonicalProjectFromSnapshot(canonicalSnapshot, "bundle");
  validateProjectPathLayout(project.project);

  const projectRelativeOutputPath = validateOutputConfinement(root, resolvedOutput, project, ctx);

  // Validate parent directory
  const parentDir = dirname(resolvedOutput);
  const parentStat = await lstat(parentDir).catch(() => undefined);
  if (parentStat === undefined || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    fail(ctx, "BUNDLE_PARENT_INVALID", "Output parent directory must exist and be a non-symlink directory.", parentDir);
  }

  // Inspect existing target
  const targetStat = await lstat(resolvedOutput).catch(() => undefined);
  let targetSnapshot: TargetSnapshot | undefined;
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
    targetSnapshot = createTargetSnapshot(resolvedOutput, targetStat);
    replaced = true;
  }

  // Selection
  const isSubset = options.assets !== undefined || options.companions !== undefined;
  const canonicalAssets = project.assets;
  const canonicalCompanions = project.companions;

  const canonicalAssetsById = new Map(canonicalAssets.map((asset) => [asset.id, asset]));

  let selectedAssets: AnyNormalizedAsset[] = [];
  let selectedCompanions = new Map<string, Uint8Array>();

  if (isSubset) {
    const rawAssetSelectors = options.assets ?? [];
    const seenAssetSelectors = new Set<string>();
    for (const selector of rawAssetSelectors) {
      if (seenAssetSelectors.has(selector)) {
        fail(ctx, "BUNDLE_DUPLICATE_SELECTOR", `Duplicate asset selector '${selector}'.`, selector);
      }
      seenAssetSelectors.add(selector);
      const asset = canonicalAssetsById.get(selector as AssetId);
      if (asset === undefined) {
        fail(ctx, "BUNDLE_UNKNOWN_ASSET", `Asset '${selector}' does not exist in canonical project.`, selector);
      }
      selectedAssets.push(asset);
    }

    const rawCompanionSelectors = options.companions ?? [];
    const seenCompanionSelectors = new Set<string>();
    for (const selector of rawCompanionSelectors) {
      if (seenCompanionSelectors.has(selector)) {
        fail(ctx, "BUNDLE_DUPLICATE_SELECTOR", `Duplicate companion selector '${selector}'.`, selector);
      }
      seenCompanionSelectors.add(selector);
      const companionBytes = canonicalCompanions.get(selector);
      if (companionBytes === undefined) {
        fail(ctx, "BUNDLE_UNKNOWN_COMPANION", `Companion '${selector}' does not exist in canonical project.`, selector);
      }
      selectedCompanions.set(selector, companionBytes);
    }

    if (selectedAssets.length === 0 && selectedCompanions.size === 0) {
      fail(ctx, "BUNDLE_SELECTION_EMPTY", "Explicit bundle selection matched zero assets and zero companions.");
    }
  } else {
    // Default: all canonical assets and all canonical companions
    selectedAssets = [...canonicalAssets];
    selectedCompanions = new Map(canonicalCompanions);
  }

  // Enforce SVG asset count ceiling
  if (selectedAssets.length > BUNDLE_LIMITS.selectedSvgEntries) {
    fail(
      ctx,
      "RESOURCE_LIMIT_EXCEEDED",
      `Bundle selects ${selectedAssets.length} SVG assets, exceeding the maximum limit of ${BUNDLE_LIMITS.selectedSvgEntries}.`,
    );
  }

  // Prepare file bytes and check collisions & limits
  const entryBytesByName = new Map<string, Uint8Array>();
  const seenPortableKeys = new Map<string, string>();
  let aggregateBytes = 0;

  const manifestFileRecords: BundleManifestV1["files"][number][] = [];
  const entriesDto: BundleEntryDto[] = [];

  for (const asset of selectedAssets) {
    const rawName = asset.filename;
    const portableKey = rawName.replace(/[A-Z]/g, (l) => l.toLowerCase());
    const prevName = seenPortableKeys.get(portableKey);
    if (prevName !== undefined) {
      fail(
        ctx,
        "BUNDLE_COLLISION",
        `Portable entry name collision between '${prevName}' and '${rawName}'.`,
        rawName,
      );
    }
    seenPortableKeys.set(portableKey, rawName);

    const svgBytes = project.outputs.get(asset.filename);
    if (svgBytes === undefined) throw new Error(`Canonical output '${asset.filename}' is missing.`);

    if (svgBytes.length > BUNDLE_LIMITS.selectedEntryBytes) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Asset '${rawName}' exceeds 8 MiB entry limit.`, rawName);
    }

    aggregateBytes += svgBytes.length;
    if (aggregateBytes > BUNDLE_LIMITS.selectedAggregateBytes) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Selected bundle entries exceed 32 MiB aggregate limit.");
    }

    const sha256 = computeRawSha256(svgBytes);
    entryBytesByName.set(rawName, svgBytes);
    manifestFileRecords.push({
      type: "asset",
      name: rawName,
      assetId: asset.id,
      sha256,
    });
    entriesDto.push({
      type: "asset",
      name: rawName,
      assetId: asset.id,
      size: svgBytes.length,
      sha256,
    });
  }

  for (const [filename, companionBytes] of selectedCompanions) {
    const portableKey = filename.replace(/[A-Z]/g, (l) => l.toLowerCase());
    const prevName = seenPortableKeys.get(portableKey);
    if (prevName !== undefined) {
      fail(
        ctx,
        "BUNDLE_COLLISION",
        `Portable entry name collision between '${prevName}' and '${filename}'.`,
        filename,
      );
    }
    seenPortableKeys.set(portableKey, filename);

    if (companionBytes.length > BUNDLE_LIMITS.selectedEntryBytes) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Companion '${filename}' exceeds 8 MiB entry limit.`, filename);
    }

    aggregateBytes += companionBytes.length;
    if (aggregateBytes > BUNDLE_LIMITS.selectedAggregateBytes) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Selected bundle entries exceed 32 MiB aggregate limit.");
    }

    const sha256 = computeRawSha256(companionBytes);
    entryBytesByName.set(filename, companionBytes);
    manifestFileRecords.push({
      type: "companion",
      name: filename,
      sha256,
    });
    entriesDto.push({
      type: "companion",
      name: filename,
      size: companionBytes.length,
      sha256,
    });
  }

  // Create Manifest
  const manifestGenerator: BundleManifestGenerator = options.generator ?? {
    name: "@knowledge-forge-ai/theme-forge-stellar-burst",
    version: TOOL_VERSION,
  };

  const manifestData: BundleManifestV1 = {
    kind: "tfsb-bundle-manifest",
    schemaVersion: 1,
    generator: manifestGenerator,
    projectName: project.project.name,
    files: manifestFileRecords,
  };

  const serializedManifest = serializeBundleManifest(manifestData);
  unwrapBundleManifest(parseBundleManifest(serializedManifest));
  const manifestBytes = Buffer.from(serializedManifest, "utf8");

  if (manifestBytes.length > BUNDLE_LIMITS.selectedEntryBytes) {
    fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Manifest exceeds 8 MiB limit.");
  }

  const manifestSha256 = computeRawSha256(manifestBytes);
  entryBytesByName.set(BUNDLE_MANIFEST_FILENAME, manifestBytes);
  entriesDto.push({
    type: "manifest",
    name: BUNDLE_MANIFEST_FILENAME,
    size: manifestBytes.length,
    sha256: manifestSha256,
  });

  const totalEntriesCount = entryBytesByName.size;
  if (totalEntriesCount > BUNDLE_LIMITS.totalEntries) {
    fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Total ZIP entries (${totalEntriesCount}) exceeds 1,024 limit.`);
  }

  // Sort entry names ascending by UTF-8 bytes
  const sortedNames = [...entryBytesByName.keys()].sort(compareUtf8);
  entriesDto.sort((left, right) => compareUtf8(left.name, right.name));

  // Build Store-Only Deterministic ZIP
  const zipData: Record<string, [Uint8Array, ZipOptions]> = {};
  for (const name of sortedNames) {
    zipData[name] = [
      entryBytesByName.get(name)!,
      {
        level: 0,
        mtime: new Date(1980, 0, 1, 0, 0, 0, 0),
        os: 3,
        attrs: (0o100644 << 16) | 0x20,
      },
    ];
  }

  const zipBytes = zipSync(zipData);
  if (zipBytes.length > BUNDLE_LIMITS.archiveFileBytes) {
    fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Planned ZIP archive exceeds 128 MiB limit.");
  }
  const currentCanonicalSnapshot = await snapshotCanonicalTree(root, false, "bundle");
  if (!snapshotsEqual(canonicalSnapshot, currentCanonicalSnapshot)) {
    fail(ctx, "CANONICAL_CHANGED_DURING_PLAN", "Canonical tree changed during bundle planning.", ".tfsb");
  }

  const plan: BundlePlan = {
    root,
    outputPath: resolvedOutput,
    projectRelativeOutputPath,
    entries: Object.freeze(entriesDto),
    totalBytes: zipBytes.length,
    assetCount: selectedAssets.length,
    companionCount: selectedCompanions.size,
    replaced,
    [bundlePlanBrand]: true,
  };

  bundlePlanInternals.set(plan, {
    root,
    outputPath: resolvedOutput,
    zipBytes,
    canonicalSnapshot,
    targetSnapshot,
    force: options.force === true,
    replaced,
  });

  return Object.freeze(plan);
}

export async function executeBundle(
  plan: BundlePlan,
  hooks?: BundleTransactionHooks,
): Promise<BundleResult> {
  const internals = bundlePlanInternals.get(plan);
  if (internals === undefined) {
    fail(context(plan.outputPath), "BUNDLE_UNAUTHORIZED_PLAN", "Bundle plan is not authorized for execution.");
  }

  const ctx = context(internals.outputPath);
  const stagePath = `${internals.outputPath}.stage-${randomUUID()}`;
  const backupPath = `${internals.outputPath}.backup-${randomUUID()}`;
  let targetBackedUp = false;

  try {
    // 1. Create sibling temporary stage file exclusively & write zipBytes
    await writeFile(stagePath, internals.zipBytes, { flag: "wx", mode: 0o644 });

    const handle = await open(stagePath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    await hooks?.afterStageWrite?.();

    // 2. Revalidate canonical source snapshot
    await hooks?.beforeSourceRevalidation?.();
    const currentCanonicalSnapshot = await snapshotCanonicalTree(internals.root);
    if (!snapshotsEqual(currentCanonicalSnapshot, internals.canonicalSnapshot)) {
      fail(ctx, "BUNDLE_TRANSACTION_FAILED", "Canonical project changed after bundle planning.");
    }

    // 3. Revalidate output path confinement and expected absent/target snapshot
    await hooks?.beforeTargetRevalidation?.();
    const currentTargetStat = await lstat(internals.outputPath).catch(() => undefined);

    if (internals.targetSnapshot === undefined) {
      if (currentTargetStat !== undefined) {
        fail(
          ctx,
          "BUNDLE_TARGET_EXISTS",
          "Output target was created concurrently after bundle planning.",
          internals.outputPath,
        );
      }
    } else {
      if (currentTargetStat === undefined || !sameTargetSnapshot(internals.targetSnapshot, createTargetSnapshot(internals.outputPath, currentTargetStat))) {
        fail(
          ctx,
          "BUNDLE_TARGET_CHANGED",
          "Output target was modified concurrently after bundle planning.",
          internals.outputPath,
        );
      }
    }

    // 4. Commit publication
    await hooks?.beforeCommit?.();
    if (!internals.force) {
      // Atomic publication of absent file via link
      try {
        await link(stagePath, internals.outputPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          fail(
            ctx,
            "BUNDLE_TARGET_EXISTS",
            "Output target was created concurrently after bundle planning.",
            internals.outputPath,
          );
        }
        throw err;
      }
      await unlink(stagePath);
    } else {
      // Force replacement of existing file
      if (internals.targetSnapshot !== undefined) {
        await rename(internals.outputPath, backupPath);
        targetBackedUp = true;
        await hooks?.afterTargetBackup?.();
      }
      await rename(stagePath, internals.outputPath);
      await hooks?.afterPromotion?.();
      if (targetBackedUp) {
        await unlink(backupPath);
        targetBackedUp = false;
      }
    }

    // 5. Parent directory fsync
    const parentHandle = await open(dirname(internals.outputPath), "r").catch(() => undefined);
    if (parentHandle !== undefined) {
      try {
        await parentHandle.sync().catch(() => undefined);
      } finally {
        await parentHandle.close();
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
      written: true,
      replaced: internals.replaced,
    };
  } catch (error) {
    if (targetBackedUp) {
      // Attempt restoration of prior target
      const restored = await rename(backupPath, internals.outputPath).then(() => true).catch(() => false);
      if (!restored) {
        // Report rollback failure residue
        fail(
          ctx,
          "BUNDLE_TRANSACTION_FAILED",
          `Transaction failed and prior target could not be restored; backup residue at '${basename(backupPath)}'.`,
        );
      }
    }
    await unlink(stagePath).catch(() => undefined);
    if (error instanceof DiagnosticError) throw error;
    throw error;
  }
}

export async function bundleProject(options: BundleOptions): Promise<BundleResult> {
  const plan = await planBundle(options);
  if (options.dryRun === true) {
    return {
      root: plan.root,
      projectRelativeOutputPath: plan.projectRelativeOutputPath,
      entries: plan.entries,
      totalBytes: plan.totalBytes,
      assetCount: plan.assetCount,
      companionCount: plan.companionCount,
      written: false,
      replaced: plan.replaced,
    };
  }
  return executeBundle(plan);
}
