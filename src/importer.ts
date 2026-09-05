import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { isAllowedCompanionFilename, readArchive, readManifestArchive, type ArchiveReadHooks, type SelectedArchiveCompanion } from "./archive.js";
import { scanAnalyzeSvg } from "./analyze-scanner.js";
import { ASSET_DIGEST_BASIS_V2, computeAssetSemanticDigest, computeCompanionByteDigest, computeSha256 } from "./digests.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import { readRegularFileSnapshot, sameFileIdentity, type PresentFileSnapshot } from "./filesystem.js";
import {
  DIRECTORY_FILE_BYTES_BASIS,
  DIRECTORY_SNAPSHOT_BASIS,
  closeDirectorySnapshot,
  computeDirectorySnapshotDigest,
  copyDirectorySnapshotFileBytes,
  createDirectorySnapshot,
  getDirectorySnapshotCapability,
  inspectDirectorySnapshotRetention,
  readDirectorySnapshotAuthorityFile,
  revalidateDirectorySnapshot,
  type AuthenticatedDirectorySnapshot,
} from "./directory-snapshot.js";
import { normalizeCommonSvg } from "./normalizer.js";
import { parseNormalizationMap, unwrapNormalizationMap, type NormalizationMapV1 } from "./normalization-map.js";
import type { NormalizationLedgerV1 } from "./normalization-ledger.js";
import { createNormalizationPolicyIdentity, type NormalizationPolicyIdentityV1 } from "./normalization-policy.js";
import { inspectPlanRetention, mergePlanRetention, type PlanRetentionInspection } from "./plan-retention.js";
import { parseImportProvenance, serializeImportProvenance, unwrapProvenance, type ImportProvenanceV1 } from "./provenance.js";
import { ARCHIVE_DIGEST_BASIS, ARCHIVE_SOURCE_DIGEST_BASIS, COMPANION_DIGEST_BASIS, parseImportProvenanceV2, serializeImportProvenanceV2, unwrapProvenanceV2, type ImportProvenanceV2 } from "./provenance2.js";
import { parseImportProvenanceV3, serializeImportProvenanceV3, unwrapProvenanceV3, type ImportProvenanceV3 } from "./provenance3.js";
import { defaultProjectName, resolveImportRoot } from "./root.js";
import { enforceMutationAssetLimit } from "./project.js";
import {
  parseAssetTomlVersioned,
  parseProjectTomlVersioned,
  serializeAssetTomlVersioned,
  serializeProjectTomlVersioned,
  type AnyNormalizedAsset,
  type AnyNormalizedProject,
  type SupportedSchemaVersion,
} from "./schema-dispatch.js";
import { parseSvgV2, serializeSvgV2 } from "./schema2-svg.js";
import type { NormalizedAssetV2, NormalizedProjectV2 } from "./schema2-types.js";
import { parseAssetToml, parseProjectToml } from "./toml.js";
import { serializeAssetToml, serializeProjectToml } from "./toml-writer.js";
import { parseSvg } from "./svg.js";
import {
  executeCanonicalTransaction,
  snapshotCanonicalTree,
  type CanonicalSnapshot,
  type TransactionHooks,
} from "./transaction.js";
import type {
  AssetId,
  NormalizedAsset,
  NormalizedProject,
  ProjectRelativePath,
  Result,
  SvgFilename,
} from "./types.js";
import { TOOL_VERSION } from "./version.js";
import { SOURCE_MAP_DIGEST_BASIS, SOURCE_MAP_FILENAME, computeSourceMapDigest, parseSourceMap, type SourceMapCollectionV1, type SourceMapV1 } from "./source-map.js";
import { validatePortablePathValue } from "./source-identity.js";
import { SHARD_MANIFEST_MAX_BYTES, parseShardManifest, type ShardManifestV1 } from "./shard.js";

export type ImportSource =
  | { readonly kind: "archive"; readonly path: string }
  | { readonly kind: "directory"; readonly path: string };

type ArchiveImportOptions = ImportOptions & { readonly archive: string };

export interface SelectedDirectoryCompanion {
  readonly entryName: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly collectionId: string;
  readonly sourcePath: string;
}

export interface ImportOptions {
  readonly source?: ImportSource;
  readonly archive?: string;
  readonly root?: string;
  readonly sourceMap?: string;
  readonly collections?: readonly string[];
  readonly selections?: readonly string[];
  readonly companions?: readonly string[];
  readonly dryRun?: boolean;
  readonly recordProvenance?: boolean;
  readonly manifest?: boolean;
  readonly schema?: SupportedSchemaVersion;
  readonly normalize?: "exact-common";
  readonly normalizationMap?: string;
  readonly shardManifest?: string;
}

export interface ImportPlan {
  readonly root: string;
  readonly sourceKind: "archive" | "directory";
  readonly archive?: string;
  readonly project: AnyNormalizedProject;
  readonly assets: readonly AnyNormalizedAsset[];
  readonly companions: readonly (SelectedArchiveCompanion | SelectedDirectoryCompanion)[];
  readonly files: ReadonlyMap<string, string | Uint8Array>;
  readonly normalizationLedger?: NormalizationLedgerV1;
  readonly normalizationPolicy?: NormalizationPolicyIdentityV1;
  readonly provenanceSchemaVersion?: 3;
  readonly sourceMapDigest?: ReturnType<typeof computeSourceMapDigest>;
  readonly snapshotDigest?: ReturnType<typeof computeSourceMapDigest>;
  readonly collections?: readonly string[];
  readonly sourceMapDescription?: string;
}

interface ArchiveImportTransactionInternals {
  readonly kind: "archive";
  readonly canonicalSnapshot: CanonicalSnapshot;
  readonly archiveSnapshot: import("./archive.js").ArchiveSnapshot;
  readonly normalizationMap?: { readonly path: string; readonly snapshot: PresentFileSnapshot };
}

interface DirectoryImportTransactionInternals {
  readonly kind: "directory";
  readonly canonicalSnapshot: CanonicalSnapshot;
  readonly snapshot: AuthenticatedDirectorySnapshot;
  readonly sourceMap: SourceMapV1;
  readonly sourceMapAuthority: { readonly kind: "canonical"; readonly sourcePath: typeof SOURCE_MAP_FILENAME } | { readonly kind: "external"; readonly path: string; readonly snapshot: PresentFileSnapshot };
  readonly normalizationMap?: { readonly path: string; readonly snapshot: PresentFileSnapshot };
  readonly shardManifest?: { readonly path: string; readonly snapshot: PresentFileSnapshot };
  readonly nextFiles: ReadonlyMap<string, Uint8Array>;
  disposed: boolean;
}

type ProvenanceImportTransactionInternals = ArchiveImportTransactionInternals | DirectoryImportTransactionInternals;

const provenanceImportInternals = new WeakMap<ImportPlan, ProvenanceImportTransactionInternals>();

export interface ImportPlanningHooks {
  readonly afterRootValidation?: () => void | Promise<void>;
  readonly checkCancelled?: () => void | Promise<void>;
  readonly archiveHooks?: ArchiveReadHooks;
}

function context(source?: string): DiagnosticContext {
  return { operation: "import", domain: "project", ...(source === undefined ? {} : { source }) };
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const first = result.diagnostics[0];
  if (first === undefined) throw new Error("Diagnostic result was unexpectedly empty.");
  throw new DiagnosticError(first);
}

export function deriveAssetIdentity(entryName: string, ctx: DiagnosticContext): { id: AssetId; filename: SvgFilename } {
  const leaf = basename(entryName);
  const rawStem = leaf.slice(0, -4).normalize("NFC");
  const id = rawStem.toLowerCase().replace(/[ _]+/g, "-");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    fail(
      ctx,
      "ARCHIVE_INVALID_ASSET_ID",
      `Entry '${entryName}' cannot be deterministically mapped to a lowercase kebab-case asset id.`,
      entryName,
    );
  }
  return { id: id as AssetId, filename: `${id}.svg` as SvgFilename };
}

