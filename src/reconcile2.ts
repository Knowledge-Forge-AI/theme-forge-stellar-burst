import { readArchive, type ArchiveSnapshot } from "./archive.js";
import { ASSET_DIGEST_BASIS_V2, computeAssetSemanticDigest, computeCompanionByteDigest, computeSha256, type Sha256Digest } from "./digests.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import { readRegularFileSnapshot, sameFileIdentity, type PresentFileSnapshot } from "./filesystem.js";
import { deriveAssetIdentity } from "./importer.js";
import { migrateAssetModel } from "./migration.js";
import { normalizeCommonSvg } from "./normalizer.js";
import type { NormalizationLedgerEntryV1, NormalizationLedgerV1 } from "./normalization-ledger.js";
import { parseNormalizationMap, unwrapNormalizationMap, type NormalizationMapV1 } from "./normalization-map.js";
import { createNormalizationPolicyIdentity, normalizationPolicyMatches, type NormalizationPolicyIdentityV1 } from "./normalization-policy.js";
import type { LoadedProject } from "./project.js";
import { ARCHIVE_DIGEST_BASIS, ARCHIVE_SOURCE_DIGEST_BASIS, COMPANION_DIGEST_BASIS, parseImportProvenanceV2, serializeImportProvenanceV2, unwrapProvenanceV2, type ArchiveCanonicalStateV2, type ArchiveCheckpointV2, type ArchiveResolutionV2, type AssetProvenanceRecordV2, type CompanionProvenanceRecordV2, type ImportProvenanceV2, type ProvenanceRecordV2 } from "./provenance2.js";
import type { ReconciliationRecord, ReconcileOptions } from "./reconcile.js";
import { parseAssetTomlV2, parseProjectTomlV2, serializeAssetTomlV2 } from "./schema2-toml.js";
import { parseSvgV2, serializeSvgV2 } from "./schema2-svg.js";
import type { NormalizedAssetV2 } from "./schema2-types.js";
import { parseSvg } from "./svg.js";
import type { CanonicalTree } from "./transaction.js";
import type { AssetId, NormalizedAsset, Result, SvgFilename } from "./types.js";
import { TOOL_VERSION } from "./version.js";

export interface Schema2ReconciliationMaterial {
  readonly records: readonly ReconciliationRecord[];
  readonly nextFiles: CanonicalTree;
  readonly archiveSnapshot: ArchiveSnapshot;
  readonly changed: boolean;
  readonly pending: boolean;
  readonly blocked: boolean;
  readonly normalizationPolicy?: NormalizationPolicyIdentityV1;
  readonly normalizationLedger?: NormalizationLedgerV1;
  readonly verifyExternalState?: () => Promise<void>;
}

function context(domain: DiagnosticContext["domain"] = "project"): DiagnosticContext { return { operation: "reconcile", domain }; }
function unwrap<T>(result: Result<T>): T { if (result.ok) return result.value; const first = result.diagnostics[0]; if (first === undefined) throw new Error("Diagnostic result was unexpectedly empty."); throw new DiagnosticError(first); }
function equalFiles(left: CanonicalTree, right: CanonicalTree): boolean { if (left.size !== right.size) return false; for (const [path, bytes] of left) { const other = right.get(path); if (other === undefined || !Buffer.from(bytes).equals(Buffer.from(other))) return false; } return true; }
function resolutionMap(values: readonly string[]): Map<string, "canonical" | "archive"> { const result = new Map<string, "canonical" | "archive">(); for (const value of values) { const split = value.split("="); if (split.length !== 2 || (split[1] !== "canonical" && split[1] !== "archive")) fail(context(), "RECONCILE_INVALID_DIRECTIVE", "--resolve requires key=canonical|archive.", value); if (result.has(split[0]!)) fail(context(), "RECONCILE_DUPLICATE_DIRECTIVE", "Duplicate reconcile resolution.", split[0]); result.set(split[0]!, split[1]); } return result; }
function publicRecord(key: string, classification: ReconciliationRecord["classification"], action: string, blocker = false): ReconciliationRecord { return { key, kind: key.startsWith("companion:") ? "companion" : "asset", classification, action, blocker, plannedAction: blocker ? "resolve" : classification === "ARCHIVE_CHANGED" || classification === "COMPANION_CHANGED" ? "replace_canonical" : classification === "NEW_ASSET" || classification === "NEW_COMPANION" ? "add_canonical" : classification === "ARCHIVE_OMISSION" ? "retain" : "none", requiredAuthority: blocker ? "resolve" : "none" }; }
function currentAssetBaseline(record: AssetProvenanceRecordV2): Sha256Digest | undefined { return record.migration?.afterDigest ?? (record.archive?.canonicalBasis === ASSET_DIGEST_BASIS_V2 ? record.archive.canonicalDigest ?? undefined : undefined); }
function archiveTargetBaseline(record: AssetProvenanceRecordV2): Sha256Digest | undefined { return record.migration?.afterDigest ?? (record.archive?.canonicalBasis === ASSET_DIGEST_BASIS_V2 ? record.archive.archiveCanonicalDigest : undefined); }

