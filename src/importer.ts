import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { readArchive, readManifestArchive, type ArchiveReadHooks, type SelectedArchiveCompanion } from "./archive.js";
import { scanAnalyzeSvg } from "./analyze-scanner.js";
import { ASSET_DIGEST_BASIS_V2, computeAssetSemanticDigest, computeCompanionByteDigest, computeSha256 } from "./digests.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import { readRegularFileSnapshot, sameFileIdentity, type PresentFileSnapshot } from "./filesystem.js";
import { normalizeCommonSvg } from "./normalizer.js";
import { parseNormalizationMap, unwrapNormalizationMap, type NormalizationMapV1 } from "./normalization-map.js";
import type { NormalizationLedgerV1 } from "./normalization-ledger.js";
import { createNormalizationPolicyIdentity, type NormalizationPolicyIdentityV1 } from "./normalization-policy.js";
import { parseImportProvenance, serializeImportProvenance, unwrapProvenance, type ImportProvenanceV1 } from "./provenance.js";
import { ARCHIVE_DIGEST_BASIS, ARCHIVE_SOURCE_DIGEST_BASIS, COMPANION_DIGEST_BASIS, parseImportProvenanceV2, serializeImportProvenanceV2, unwrapProvenanceV2, type ImportProvenanceV2 } from "./provenance2.js";
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

export interface ImportOptions {
  readonly archive: string;
  readonly root?: string;
  readonly selections?: readonly string[];
  readonly companions?: readonly string[];
  readonly dryRun?: boolean;
  readonly recordProvenance?: boolean;
  readonly manifest?: boolean;
  readonly schema?: SupportedSchemaVersion;
  readonly normalize?: "exact-common";
  readonly normalizationMap?: string;
}

export interface ImportPlan {
  readonly root: string;
  readonly archive: string;
  readonly project: AnyNormalizedProject;
  readonly assets: readonly AnyNormalizedAsset[];
  readonly companions: readonly SelectedArchiveCompanion[];
  readonly files: ReadonlyMap<string, string | Uint8Array>;
  readonly normalizationLedger?: NormalizationLedgerV1;
  readonly normalizationPolicy?: NormalizationPolicyIdentityV1;
}

interface ProvenanceImportTransactionInternals {
  readonly canonicalSnapshot: CanonicalSnapshot;
  readonly archiveSnapshot: import("./archive.js").ArchiveSnapshot;
  readonly normalizationMap?: { readonly path: string; readonly snapshot: PresentFileSnapshot };
}

const provenanceImportInternals = new WeakMap<ImportPlan, ProvenanceImportTransactionInternals>();

interface ImportPlanningHooks {
  readonly afterRootValidation?: () => void | Promise<void>;
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
  options: ImportOptions,
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
  const plan: ImportPlan = { root, archive: options.archive, project, assets, companions: companionEntries, files, ...(normalizationPolicy === undefined ? {} : { normalizationPolicy, normalizationLedger: { schemaVersion: 1, entries: ledgers.sort((left, right) => Buffer.compare(Buffer.from(left.source), Buffer.from(right.source))) } }) };
  provenanceImportInternals.set(plan, { canonicalSnapshot, archiveSnapshot: (manifest ?? ordinary!).snapshot, ...(normalizationMapSnapshot === undefined ? {} : { normalizationMap: normalizationMapSnapshot }) });
  return plan;
}

async function planImportInternal(options: ImportOptions, hooks: ImportPlanningHooks): Promise<ImportPlan> {
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
      const relative = `.tfsb/assets/${asset.id}.toml`;
      const toml = serializeAssetToml(asset);
      const reparsed = unwrap(parseAssetToml(toml, relative));
      if (!isDeepStrictEqual(reparsed, asset)) throw new Error(`Generated asset TOML failed its invariant round-trip for '${asset.id}'.`);
      files.set(relative, toml);
    }
    for (const companion of archiveResult.companions) {
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
    const plan: ImportPlan = { root, archive: options.archive, project, assets, companions: archiveResult.companions, files };
    if (canonicalSnapshot !== undefined) {
      provenanceImportInternals.set(plan, { canonicalSnapshot, archiveSnapshot: archiveResult.snapshot });
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
    const relative = `.tfsb/assets/${asset.id}.toml`;
    const toml = serializeAssetToml(asset);
    const reparsed = unwrap(parseAssetToml(toml, relative));
    if (!isDeepStrictEqual(reparsed, asset)) throw new Error(`Generated asset TOML failed its invariant round-trip for '${asset.id}'.`);
    files.set(relative, toml);
  }
  for (const companion of archiveResult.companions) {
    const relative = `.tfsb/companions/${companion.filename}`;
    files.set(relative, companion.bytes);
  }
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
  const plan: ImportPlan = { root, archive: options.archive, project, assets, companions: archiveResult.companions, files };
  if (canonicalSnapshot !== undefined) {
    provenanceImportInternals.set(plan, { canonicalSnapshot, archiveSnapshot: archiveResult.snapshot });
  }
  return plan;
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

async function validateStagedImport(stageRoot: string, plan: ImportPlan): Promise<void> {
  for (const [relative, expected] of plan.files) {
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
      else unwrapProvenanceV2(parseImportProvenanceV2(text, relative));
    }
  }
}

export async function executeImport(plan: ImportPlan, hooks?: TransactionHooks): Promise<void> {
  const transaction = provenanceImportInternals.get(plan);
  if (transaction !== undefined) {
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

export async function importProject(options: ImportOptions): Promise<ImportPlan> {
  const plan = await planImport(options);
  if (!options.dryRun) await executeImport(plan);
  return plan;
}