async function planVersionedImport(
  options: ArchiveImportOptions,
  hooks: ImportPlanningHooks,
  root: string,
  canonicalSnapshot: CanonicalSnapshot,
  schemaVersion: SupportedSchemaVersion,
): Promise<ImportPlan> {
  const ctx = context(options.archive);
  if (options.normalize !== undefined && (schemaVersion !== 2 || options.normalize !== "exact-common")) fail(ctx, "NORMALIZATION_POLICY_UNSUPPORTED", "exact-common normalization is available only for schema-2 import.");
  if (options.normalizationMap !== undefined && options.normalize !== "exact-common") fail(ctx, "NORMALIZATION_POLICY_REQUIRED", "A normalization map requires exact-common normalization.");
  let normalizationMap: NormalizationMapV1 | undefined;
  let normalizationMapSnapshot: { readonly path: string; readonly snapshot: PresentFileSnapshot } | undefined;
  if (options.normalizationMap !== undefined) {
    const mapPath = resolve(options.normalizationMap);
    const read = await readRegularFileSnapshot(mapPath, ctx, "NORMALIZATION_MAP_UNSAFE", "Normalization map must be a stable regular non-symlink file.", 1024 * 1024);
    let mapText: string;
    try { mapText = new TextDecoder("utf8", { fatal: true }).decode(read.bytes); }
    catch { fail(ctx, "NORMALIZATION_MAP_INVALID_UTF8", "Normalization map must be valid UTF-8."); }
    normalizationMap = unwrapNormalizationMap(parseNormalizationMap(mapText));
    normalizationMapSnapshot = { path: mapPath, snapshot: read.snapshot };
  }
  const normalizationPolicy = options.normalize === "exact-common" ? createNormalizationPolicyIdentity(normalizationMap) : undefined;

  const manifest = options.manifest === true
    ? await readManifestArchive(options.archive, options.selections ?? [], options.companions ?? [], hooks.archiveHooks === undefined ? {} : { hooks: hooks.archiveHooks })
    : undefined;
  const ordinary = manifest === undefined
    ? await readArchive(options.archive, options.selections ?? [], options.companions ?? [], hooks.archiveHooks === undefined ? {} : { hooks: hooks.archiveHooks })
    : undefined;
  const svgEntries = manifest?.svgs ?? ordinary!.svgs;
  const companionEntries = manifest?.companions ?? ordinary!.companions;
  const ids = new Map<string, string>();
  const filenames = new Map<string, string>();
  const assets: AnyNormalizedAsset[] = [];
  const ledgers: NormalizationLedgerV1["entries"][number][] = [];
  const sourcesById = new Map<string, { readonly entryName: string; readonly bytes: Uint8Array; readonly normalized: boolean }>();

  for (const entry of svgEntries) {
    await hooks.checkCancelled?.();
    const identity = "assetId" in entry
      ? { id: entry.assetId as AssetId, filename: entry.entryName as SvgFilename }
      : deriveAssetIdentity(entry.entryName, ctx);
    const previousId = ids.get(identity.id);
    const previousFilename = filenames.get(identity.filename);
    if (previousId !== undefined || previousFilename !== undefined) {
      fail(ctx, "ARCHIVE_COLLISION", `Entry '${entry.entryName}' collides with existing asset '${previousId ?? previousFilename}'.`, entry.entryName);
    }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes); }
    catch { fail(ctx, "ARCHIVE_INVALID_UTF8", `Selected SVG '${entry.entryName}' is not valid UTF-8.`, entry.entryName); }
    let asset: AnyNormalizedAsset;
    if (schemaVersion === 1) {
      asset = { schemaVersion: 1, ...identity, svg: unwrap(parseSvg(text, entry.entryName)) };
    } else {
      const parsed = parseSvgV2(text, entry.entryName);
      const canonicalSvg = parsed.ok ? unwrap(serializeSvgV2(parsed.value, entry.entryName)) : undefined;
      if (parsed.ok && canonicalSvg === text) {
        asset = { schemaVersion: 2, ...identity, svg: parsed.value };
        if (normalizationPolicy !== undefined) {
          const analysis = scanAnalyzeSvg(entry.bytes, entry.entryName, identity.id).file;
          const digest = computeAssetSemanticDigest(asset);
          ledgers.push({ source: entry.entryName, sourceDigest: computeSha256(entry.bytes), schema1Classification: analysis.profiles.schema1.classification, commonV03Classification: analysis.profiles.commonV03.classification, consumedAccessibilityAuthority: null, operations: [], beforeSemanticDigest: digest, afterCanonicalDigest: digest, policyDigest: normalizationPolicy.policyDigest, disposition: "direct" });
        }
        sourcesById.set(identity.id, { entryName: entry.entryName, bytes: entry.bytes, normalized: false });
      } else {
        if (normalizationPolicy === undefined) fail(ctx, "IMPORT_NORMALIZATION_REQUIRED", `Schema-2 source '${entry.entryName}' is not already canonical and requires --normalize exact-common.`, entry.entryName);
        const normalized = normalizeCommonSvg({ bytes: entry.bytes, source: entry.entryName, assetId: identity.id, filename: identity.filename, ...(normalizationMap === undefined ? {} : { map: normalizationMap }), policy: normalizationPolicy });
        asset = normalized.asset;
        ledgers.push(normalized.ledger);
        sourcesById.set(identity.id, { entryName: entry.entryName, bytes: entry.bytes, normalized: true });
      }
    }
    ids.set(asset.id, entry.entryName);
    filenames.set(asset.filename, asset.id);
    assets.push(asset);
  }
  assets.sort((left, right) => left.id.localeCompare(right.id, "en"));
  await hooks.checkCancelled?.();
  enforceMutationAssetLimit(assets.length, "import");

  const project: AnyNormalizedProject = schemaVersion === 1
    ? { schemaVersion: 1, name: manifest?.manifest.projectName ?? defaultProjectName(root), buildDirectory: "brand/dist" as ProjectRelativePath, installs: [], companions: [] }
    : { schemaVersion: 2, name: manifest?.manifest.projectName ?? defaultProjectName(root), buildDirectory: "brand/dist" as ProjectRelativePath, installs: [], companions: [] } satisfies NormalizedProjectV2;
  const files = new Map<string, string | Uint8Array>(
    [...canonicalSnapshot.files].map(([path, file]) => [path, file.bytes]),
  );
  if (!canonicalSnapshot.canonicalPresent) {
    const projectToml = serializeProjectTomlVersioned(project);
    const reparsed = unwrap(parseProjectTomlVersioned(projectToml, ".tfsb/project.toml"));
    if (!isDeepStrictEqual(reparsed, project)) throw new Error("Generated project TOML failed its invariant round-trip.");
    files.set(".tfsb/project.toml", projectToml);
  }
  for (const asset of assets) {
    const path = `.tfsb/assets/${asset.id}.toml`;
    const toml = serializeAssetTomlVersioned(asset);
    const reparsed = unwrap(parseAssetTomlVersioned(toml, schemaVersion, path));
    if (!isDeepStrictEqual(reparsed, asset)) throw new Error(`Generated asset TOML failed its invariant round-trip for '${asset.id}'.`);
    files.set(path, toml);
  }
  for (const companion of companionEntries) {
    await hooks.checkCancelled?.();
    const path = `.tfsb/companions/${companion.filename}`;
    if (files.has(path)) fail(ctx, "ARCHIVE_COLLISION", `Companion '${companion.filename}' already exists.`, companion.entryName);
    files.set(path, companion.bytes);
  }
  if (schemaVersion === 2 && (options.recordProvenance === true || ledgers.some((ledger) => ledger.disposition === "normalized"))) {
    const archiveResult = manifest ?? ordinary!;
    const records: ImportProvenanceV2["records"] = [
      ...assets.map((asset) => {
        if (asset.schemaVersion !== 2) throw new Error("Schema-2 provenance cannot record a schema-1 asset.");
        const source = sourcesById.get(asset.id);
        if (source === undefined) throw new Error("Archive source and normalized asset identity diverged.");
        const canonicalDigest = computeAssetSemanticDigest(asset);
        return { type: "asset" as const, assetId: asset.id, canonicalPath: `.tfsb/assets/${asset.id}.toml`, archive: { archiveDigestBasis: ARCHIVE_DIGEST_BASIS, archiveDigest: archiveResult.archiveDigest, entryName: source.entryName, sourceBasis: ARCHIVE_SOURCE_DIGEST_BASIS, sourceDigest: computeSha256(source.bytes), archiveCanonicalBasis: ASSET_DIGEST_BASIS_V2, archiveCanonicalDigest: canonicalDigest, canonicalBasis: ASSET_DIGEST_BASIS_V2, canonicalState: "present" as const, canonicalDigest, resolution: "aligned" as const, toolVersion: TOOL_VERSION }, migration: null, normalizationPolicy: source.normalized ? normalizationPolicy! : null };
      }),
      ...companionEntries.map((companion) => { const byteDigest = computeCompanionByteDigest(companion.bytes); return { type: "companion" as const, canonicalPath: `.tfsb/companions/${companion.filename}`, archive: { archiveDigestBasis: ARCHIVE_DIGEST_BASIS, archiveDigest: archiveResult.archiveDigest, entryName: companion.entryName, sourceBasis: ARCHIVE_SOURCE_DIGEST_BASIS, sourceDigest: byteDigest, archiveCanonicalBasis: COMPANION_DIGEST_BASIS, archiveCanonicalDigest: byteDigest, canonicalBasis: COMPANION_DIGEST_BASIS, canonicalState: "present" as const, canonicalDigest: byteDigest, resolution: "aligned" as const, toolVersion: TOOL_VERSION } }; }),
    ];
    files.set(".tfsb/provenance.json", serializeImportProvenanceV2({ kind: "tfsb-import-provenance", schemaVersion: 2, records }));
  }
  await hooks.checkCancelled?.();
  const plan: ImportPlan = { root, sourceKind: "archive", archive: options.archive, project, assets, companions: companionEntries, files, ...(normalizationPolicy === undefined ? {} : { normalizationPolicy, normalizationLedger: { schemaVersion: 1, entries: ledgers.sort((left, right) => Buffer.compare(Buffer.from(left.source), Buffer.from(right.source))) } }) };
  provenanceImportInternals.set(plan, { kind: "archive", canonicalSnapshot, archiveSnapshot: (manifest ?? ordinary!).snapshot, ...(normalizationMapSnapshot === undefined ? {} : { normalizationMap: normalizationMapSnapshot }) });
  return plan;
}