async function loadMap(options: ReconcileOptions): Promise<{ readonly map?: NormalizationMapV1; readonly policy?: NormalizationPolicyIdentityV1; readonly snapshot?: { readonly path: string; readonly file: PresentFileSnapshot } }> {
  if (options.normalizationMap === undefined) return options.normalize === "exact-common" ? { policy: createNormalizationPolicyIdentity() } : {};
  if (options.normalize !== "exact-common") fail(context(), "NORMALIZATION_POLICY_REQUIRED", "A normalization map requires --normalize exact-common.");
  const read = await readRegularFileSnapshot(options.normalizationMap, context(), "NORMALIZATION_MAP_UNSAFE", "Normalization map must be a stable regular non-symlink file.", 1024 * 1024);
  let text: string; try { text = new TextDecoder("utf8", { fatal: true }).decode(read.bytes); } catch { fail(context(), "NORMALIZATION_MAP_INVALID_UTF8", "Normalization map must be valid UTF-8."); }
  const map = unwrapNormalizationMap(parseNormalizationMap(text));
  return { map, policy: createNormalizationPolicyIdentity(map), snapshot: { path: options.normalizationMap, file: read.snapshot } };
}

function archiveCheckpoint(
  entryName: string,
  entryBytes: Uint8Array,
  archiveDigest: Sha256Digest,
  archiveCanonicalDigest: Sha256Digest,
  canonicalDigest: Sha256Digest | null,
  resolution: "aligned" | "canonical" = "aligned",
): ArchiveCheckpointV2 {
  return {
    archiveDigestBasis: ARCHIVE_DIGEST_BASIS,
    archiveDigest,
    entryName,
    sourceBasis: ARCHIVE_SOURCE_DIGEST_BASIS,
    sourceDigest: computeSha256(entryBytes),
    archiveCanonicalBasis: ASSET_DIGEST_BASIS_V2,
    archiveCanonicalDigest,
    canonicalBasis: ASSET_DIGEST_BASIS_V2,
    canonicalState: canonicalDigest === null ? "absent" : "present",
    canonicalDigest,
    resolution,
    toolVersion: TOOL_VERSION,
  };
}