async function planArchiveImportInternal(options: ArchiveImportOptions, hooks: ImportPlanningHooks): Promise<ImportPlan> {
  await hooks.checkCancelled?.();
  const root = await resolveImportRoot(options.root);
  const schemaVersion = options.schema ?? 2;
  if (schemaVersion === 2 || options.recordProvenance !== true) {
    await hooks.afterRootValidation?.();
    const snapshot = await snapshotCanonicalTree(root, true, "import");
    if (snapshot.canonicalPresent) {
      fail(context(), "ROOT_ALREADY_INITIALIZED", "Import refuses an existing .tfsb directory.", ".tfsb");
    }
    return planVersionedImport(options, hooks, root, snapshot, schemaVersion);
  }
  let canonicalSnapshot: CanonicalSnapshot | undefined;
  if (options.recordProvenance === true) {
    await hooks.afterRootValidation?.();
    canonicalSnapshot = await snapshotCanonicalTree(root, true, "import");
    if (canonicalSnapshot.canonicalPresent) {
      fail(context(), "ROOT_ALREADY_INITIALIZED", "Import refuses an existing .tfsb directory.", ".tfsb");
    }
  }
  const ctx = context(options.archive);

  if (options.manifest === true) {
    const archiveResult = await readManifestArchive(
      options.archive,
      options.selections ?? [],
      options.companions ?? [],
      hooks.archiveHooks === undefined ? {} : { hooks: hooks.archiveHooks },
    );
    const ids = new Map<string, string>();
    const filenames = new Map<string, string>();
    const assets: NormalizedAsset[] = [];
    for (const entry of archiveResult.svgs) {
      await hooks.checkCancelled?.();
      const id = entry.assetId;
      const filename = entry.entryName as SvgFilename;
      const previousId = ids.get(id);
      const previousFilename = filenames.get(filename);
      if (previousId !== undefined || previousFilename !== undefined) {
        fail(
          ctx,
          "ARCHIVE_COLLISION",
          `Entries '${previousId ?? previousFilename}' and '${entry.entryName}' derive the same asset id or filename.`,
          entry.entryName,
        );
      }
      ids.set(id, entry.entryName);
      filenames.set(filename, entry.entryName);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes);
      } catch {
        fail(ctx, "ARCHIVE_INVALID_UTF8", `Selected SVG '${entry.entryName}' is not valid UTF-8.`, entry.entryName);
      }
      assets.push({
        schemaVersion: 1,
        id,
        filename,
        svg: unwrap(parseSvg(text, entry.entryName)),
      });
    }
    assets.sort((left, right) => left.id.localeCompare(right.id, "en"));
    await hooks.checkCancelled?.();
    const project: NormalizedProject = {
      schemaVersion: 1,
      name: archiveResult.manifest.projectName ?? defaultProjectName(root),
      buildDirectory: "brand/dist" as ProjectRelativePath,
      installs: [],
      companions: [],
    };
    const files = new Map<string, string | Uint8Array>();
    const projectToml = serializeProjectToml(project);
    const reparsedProject = unwrap(parseProjectToml(projectToml, ".tfsb/project.toml"));
    if (!isDeepStrictEqual(reparsedProject, project)) throw new Error("Generated project TOML failed its invariant round-trip.");
    files.set(".tfsb/project.toml", projectToml);
    for (const asset of assets) {
      await hooks.checkCancelled?.();
      const relative = `.tfsb/assets/${asset.id}.toml`;
      const toml = serializeAssetToml(asset);
      const reparsed = unwrap(parseAssetToml(toml, relative));
      if (!isDeepStrictEqual(reparsed, asset)) throw new Error(`Generated asset TOML failed its invariant round-trip for '${asset.id}'.`);
      files.set(relative, toml);
    }
    for (const companion of archiveResult.companions) {
      await hooks.checkCancelled?.();
      const relative = `.tfsb/companions/${companion.filename}`;
      files.set(relative, companion.bytes);
    }
    if (options.recordProvenance === true) {
      const records: ImportProvenanceV1["records"] = [
        ...assets.map((asset) => {
          const entry = archiveResult.svgs.find((candidate) => candidate.assetId === asset.id);
          if (entry === undefined) throw new Error("Archive and parsed asset identities diverged.");
          const modelDigest = computeAssetSemanticDigest(asset);
          return {
            type: "asset" as const,
            assetId: asset.id,
            canonicalPath: `.tfsb/assets/${asset.id}.toml`,
            archiveDigest: archiveResult.archiveDigest,
            entryName: entry.entryName,
            entryDigest: computeSha256(entry.bytes),
            digestBasis: "tfsb-asset-toml-v1" as const,
            archiveModelDigest: modelDigest,
            canonicalState: "present" as const,
            canonicalModelDigest: modelDigest,
            resolution: "aligned" as const,
            toolVersion: TOOL_VERSION,
          };
        }),
        ...archiveResult.companions.map((companion) => {
          const byteDigest = computeCompanionByteDigest(companion.bytes);
          return {
            type: "companion" as const,
            canonicalPath: `.tfsb/companions/${companion.filename}`,
            archiveDigest: archiveResult.archiveDigest,
            entryName: companion.entryName,
            entryDigest: byteDigest,
            archiveByteDigest: byteDigest,
            canonicalState: "present" as const,
            canonicalByteDigest: byteDigest,
            resolution: "aligned" as const,
            toolVersion: TOOL_VERSION,
          };
        }),
      ];
      const provenance = serializeImportProvenance({ kind: "tfsb-import-provenance", schemaVersion: 1, records });
      unwrapProvenance(parseImportProvenance(provenance, ".tfsb/provenance.json"));
      files.set(".tfsb/provenance.json", provenance);
    }
    await hooks.checkCancelled?.();
    const plan: ImportPlan = { root, sourceKind: "archive", archive: options.archive, project, assets, companions: archiveResult.companions, files };
    if (canonicalSnapshot !== undefined) {
      provenanceImportInternals.set(plan, { kind: "archive", canonicalSnapshot, archiveSnapshot: archiveResult.snapshot });
    }
    return plan;
  }

  const archiveResult = await readArchive(
    options.archive,
    options.selections ?? [],
    options.companions ?? [],
    hooks.archiveHooks === undefined ? {} : { hooks: hooks.archiveHooks },
  );
  const ids = new Map<string, string>();
  const filenames = new Map<string, string>();
  const assets: NormalizedAsset[] = [];
  for (const entry of archiveResult.svgs) {
    await hooks.checkCancelled?.();
    const identity = deriveAssetIdentity(entry.entryName, ctx);
    const previousId = ids.get(identity.id);
    const previousFilename = filenames.get(identity.filename);
    if (previousId !== undefined || previousFilename !== undefined) {
      fail(
        ctx,
        "ARCHIVE_COLLISION",
        `Entries '${previousId ?? previousFilename}' and '${entry.entryName}' derive the same asset id or filename.`,
        entry.entryName,
      );
    }
    ids.set(identity.id, entry.entryName);
    filenames.set(identity.filename, entry.entryName);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes);
    } catch {
      fail(ctx, "ARCHIVE_INVALID_UTF8", `Selected SVG '${entry.entryName}' is not valid UTF-8.`, entry.entryName);
    }
    assets.push({
      schemaVersion: 1,
      ...identity,
      svg: unwrap(parseSvg(text, entry.entryName)),
    });
  }
  assets.sort((left, right) => left.id.localeCompare(right.id, "en"));
  await hooks.checkCancelled?.();
  const project: NormalizedProject = {
    schemaVersion: 1,
    name: defaultProjectName(root),
    buildDirectory: "brand/dist" as ProjectRelativePath,
    installs: [],
    companions: [],
  };
  const files = new Map<string, string | Uint8Array>();
  const projectToml = serializeProjectToml(project);
  const reparsedProject = unwrap(parseProjectToml(projectToml, ".tfsb/project.toml"));
  if (!isDeepStrictEqual(reparsedProject, project)) throw new Error("Generated project TOML failed its invariant round-trip.");
  files.set(".tfsb/project.toml", projectToml);
  for (const asset of assets) {
    await hooks.checkCancelled?.();
    const relative = `.tfsb/assets/${asset.id}.toml`;
    const toml = serializeAssetToml(asset);
    const reparsed = unwrap(parseAssetToml(toml, relative));
    if (!isDeepStrictEqual(reparsed, asset)) throw new Error(`Generated asset TOML failed its invariant round-trip for '${asset.id}'.`);
    files.set(relative, toml);
  }
  for (const companion of archiveResult.companions) {
    await hooks.checkCancelled?.();
    const relative = `.tfsb/companions/${companion.filename}`;
    files.set(relative, companion.bytes);
  }
  await hooks.checkCancelled?.();
  if (options.recordProvenance === true) {
    const records: ImportProvenanceV1["records"] = [
      ...assets.map((asset) => {
        const entry = archiveResult.svgs.find((candidate) => deriveAssetIdentity(candidate.entryName, ctx).id === asset.id);
        if (entry === undefined) throw new Error("Archive and parsed asset identities diverged.");
        const modelDigest = computeAssetSemanticDigest(asset);
        return {
          type: "asset" as const,
          assetId: asset.id,
          canonicalPath: `.tfsb/assets/${asset.id}.toml`,
          archiveDigest: archiveResult.archiveDigest,
          entryName: entry.entryName,
          entryDigest: computeSha256(entry.bytes),
          digestBasis: "tfsb-asset-toml-v1" as const,
          archiveModelDigest: modelDigest,
          canonicalState: "present" as const,
          canonicalModelDigest: modelDigest,
          resolution: "aligned" as const,
          toolVersion: TOOL_VERSION,
        };
      }),
      ...archiveResult.companions.map((companion) => {
        const byteDigest = computeCompanionByteDigest(companion.bytes);
        return {
          type: "companion" as const,
          canonicalPath: `.tfsb/companions/${companion.filename}`,
          archiveDigest: archiveResult.archiveDigest,
          entryName: companion.entryName,
          entryDigest: byteDigest,
          archiveByteDigest: byteDigest,
          canonicalState: "present" as const,
          canonicalByteDigest: byteDigest,
          resolution: "aligned" as const,
          toolVersion: TOOL_VERSION,
        };
      }),
    ];
    const provenance = serializeImportProvenance({ kind: "tfsb-import-provenance", schemaVersion: 1, records });
    unwrapProvenance(parseImportProvenance(provenance, ".tfsb/provenance.json"));
    files.set(".tfsb/provenance.json", provenance);
  }
  await hooks.checkCancelled?.();
  const plan: ImportPlan = { root, sourceKind: "archive", archive: options.archive, project, assets, companions: archiveResult.companions, files };
  if (canonicalSnapshot !== undefined) {
    provenanceImportInternals.set(plan, { kind: "archive", canonicalSnapshot, archiveSnapshot: archiveResult.snapshot });
  }
  return plan;
}

function resolveLogicalSource(options: ImportOptions): ImportSource {
  if (options.source !== undefined && options.archive !== undefined) {
    if (options.source.kind !== "archive" || resolve(options.source.path) !== resolve(options.archive)) {
      fail(context(), "IMPORT_SOURCE_CONFLICT", "Import accepts exactly one logical archive or directory source.");
    }
    return options.source;
  }
  if (options.source !== undefined) return options.source;
  if (options.archive !== undefined) return { kind: "archive", path: options.archive };
  fail(context(), "IMPORT_SOURCE_REQUIRED", "Import requires an archive or directory source.");
}

function decodeUtf8(bytes: Uint8Array, code: string, message: string, location?: string): string {
  try { return new TextDecoder("utf8", { fatal: true }).decode(bytes); }
  catch { fail(context(), code, message, location); }
}

async function loadDirectorySourceMap(sourceRoot: string, requestedPath: string | undefined): Promise<{
  readonly map: SourceMapV1;
  readonly path: string;
  readonly canonical: boolean;
  readonly snapshot: PresentFileSnapshot;
}> {
  const canonicalPath = join(sourceRoot, SOURCE_MAP_FILENAME);
  const path = requestedPath === undefined ? canonicalPath : resolve(requestedPath);
  try { await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(context(), "SOURCE_MAP_REQUIRED", "Directory import requires source-map schema 1.", SOURCE_MAP_FILENAME);
    throw error;
  }
  let read: Awaited<ReturnType<typeof readRegularFileSnapshot>>;
  try {
    read = await readRegularFileSnapshot(path, context(), "SOURCE_MAP_UNSAFE", "Source map must be a stable regular non-symlink file.", 1024 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(context(), "SOURCE_MAP_REQUIRED", "Directory import requires source-map schema 1.", SOURCE_MAP_FILENAME);
    throw error;
  }
  const map = unwrap(parseSourceMap(decodeUtf8(read.bytes, "SOURCE_MAP_INVALID_UTF8", "Source map must be valid UTF-8.", SOURCE_MAP_FILENAME), SOURCE_MAP_FILENAME));
  return { map, path, canonical: path === canonicalPath, snapshot: read.snapshot };
}

async function loadShardManifest(pathValue: string): Promise<{
  readonly manifest: ShardManifestV1;
  readonly path: string;
  readonly snapshot: PresentFileSnapshot;
}> {
  const path = resolve(pathValue);
  const read = await readRegularFileSnapshot(
    path,
    context(),
    "SHARD_MANIFEST_UNSAFE",
    "Shard manifest must be a stable regular non-symlink file.",
    SHARD_MANIFEST_MAX_BYTES,
  );
  const text = decodeUtf8(read.bytes, "SHARD_INVALID_UTF8", "Shard manifest must be valid UTF-8.", basename(path));
  return { manifest: unwrap(parseShardManifest(text, basename(path))), path, snapshot: read.snapshot };
}

function selectedCollections(map: SourceMapV1, ids: readonly string[]): readonly SourceMapCollectionV1[] {
  if (ids.length === 0) fail(context(), "DIRECTORY_COLLECTION_REQUIRED", "Directory import requires at least one collection.");
  if (new Set(ids).size !== ids.length) fail(context(), "DIRECTORY_DUPLICATE_COLLECTION", "Collection selection contains a duplicate ID.");
  return ids.map((id) => {
    const collection = map.collections.find((candidate) => candidate.id === id);
    if (collection === undefined) fail(context(), "DIRECTORY_UNKNOWN_COLLECTION", `Unknown collection '${id}'.`, id);
    return collection;
  }).sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
}

function companionOwner(sourcePath: string, collections: readonly SourceMapCollectionV1[]): string {
  const owners = collections.filter((collection) => collection.root === "." || sourcePath.startsWith(`${collection.root}/`));
  if (owners.length !== 1) fail(context(), owners.length === 0 ? "DIRECTORY_COMPANION_OUTSIDE_COLLECTION" : "DIRECTORY_COMPANION_MULTIPLE_COLLECTIONS", "Companion path must be rooted in exactly one selected collection.", sourcePath);
  return owners[0]!.id;
}

async function planDirectoryImport(options: ImportOptions, hooks: ImportPlanningHooks, sourcePath: string): Promise<ImportPlan> {
  await hooks.checkCancelled?.();
  const sourceRoot = resolve(sourcePath);
  const capability = getDirectorySnapshotCapability(sourceRoot);
  if (!capability.supported) fail(context(), "DIRECTORY_SNAPSHOT_UNSUPPORTED", "Mutation-grade directory snapshot backend is unavailable.");
  if (options.schema !== undefined && options.schema !== 2) fail(context(), "DIRECTORY_SCHEMA_UNSUPPORTED", "Directory import supports schema 2 only.");
  if (options.manifest === true) fail(context(), "DIRECTORY_MANIFEST_UNSUPPORTED", "Directory import does not support archive manifests.");
  if (options.shardManifest !== undefined && (options.selections?.length ?? 0) > 0) {
    fail(context(), "SHARD_MANIFEST_SELECTION_CONFLICT", "A shard manifest is mutually exclusive with ad-hoc source selection.");
  }
  const loadedShard = options.shardManifest === undefined ? undefined : await loadShardManifest(options.shardManifest);
  const loadedMap = await loadDirectorySourceMap(sourceRoot, options.sourceMap);
  if (loadedShard !== undefined && computeSourceMapDigest(loadedMap.map) !== loadedShard.manifest.sourceMapDigest) {
    fail(context(), "SHARD_MANIFEST_STALE", "Current source-map semantics differ from the shard manifest.", basename(loadedShard.path));
  }
  const requestedCollections = options.collections ?? [];
  if (loadedShard !== undefined && requestedCollections.length > 0
    && (requestedCollections.length !== 1 || requestedCollections[0] !== loadedShard.manifest.collectionId)) {
    fail(context(), "SHARD_MANIFEST_COLLECTION_MISMATCH", "Explicit collection must exactly match the shard manifest collection.");
  }
  const effectiveCollectionIds = loadedShard === undefined ? requestedCollections : [loadedShard.manifest.collectionId];
  await hooks.checkCancelled?.();
  const collections = selectedCollections(loadedMap.map, effectiveCollectionIds);
  const effectiveSelections = loadedShard === undefined
    ? options.selections
    : loadedShard.manifest.assets.map((asset) => {
      const owner = collections[0]!;
      return owner.root === "." ? asset.sourcePath : `${owner.root}/${asset.sourcePath}`;
    });
  const companionInputs = (options.companions ?? []).map((sourcePathValue) => {
    validatePortablePathValue(sourcePathValue, context(), sourcePathValue);
    if (!isAllowedCompanionFilename(sourcePathValue)) fail(context(), "ARCHIVE_COMPANION_UNSUPPORTED", "Companion filename is not in the approved text-document allowlist.", sourcePathValue);
    const filename = basename(sourcePathValue);
    return { collectionId: companionOwner(sourcePathValue, collections), sourcePath: sourcePathValue, filename };
  });
  const companionNames = new Map<string, string>();
  for (const companion of companionInputs) {
    const key = companion.filename.normalize("NFC").toLowerCase();
    const previous = companionNames.get(key);
    if (previous !== undefined) fail(context(), "ARCHIVE_COLLISION", `Companion paths '${previous}' and '${companion.sourcePath}' flatten to the same canonical filename.`, companion.sourcePath);
    companionNames.set(key, companion.sourcePath);
  }
  const root = await resolveImportRoot(options.root);
  await hooks.afterRootValidation?.();
  await hooks.checkCancelled?.();
  const canonicalSnapshot = await snapshotCanonicalTree(root, true, "import");
  if (canonicalSnapshot.canonicalPresent) fail(context(), "ROOT_ALREADY_INITIALIZED", "Import refuses an existing .tfsb directory.", ".tfsb");
  let snapshot: AuthenticatedDirectorySnapshot | undefined;
  try {
    let shardDirectoryPaths: ReadonlySet<string> | undefined;
    if (loadedShard !== undefined && companionInputs.length > 0) {
      const shardSnapshot = unwrap(await createDirectorySnapshot(sourceRoot, loadedMap.map, effectiveCollectionIds, {
        ...((effectiveSelections?.length ?? 0) === 0 ? {} : { selectedPaths: effectiveSelections }),
      }));
      try {
        shardDirectoryPaths = new Set(shardSnapshot.directories.map((directory) => directory.path));
      } finally {
        closeDirectorySnapshot(shardSnapshot);
      }
    }
    snapshot = unwrap(await createDirectorySnapshot(sourceRoot, loadedMap.map, effectiveCollectionIds, {
      ...((effectiveSelections?.length ?? 0) === 0 ? {} : { selectedPaths: effectiveSelections }),
      ...(companionInputs.length === 0 ? {} : { companions: companionInputs.map(({ collectionId, sourcePath: companionPath }) => ({ collectionId, sourcePath: companionPath })) }),
    }));
    let sourceMap = loadedMap.map;
    if (loadedMap.canonical) {
      const authenticatedBytes = readDirectorySnapshotAuthorityFile(snapshot, SOURCE_MAP_FILENAME, 1024 * 1024);
      sourceMap = unwrap(parseSourceMap(decodeUtf8(authenticatedBytes, "SOURCE_MAP_INVALID_UTF8", "Source map must be valid UTF-8.", SOURCE_MAP_FILENAME), SOURCE_MAP_FILENAME));
      if (computeSourceMapDigest(sourceMap) !== snapshot.sourceMapDigest) fail(context(), "DIRECTORY_SOURCE_CHANGED", "Canonical source map changed during authenticated planning.", SOURCE_MAP_FILENAME);
    }
    let normalizationMap: NormalizationMapV1 | undefined;
    let normalizationMapSnapshot: { readonly path: string; readonly snapshot: PresentFileSnapshot } | undefined;
    if (options.normalizationMap !== undefined) {
      if (options.normalize !== "exact-common") fail(context(), "NORMALIZATION_POLICY_REQUIRED", "A normalization map requires exact-common normalization.");
      const mapPath = resolve(options.normalizationMap);
      const read = await readRegularFileSnapshot(mapPath, context(), "NORMALIZATION_MAP_UNSAFE", "Normalization map must be a stable regular non-symlink file.", 1024 * 1024);
      normalizationMap = unwrapNormalizationMap(parseNormalizationMap(decodeUtf8(read.bytes, "NORMALIZATION_MAP_INVALID_UTF8", "Normalization map must be valid UTF-8.")));
      normalizationMapSnapshot = { path: mapPath, snapshot: read.snapshot };
    }
    if (options.normalize !== undefined && options.normalize !== "exact-common") fail(context(), "NORMALIZATION_POLICY_UNSUPPORTED", "Directory import supports only exact-common normalization.");
    const normalizationPolicy = options.normalize === "exact-common" ? createNormalizationPolicyIdentity(normalizationMap) : undefined;
    if (loadedShard !== undefined) {
      const manifestDirectories = shardDirectoryPaths === undefined
        ? snapshot.directories
        : snapshot.directories.filter((directory) => shardDirectoryPaths.has(directory.path));
      if (computeDirectorySnapshotDigest(snapshot.sourceMapDigest, manifestDirectories, snapshot.files) !== loadedShard.manifest.sourceSnapshotDigest) {
        fail(context(), "SHARD_MANIFEST_STALE", "Current selected-view snapshot differs from the shard manifest.", basename(loadedShard.path));
      }
      const currentByPath = new Map(snapshot.files.map((file) => [file.collectionPath, file]));
      let directlyImportable = 0;
      let normalizationRequired = 0;
      if (currentByPath.size !== loadedShard.manifest.assets.length) {
        fail(context(), "SHARD_MANIFEST_STALE", "Current selected membership differs from the shard manifest.", basename(loadedShard.path));
      }
      for (const expected of loadedShard.manifest.assets) {
        await hooks.checkCancelled?.();
        const current = currentByPath.get(expected.sourcePath);
        if (current === undefined || current.collectionId !== loadedShard.manifest.collectionId || current.assetId !== expected.assetId) {
          fail(context(), "SHARD_MANIFEST_STALE", "Current selected path or derived identity differs from the shard manifest.", expected.sourcePath);
        }
        const bytes = copyDirectorySnapshotFileBytes(snapshot, current.sourcePath);
        if (bytes.byteLength !== expected.sourceBytes || computeSha256(bytes) !== expected.sourceDigest) {
          fail(context(), "SHARD_MANIFEST_STALE", "Current source bytes differ from the shard manifest.", expected.sourcePath);
        }
        const classification = scanAnalyzeSvg(bytes, current.sourcePath, current.assetId).file.profiles.commonV03.classification;
        if (classification === "unsafe" || classification === "unsupported") {
          fail(context(), "SHARD_MANIFEST_STALE", "Current analyzer classification is no longer materializable.", expected.sourcePath);
        }
        if (classification === "directly_importable") directlyImportable += 1;
        else normalizationRequired += 1;
      }
      if (directlyImportable !== loadedShard.manifest.directlyImportable
        || normalizationRequired !== loadedShard.manifest.normalizationRequired) {
        fail(context(), "SHARD_MANIFEST_STALE", "Current analyzer summary differs from the shard manifest.", basename(loadedShard.path));
      }
    }
    const assets: NormalizedAssetV2[] = [];
    const ledgers: NormalizationLedgerV1["entries"][number][] = [];
    const sources = new Map<string, { readonly collectionId: string; readonly sourcePath: string; readonly bytes: Uint8Array; readonly normalized: boolean }>();
    for (const file of snapshot.files) {
      await hooks.checkCancelled?.();
      const bytes = copyDirectorySnapshotFileBytes(snapshot, file.sourcePath);
      const analysis = scanAnalyzeSvg(bytes, file.sourcePath, file.assetId).file.profiles.commonV03.classification;
      if (analysis === "unsafe") fail(context(), "IMPORT_UNSAFE_SOURCE", "Unsafe SVG content cannot be imported.", file.sourcePath);
      if (analysis === "unsupported") fail(context(), "IMPORT_UNSUPPORTED_SOURCE", "Unsupported SVG content cannot be imported.", file.sourcePath);
      const text = decodeUtf8(bytes, "ARCHIVE_INVALID_UTF8", "Selected SVG is not valid UTF-8.", file.sourcePath);
      const filename = `${file.assetId}.svg` as SvgFilename;
      const parsed = parseSvgV2(text, file.sourcePath);
      const canonicalSvg = parsed.ok ? unwrap(serializeSvgV2(parsed.value, file.sourcePath)) : undefined;
      let asset: NormalizedAssetV2;
      let normalized = false;
      if (parsed.ok && canonicalSvg === text) {
        asset = { schemaVersion: 2, id: file.assetId as AssetId, filename, svg: parsed.value };
        if (normalizationPolicy !== undefined) {
          const semanticDigest = computeAssetSemanticDigest(asset);
          ledgers.push({ source: file.sourcePath, sourceDigest: computeSha256(bytes), schema1Classification: scanAnalyzeSvg(bytes, file.sourcePath, file.assetId).file.profiles.schema1.classification, commonV03Classification: analysis, consumedAccessibilityAuthority: null, operations: [], beforeSemanticDigest: semanticDigest, afterCanonicalDigest: semanticDigest, policyDigest: normalizationPolicy.policyDigest, disposition: "direct" });
        }
      } else {
        if (normalizationPolicy === undefined) fail(context(), "IMPORT_NORMALIZATION_REQUIRED", `Schema-2 source '${file.sourcePath}' is not already canonical and requires --normalize exact-common.`, file.sourcePath);
        const result = normalizeCommonSvg({ bytes, source: file.sourcePath, assetId: file.assetId as AssetId, filename, ...(normalizationMap === undefined ? {} : { map: normalizationMap }), policy: normalizationPolicy });
        asset = result.asset;
        ledgers.push(result.ledger);
        normalized = true;
      }
      assets.push(asset);
      sources.set(asset.id, { collectionId: file.collectionId, sourcePath: file.sourcePath, bytes, normalized });
    }
    assets.sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
    enforceMutationAssetLimit(assets.length, "import");
    const project: NormalizedProjectV2 = { schemaVersion: 2, name: defaultProjectName(root), buildDirectory: "brand/dist" as ProjectRelativePath, installs: [], companions: [] };
    const files = new Map<string, string | Uint8Array>();
    const projectToml = serializeProjectTomlVersioned(project);
    if (!isDeepStrictEqual(unwrap(parseProjectTomlVersioned(projectToml, ".tfsb/project.toml")), project)) throw new Error("Generated project TOML failed its invariant round-trip.");
    files.set(".tfsb/project.toml", projectToml);
    for (const asset of assets) {
      const path = `.tfsb/assets/${asset.id}.toml`;
      const toml = serializeAssetTomlVersioned(asset);
      if (!isDeepStrictEqual(unwrap(parseAssetTomlVersioned(toml, 2, path)), asset)) throw new Error(`Generated asset TOML failed its invariant round-trip for '${asset.id}'.`);
      files.set(path, toml);
    }
    const companions: SelectedDirectoryCompanion[] = companionInputs.map((companion) => {
      const bytes = copyDirectorySnapshotFileBytes(snapshot!, companion.sourcePath);
      files.set(`.tfsb/companions/${companion.filename}`, bytes);
      return { entryName: companion.sourcePath, filename: companion.filename, bytes, collectionId: companion.collectionId, sourcePath: companion.sourcePath };
    });
    await hooks.checkCancelled?.();
    const directorySource = (collectionId: string, sourcePathValue: string, sourceDigest: ReturnType<typeof computeSha256>, canonicalBasis: typeof ASSET_DIGEST_BASIS_V2 | typeof COMPANION_DIGEST_BASIS, canonicalDigest: ReturnType<typeof computeSha256>) => ({
      kind: "directory" as const,
      collectionId,
      sourcePath: sourcePathValue,
      sourceMapBasis: SOURCE_MAP_DIGEST_BASIS,
      sourceMapDigest: snapshot!.sourceMapDigest,
      snapshotBasis: DIRECTORY_SNAPSHOT_BASIS,
      snapshotDigest: snapshot!.inventoryDigest,
      sourceBasis: DIRECTORY_FILE_BYTES_BASIS,
      sourceState: "present" as const,
      sourceDigest,
      sourceCanonicalBasis: canonicalBasis,
      sourceCanonicalDigest: canonicalDigest,
      canonicalBasis,
      canonicalState: "present" as const,
      canonicalDigest,
      resolution: "aligned" as const,
      toolVersion: TOOL_VERSION,
    });
    const records: ImportProvenanceV3["records"] = [
      ...assets.map((asset) => {
        const source = sources.get(asset.id)!;
        const canonicalDigest = computeAssetSemanticDigest(asset);
        return { type: "asset" as const, assetId: asset.id, canonicalPath: `.tfsb/assets/${asset.id}.toml`, source: directorySource(source.collectionId, source.sourcePath, computeSha256(source.bytes), ASSET_DIGEST_BASIS_V2, canonicalDigest), migration: null, normalizationPolicy: source.normalized ? normalizationPolicy! : null };
      }),
      ...companions.map((companion) => {
        const byteDigest = computeCompanionByteDigest(companion.bytes);
        return { type: "companion" as const, canonicalPath: `.tfsb/companions/${companion.filename}`, source: directorySource(companion.collectionId, companion.sourcePath, byteDigest, COMPANION_DIGEST_BASIS, byteDigest) };
      }),
    ];
    files.set(".tfsb/provenance.json", serializeImportProvenanceV3({ kind: "tfsb-import-provenance", schemaVersion: 3, records }));
    const nextFiles = new Map([...files].map(([path, value]) => [path, typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value)]));
    const plan: ImportPlan = {
      root,
      sourceKind: "directory",
      project,
      assets,
      companions,
      files,
      provenanceSchemaVersion: 3,
      sourceMapDigest: snapshot.sourceMapDigest,
      snapshotDigest: snapshot.inventoryDigest,
      collections: collections.map((collection) => collection.id),
      sourceMapDescription: loadedMap.canonical ? SOURCE_MAP_FILENAME : basename(loadedMap.path),
      ...(normalizationPolicy === undefined ? {} : { normalizationPolicy, normalizationLedger: { schemaVersion: 1, entries: ledgers.sort((left, right) => Buffer.compare(Buffer.from(left.source), Buffer.from(right.source))) } }),
    };
    const transaction: DirectoryImportTransactionInternals = {
      kind: "directory",
      canonicalSnapshot,
      snapshot,
      sourceMap,
      sourceMapAuthority: loadedMap.canonical ? { kind: "canonical", sourcePath: SOURCE_MAP_FILENAME } : { kind: "external", path: loadedMap.path, snapshot: loadedMap.snapshot },
      ...(normalizationMapSnapshot === undefined ? {} : { normalizationMap: normalizationMapSnapshot }),
      ...(loadedShard === undefined ? {} : { shardManifest: { path: loadedShard.path, snapshot: loadedShard.snapshot } }),
      nextFiles,
      disposed: options.dryRun === true,
    };
    await hooks.checkCancelled?.();
    provenanceImportInternals.set(plan, transaction);
    if (transaction.disposed) closeDirectorySnapshot(snapshot);
    return plan;
  } catch (error) {
    if (snapshot !== undefined) closeDirectorySnapshot(snapshot);
    throw error;
  }
}