function candidateAsset(entry: { readonly entryName: string; readonly bytes: Uint8Array }, identity: { readonly id: AssetId; readonly filename: SvgFilename }, record: AssetProvenanceRecordV2 | undefined, supplied: { readonly map?: NormalizationMapV1; readonly policy?: NormalizationPolicyIdentityV1 }): { readonly asset?: NormalizedAssetV2; readonly policy: NormalizationPolicyIdentityV1 | null; readonly ledger?: NormalizationLedgerEntryV1; readonly authorityMissing: boolean } {
  let text: string; try { text = new TextDecoder("utf8", { fatal: true }).decode(entry.bytes); } catch { fail(context("archive"), "ARCHIVE_INVALID_UTF8", "Archive SVG must be valid UTF-8.", entry.entryName); }
  const stored = record?.normalizationPolicy ?? null;
  if (stored !== null) {
    if (stored.mapSha256 !== "none" && supplied.policy === undefined) return { policy: stored, authorityMissing: true };
    const policy = supplied.policy ?? createNormalizationPolicyIdentity();
    if (!normalizationPolicyMatches(stored, policy)) return { policy: stored, authorityMissing: true };
    const normalized = normalizeCommonSvg({ bytes: entry.bytes, source: entry.entryName, assetId: identity.id, filename: identity.filename, ...(supplied.map === undefined ? {} : { map: supplied.map }), policy });
    return { asset: normalized.asset, policy, ledger: normalized.ledger, authorityMissing: false };
  }
  if (record?.migration !== null && record?.migration !== undefined) {
    const v1: NormalizedAsset = { schemaVersion: 1, id: identity.id, filename: identity.filename, svg: unwrap(parseSvg(text, entry.entryName)) };
    return { asset: migrateAssetModel(v1), policy: null, authorityMissing: false };
  }
  const direct = parseSvgV2(text, entry.entryName);
  if (direct.ok && unwrap(serializeSvgV2(direct.value, entry.entryName)) === text) return { asset: { schemaVersion: 2, id: identity.id, filename: identity.filename, svg: direct.value }, policy: null, authorityMissing: false };
  if (supplied.policy !== undefined) {
    const normalized = normalizeCommonSvg({ bytes: entry.bytes, source: entry.entryName, assetId: identity.id, filename: identity.filename, ...(supplied.map === undefined ? {} : { map: supplied.map }), policy: supplied.policy });
    return { asset: normalized.asset, policy: supplied.policy, ledger: normalized.ledger, authorityMissing: false };
  }
  return { policy: null, authorityMissing: true };
}

function validateNext(files: CanonicalTree): void {
  const project = files.get(".tfsb/project.toml"); if (project === undefined) throw new Error("Missing project TOML."); unwrap(parseProjectTomlV2(Buffer.from(project).toString("utf8"), ".tfsb/project.toml"));
  for (const [path, bytes] of files) if (path.startsWith(".tfsb/assets/")) unwrap(parseAssetTomlV2(Buffer.from(bytes).toString("utf8"), path));
  const provenance = files.get(".tfsb/provenance.json"); if (provenance === undefined) fail(context("provenance"), "PROVENANCE_REQUIRED", "Schema-2 reconcile requires provenance schema 2.", ".tfsb/provenance.json"); unwrapProvenanceV2(parseImportProvenanceV2(Buffer.from(provenance).toString("utf8"), ".tfsb/provenance.json"));
}