async function planImportInternal(options: ImportOptions, hooks: ImportPlanningHooks): Promise<ImportPlan> {
  await hooks.checkCancelled?.();
  const source = resolveLogicalSource(options);
  if (source.kind === "directory") return planDirectoryImport(options, hooks, source.path);
  if (options.shardManifest !== undefined) fail(context(), "SHARD_MANIFEST_DIRECTORY_REQUIRED", "Shard manifests can materialize only authenticated directory sources.");
  return planArchiveImportInternal({ ...options, archive: source.path }, hooks);
}

export async function planImport(options: ImportOptions): Promise<ImportPlan> {
  return planImportInternal(options, {});
}

/** Internal deterministic seam for concurrency tests; not re-exported by the package root. */
export async function planImportWithHooks(options: ImportOptions, hooks: ImportPlanningHooks): Promise<ImportPlan> {
  return planImportInternal(options, hooks);
}

async function durableWrite(path: string, contents: string | Uint8Array): Promise<void> {
  if (typeof contents === "string") {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } else {
    await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  }
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyNormalizationMapSnapshot(expected: { readonly path: string; readonly snapshot: PresentFileSnapshot }): Promise<void> {
  const current = await readRegularFileSnapshot(expected.path, context(), "NORMALIZATION_MAP_CHANGED", "Normalization map changed after planning.", 1024 * 1024);
  if (!sameFileIdentity(expected.snapshot, current.snapshot) || expected.snapshot.sha256 !== current.snapshot.sha256) fail(context(), "NORMALIZATION_MAP_CHANGED", "Normalization map changed after planning.");
}

async function stagedFiles(root: string, prefix = ""): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await stagedFiles(root, path));
    else if (entry.isFile() && !entry.isSymbolicLink()) paths.push(path);
    else fail(context(), "IMPORT_STAGE_INVALID", "Staged import contains a symlink or special file.", path);
  }
  return paths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

async function validateStagedImport(stageRoot: string, plan: ImportPlan, expectedFiles: ReadonlyMap<string, string | Uint8Array> = plan.files): Promise<void> {
  const expectedPaths = [...expectedFiles.keys()].map((path) => path.slice(".tfsb/".length)).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (plan.sourceKind === "directory" && !isDeepStrictEqual(await stagedFiles(stageRoot), expectedPaths)) fail(context(), "IMPORT_STAGE_INVALID", "Staged import contains an unexpected or missing file.");
  for (const [relative, expected] of expectedFiles) {
    const actual = await readFile(join(stageRoot, relative.slice(".tfsb/".length)));
    const expectedBytes = typeof expected === "string" ? Buffer.from(expected, "utf8") : Buffer.from(expected);
    if (!actual.equals(expectedBytes)) fail(context(), "IMPORT_STAGE_INVALID", "Staged import bytes differ from the authentic plan.", relative);
    const text = actual.toString("utf8");
    if (relative === ".tfsb/project.toml") {
      const project = unwrap(parseProjectTomlVersioned(text, relative));
      if (project.schemaVersion !== plan.project.schemaVersion) fail(context(), "IMPORT_STAGE_INVALID", "Staged project schema differs from the authentic plan.", relative);
    }
    else if (relative.startsWith(".tfsb/assets/")) unwrap(parseAssetTomlVersioned(text, plan.project.schemaVersion, relative));
    else if (relative === ".tfsb/provenance.json") {
      if (plan.project.schemaVersion === 1) unwrapProvenance(parseImportProvenance(text, relative));
      else if (plan.sourceKind === "directory") unwrapProvenanceV3(parseImportProvenanceV3(text, relative));
      else unwrapProvenanceV2(parseImportProvenanceV2(text, relative));
    }
  }
}