export async function planSchema2Reconciliation(project: LoadedProject, options: ReconcileOptions): Promise<Schema2ReconciliationMaterial> {
  const provenanceBytes = project.snapshot.files.get(".tfsb/provenance.json")?.bytes;
  const provenance: ImportProvenanceV2 = provenanceBytes === undefined
    ? { kind: "tfsb-import-provenance", schemaVersion: 2, records: [] }
    : unwrapProvenanceV2(parseImportProvenanceV2(Buffer.from(provenanceBytes).toString("utf8"), ".tfsb/provenance.json"));
  const supplied = await loadMap(options);
  const archive = await readArchive(options.archive, options.selections ?? [], options.companions ?? [], { selectAllSvgs: (options.selections?.length ?? 0) === 0, selectAllCompanions: (options.companions?.length ?? 0) === 0, allowNoSvgs: true, operation: "reconcile" });
  const resolutions = resolutionMap(options.resolutions ?? []);
  const assetRecords = new Map(provenance.records.filter((record): record is AssetProvenanceRecordV2 => record.type === "asset").map((record) => [record.assetId, record]));
  const byEntry = new Map(provenance.records.filter((record): record is AssetProvenanceRecordV2 => record.type === "asset" && record.archive !== null).map((record) => [record.archive!.entryName, record]));
  const currentAssets = new Map((project.assets as readonly NormalizedAssetV2[]).map((asset) => [asset.id, asset]));
  const next = new Map([...project.snapshot.files].map(([path, file]) => [path, file.bytes]));
  const nextRecords = new Map<string, ProvenanceRecordV2>(provenance.records.map((record) => [record.type === "asset" ? `asset:${record.assetId}` : `companion:${record.canonicalPath}`, record]));
  const records: ReconciliationRecord[] = [];
  const ledgers: NormalizationLedgerEntryV1[] = [];
  let consumedPolicy: NormalizationPolicyIdentityV1 | undefined;
  const seen = new Set<string>();
  for (const entry of archive.svgs) {
    const derived = deriveAssetIdentity(entry.entryName, context("archive"));
    const tracked = byEntry.get(entry.entryName) ?? assetRecords.get(derived.id);
    const identity = tracked === undefined ? derived : { id: tracked.assetId as AssetId, filename: (entry.entryName.split("/").at(-1) ?? `${tracked.assetId}.svg`) as SvgFilename };
    const key = `asset:${identity.id}`; seen.add(identity.id);
    const current = currentAssets.get(identity.id); const currentDigest = current === undefined ? undefined : computeAssetSemanticDigest(current);
    if (tracked?.archive !== null && tracked?.archive !== undefined && computeSha256(entry.bytes) === tracked.archive.sourceDigest) {
      const baseline = currentAssetBaseline(tracked);
      records.push(publicRecord(key, currentDigest === baseline ? tracked.migration === null ? "UNCHANGED" : "UNCHANGED_ACCEPTED_DIVERGENCE" : "CANONICAL_EDITED", currentDigest === baseline ? "none" : "retain canonical edit"));
      continue;
    }
    const candidate = candidateAsset(entry, identity, tracked, supplied);
    if (candidate.authorityMissing || candidate.asset === undefined) { records.push(publicRecord(key, "POLICY_AUTHORITY_REQUIRED", "exact stored or re-supplied normalization authority required", true)); continue; }
    if (candidate.ledger !== undefined) ledgers.push(candidate.ledger);
    if (candidate.policy !== null) {
      if (consumedPolicy !== undefined && !normalizationPolicyMatches(consumedPolicy, candidate.policy)) fail(context(), "NORMALIZATION_POLICY_MISMATCH", "One reconcile plan cannot consume multiple normalization policy identities.");
      consumedPolicy = candidate.policy;
    }
    const candidateDigest = computeAssetSemanticDigest(candidate.asset); const baseline = tracked === undefined ? undefined : currentAssetBaseline(tracked); const archiveBaseline = tracked === undefined ? undefined : archiveTargetBaseline(tracked);
    const canonicalEdited = currentDigest !== baseline;
    const explicit = resolutions.get(key) ?? resolutions.get(identity.id);
    let selected: "canonical" | "archive" | undefined = explicit;
    if (selected === undefined) {
      if (tracked === undefined && current === undefined) selected = "archive";
      else if (tracked !== undefined && !canonicalEdited) selected = "archive";
    }
    if (selected === undefined && canonicalEdited) { records.push(publicRecord(key, "CONFLICT", `requires --resolve ${key}=canonical|archive`, true)); continue; }
    if (selected === "archive") {
      next.set(`.tfsb/assets/${identity.id}.toml`, Buffer.from(serializeAssetTomlV2(candidate.asset), "utf8"));
      const acceptedMigrationDivergence = tracked?.archive === null && tracked.migration !== null && candidateDigest === currentDigest;
      records.push(publicRecord(key, tracked === undefined ? "NEW_ASSET" : acceptedMigrationDivergence ? "UNCHANGED_ACCEPTED_DIVERGENCE" : "ARCHIVE_CHANGED", tracked === undefined ? "add canonical asset" : acceptedMigrationDivergence ? "record fresh SVG-equivalent historical source checkpoint" : "replace canonical asset"));
    }
    else records.push(publicRecord(key, "CONFLICT", "retain canonical by explicit resolution"));
    const acceptedCanonical = selected === "archive" ? candidateDigest : (currentDigest ?? null);
    if (selected === "canonical" && current === undefined) next.delete(`.tfsb/assets/${identity.id}.toml`);
    nextRecords.set(key, { type: "asset", assetId: identity.id, canonicalPath: `.tfsb/assets/${identity.id}.toml`, archive: archiveCheckpoint(entry.entryName, entry.bytes, archive.archiveDigest, candidateDigest, acceptedCanonical, acceptedCanonical === candidateDigest ? "aligned" : "canonical"), migration: tracked?.migration ?? null, normalizationPolicy: candidate.policy });
  }
  for (const [id] of currentAssets) if (!seen.has(id)) records.push(publicRecord(`asset:${id}`, "ARCHIVE_OMISSION", "retain canonical state; explicit removal required"));
  const companionRecords = new Map(provenance.records.filter((record): record is CompanionProvenanceRecordV2 => record.type === "companion").map((record) => [record.archive.entryName, record]));
  for (const entry of archive.companions) {
    const prior = companionRecords.get(entry.entryName); const filename = prior?.canonicalPath.slice(".tfsb/companions/".length) ?? entry.filename; const key = `companion:${filename}`; const current = project.companions.get(filename); const candidateDigest = computeCompanionByteDigest(entry.bytes);
    if (prior !== undefined && candidateDigest === prior.archive.sourceDigest) { records.push(publicRecord(key, "UNCHANGED", "none")); continue; }
    const canonicalEdited = prior !== undefined && computeCompanionByteDigest(current ?? new Uint8Array()) !== prior.archive.canonicalDigest;
    const selected = resolutions.get(key) ?? (canonicalEdited ? undefined : "archive");
    if (selected === undefined) { records.push(publicRecord(key, "CONFLICT", `requires --resolve ${key}=canonical|archive`, true)); continue; }
    if (selected === "archive") next.set(`.tfsb/companions/${filename}`, entry.bytes);
    else if (current === undefined) next.delete(`.tfsb/companions/${filename}`);
    const canonicalDigest = selected === "archive" ? candidateDigest : (current === undefined ? null : computeCompanionByteDigest(current));
    const canonicalState: ArchiveCanonicalStateV2 = canonicalDigest === null ? "absent" : "present";
    const resolution: ArchiveResolutionV2 = canonicalDigest === candidateDigest ? "aligned" : "canonical";
    const archiveRelation: ArchiveCheckpointV2 = { archiveDigestBasis: ARCHIVE_DIGEST_BASIS, archiveDigest: archive.archiveDigest, entryName: entry.entryName, sourceBasis: ARCHIVE_SOURCE_DIGEST_BASIS, sourceDigest: candidateDigest, archiveCanonicalBasis: COMPANION_DIGEST_BASIS, archiveCanonicalDigest: candidateDigest, canonicalBasis: COMPANION_DIGEST_BASIS, canonicalState, canonicalDigest, resolution, toolVersion: TOOL_VERSION };
    nextRecords.set(`companion:.tfsb/companions/${filename}`, { type: "companion", canonicalPath: `.tfsb/companions/${filename}`, archive: archiveRelation });
    records.push(publicRecord(key, prior === undefined ? "NEW_COMPANION" : "COMPANION_CHANGED", selected === "archive" ? "replace canonical companion" : "retain canonical companion"));
  }
  next.set(".tfsb/provenance.json", Buffer.from(serializeImportProvenanceV2({ kind: "tfsb-import-provenance", schemaVersion: 2, records: [...nextRecords.values()] }), "utf8"));
  validateNext(next);
  records.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const current = new Map([...project.snapshot.files].map(([path, file]) => [path, file.bytes])); const changed = !equalFiles(current, next); const blocked = records.some((record) => record.blocker); const pending = records.some((record) => !["UNCHANGED", "UNCHANGED_ACCEPTED_DIVERGENCE"].includes(record.classification));
  const verifyExternalState = supplied.snapshot === undefined ? undefined : async () => { const read = await readRegularFileSnapshot(supplied.snapshot!.path, context(), "NORMALIZATION_MAP_CHANGED", "Normalization map changed after planning.", 1024 * 1024); if (!sameFileIdentity(supplied.snapshot!.file, read.snapshot) || supplied.snapshot!.file.sha256 !== read.snapshot.sha256) fail(context(), "NORMALIZATION_MAP_CHANGED", "Normalization map changed after planning."); };
  return {
    records,
    nextFiles: next,
    archiveSnapshot: archive.snapshot,
    changed,
    pending,
    blocked,
    ...(consumedPolicy === undefined ? {} : { normalizationPolicy: consumedPolicy, normalizationLedger: { schemaVersion: 1, entries: ledgers.sort((left, right) => Buffer.compare(Buffer.from(left.source), Buffer.from(right.source))) } }),
    ...(verifyExternalState === undefined ? {} : { verifyExternalState }),
  };
}