async function verifyDirectoryImportAuthority(transaction: DirectoryImportTransactionInternals): Promise<void> {
  let sourceMap: SourceMapV1;
  if (transaction.sourceMapAuthority.kind === "canonical") {
    const bytes = readDirectorySnapshotAuthorityFile(transaction.snapshot, transaction.sourceMapAuthority.sourcePath, 1024 * 1024);
    sourceMap = unwrap(parseSourceMap(decodeUtf8(bytes, "SOURCE_MAP_INVALID_UTF8", "Source map must be valid UTF-8.", SOURCE_MAP_FILENAME), SOURCE_MAP_FILENAME));
  } else {
    const current = await readRegularFileSnapshot(transaction.sourceMapAuthority.path, context(), "SOURCE_MAP_CHANGED", "Source map changed after planning.", 1024 * 1024);
    if (!sameFileIdentity(transaction.sourceMapAuthority.snapshot, current.snapshot) || transaction.sourceMapAuthority.snapshot.sha256 !== current.snapshot.sha256) fail(context(), "SOURCE_MAP_CHANGED", "Source map changed after planning.");
    sourceMap = unwrap(parseSourceMap(decodeUtf8(current.bytes, "SOURCE_MAP_INVALID_UTF8", "Source map must be valid UTF-8.", basename(transaction.sourceMapAuthority.path)), basename(transaction.sourceMapAuthority.path)));
  }
  if (computeSourceMapDigest(sourceMap) !== computeSourceMapDigest(transaction.sourceMap)) fail(context(), "SOURCE_MAP_CHANGED", "Source-map semantics changed after planning.");
  if (transaction.normalizationMap !== undefined) await verifyNormalizationMapSnapshot(transaction.normalizationMap);
  if (transaction.shardManifest !== undefined) {
    const current = await readRegularFileSnapshot(
      transaction.shardManifest.path,
      context(),
      "SHARD_MANIFEST_CHANGED",
      "Shard manifest changed after planning.",
      SHARD_MANIFEST_MAX_BYTES,
    );
    if (!sameFileIdentity(transaction.shardManifest.snapshot, current.snapshot)
      || transaction.shardManifest.snapshot.sha256 !== current.snapshot.sha256) {
      fail(context(), "SHARD_MANIFEST_CHANGED", "Shard manifest changed after planning.");
    }
  }
  unwrap(await revalidateDirectorySnapshot(transaction.snapshot, sourceMap));
}

export async function executeImport(plan: ImportPlan, hooks?: TransactionHooks): Promise<void> {
  const transaction = provenanceImportInternals.get(plan);
  if (transaction?.kind === "directory" || plan.sourceKind === "directory") {
    if (transaction === undefined || transaction.kind !== "directory") fail(context(), "DIRECTORY_IMPORT_PLAN_FORGED", "Directory import requires authentic private snapshot authority.");
    if (plan.sourceKind !== "directory") {
      transaction.disposed = true;
      closeDirectorySnapshot(transaction.snapshot);
      fail(context(), "DIRECTORY_IMPORT_PLAN_FORGED", "Directory import public evidence was altered after planning.");
    }
    if (transaction.disposed) fail(context(), "DIRECTORY_SNAPSHOT_CLOSED", "Directory import plan authority has been disposed.");
    try {
      await executeCanonicalTransaction({
        root: transaction.canonicalSnapshot.root,
        nextFiles: transaction.nextFiles,
        expectedSnapshot: transaction.canonicalSnapshot,
        ...(hooks === undefined ? {} : { hooks }),
        operation: "import",
        validateStagedTree: (stageRoot) => validateStagedImport(stageRoot, plan, transaction.nextFiles),
        verifyExternalState: () => verifyDirectoryImportAuthority(transaction),
      });
    } finally {
      transaction.disposed = true;
      closeDirectorySnapshot(transaction.snapshot);
    }
    return;
  }
  if (transaction !== undefined && transaction.kind === "archive") {
    await executeCanonicalTransaction({
      root: plan.root,
      nextFiles: new Map([...plan.files].map(([path, value]) => [path, typeof value === "string" ? Buffer.from(value, "utf8") : value])),
      expectedSnapshot: transaction.canonicalSnapshot,
      archiveSnapshot: transaction.archiveSnapshot,
      ...(hooks === undefined ? {} : { hooks }),
      operation: "import",
      validateStagedTree: (stageRoot) => validateStagedImport(stageRoot, plan),
      ...(transaction.normalizationMap === undefined ? {} : { verifyExternalState: () => verifyNormalizationMapSnapshot(transaction.normalizationMap!) }),
    });
    return;
  }
  const ctx = context(plan.archive);
  const target = join(plan.root, ".tfsb");
  try {
    await lstat(target);
    fail(ctx, "ROOT_ALREADY_INITIALIZED", "Import refuses an existing .tfsb directory.", ".tfsb");
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stage = join(plan.root, `.tfsb-stage-${randomUUID()}`);
  try {
    await mkdir(join(stage, "assets"), { recursive: true, mode: 0o700 });
    if (plan.companions.length > 0) {
      await mkdir(join(stage, "companions"), { recursive: true, mode: 0o700 });
    }
    for (const [relative, contents] of plan.files) {
      const inside = relative.replace(/^\.tfsb\//, "");
      const full = join(stage, inside);
      await mkdir(dirname(full), { recursive: true, mode: 0o700 });
      await durableWrite(full, contents);
    }
    await rename(stage, target);
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Strict service-facing import execution.  Legacy executeImport intentionally
 * keeps its schema-1 compatibility fallback; this seam never accepts a plan
 * unless this planner instance still owns its private transaction record.
 */
export async function executeAuthenticImport(plan: ImportPlan, hooks?: TransactionHooks): Promise<void> {
  if (provenanceImportInternals.get(plan) === undefined) {
    fail(context(), "IMPORT_INVALID_PLAN", "Import apply requires an authentic private plan.");
  }
  await executeImport(plan, hooks);
}

export async function importProject(options: ImportOptions): Promise<ImportPlan> {
  const plan = await planImport(options);
  if (!options.dryRun) await executeImport(plan);
  return plan;
}

export function disposeImportPlan(plan: ImportPlan): void {
  const transaction = provenanceImportInternals.get(plan);
  if (transaction?.kind !== "directory" || transaction.disposed) return;
  transaction.disposed = true;
  closeDirectorySnapshot(transaction.snapshot);
}

/** Internal retention seam; not re-exported by the package root. */
export function inspectImportPlanRetention(plan: ImportPlan): PlanRetentionInspection {
  const transaction = provenanceImportInternals.get(plan);
  if (transaction === undefined) throw new Error("Import plan was not produced by this planner instance.");
  if (transaction.kind !== "directory") return inspectPlanRetention([plan, transaction]);
  const { snapshot, ...withoutSnapshot } = transaction;
  return mergePlanRetention(
    inspectPlanRetention([plan, withoutSnapshot]),
    inspectDirectorySnapshotRetention(snapshot),
  );
}
