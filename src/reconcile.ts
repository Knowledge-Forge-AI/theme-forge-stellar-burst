import { isDeepStrictEqual } from "node:util";

import { isAllowedCompanionFilename, readArchive, type ArchiveSnapshot, type SelectedArchiveCompanion, type SelectedArchiveSvg } from "./archive.js";
import { classifyPairedCheckpoint, type PairedCheckpointClassification } from "./classifier.js";
import { computeAssetSemanticDigest, computeCompanionByteDigest, computeSha256, type Sha256Digest } from "./digests.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import { deriveAssetIdentity } from "./importer.js";
import { loadCanonicalProjectFromSnapshot } from "./project.js";
import {
  compareUtf8, parseImportProvenance, serializeImportProvenance, unwrapProvenance,
  type AssetProvenanceRecordV1, type CompanionProvenanceRecordV1,
  type ImportProvenanceV1, type ProvenanceRecordV1, type ProvenanceResolution,
} from "./provenance.js";
import { findProjectRoot, validateProjectPathLayout } from "./root.js";
import { parseSvg } from "./svg.js";
import { parseAssetToml, parseProjectToml } from "./toml.js";
import { serializeAssetToml, serializeProjectToml } from "./toml-writer.js";
import {
  executeCanonicalTransaction, snapshotCanonicalTree, snapshotsEqual,
  type CanonicalSnapshot, type CanonicalTree,
} from "./transaction.js";
import type { AssetId, NormalizedAsset, NormalizedProject, ProjectRelativePath, Result, SvgFilename } from "./types.js";
import { TOOL_VERSION } from "./version.js";
import { planSchema2Reconciliation } from "./reconcile2.js";
import type { NormalizationLedgerV1 } from "./normalization-ledger.js";
import type { NormalizationPolicyIdentityV1 } from "./normalization-policy.js";

export type ReconciliationClassification = PairedCheckpointClassification
  | "COMPANION_CHANGED"
  | "NEW_COMPANION"
  | "RENAMED"
  | "COMPANION_RENAMED"
  | "REMOVED"
  | "COMPANION_REMOVED"
  | "POLICY_AUTHORITY_REQUIRED";

export type ReconcilePlannedAction =
  | "none"
  | "replace_canonical"
  | "update_provenance"
  | "add_canonical"
  | "retain"
  | "resolve"
  | "rename"
  | "remove"
  | "blocked_collision";

export type ReconcileRequiredAuthority = "none" | "resolve" | "rename" | "remove";

export interface ReconciliationRecord {
  readonly key: string;
  readonly kind: "asset" | "companion";
  readonly classification: ReconciliationClassification;
  readonly action: string;
  readonly blocker: boolean;
  readonly plannedAction: ReconcilePlannedAction;
  readonly requiredAuthority: ReconcileRequiredAuthority;
}

export interface ReconcileOptions {
  readonly archive: string;
  readonly root?: string;
  readonly selections?: readonly string[];
  readonly companions?: readonly string[];
  readonly resolutions?: readonly string[];
  readonly renames?: readonly string[];
  readonly companionRenames?: readonly string[];
  readonly removals?: readonly string[];
  readonly companionRemovals?: readonly string[];
  readonly apply?: boolean;
  readonly normalize?: "exact-common";
  readonly normalizationMap?: string;
}

const planBrand: unique symbol = Symbol("tfsb-reconciliation-plan");

interface ReconciliationPlanInternals {
  readonly root: string;
  readonly nextFiles: CanonicalTree;
  readonly canonicalSnapshot: CanonicalSnapshot;
  readonly archiveSnapshot: ArchiveSnapshot;
  readonly changed: boolean;
  readonly pending: boolean;
  readonly blocked: boolean;
  readonly verifyExternalState?: () => Promise<void>;
}

interface ReconciliationPlanningHooks {
  readonly afterCanonicalSnapshot?: () => void | Promise<void>;
}

const reconciliationPlanInternals = new WeakMap<ReconciliationPlan, ReconciliationPlanInternals>();

export interface ReconciliationPlan {
  readonly records: readonly ReconciliationRecord[];
  readonly changed: boolean;
  readonly pending: boolean;
  readonly blocked: boolean;
  readonly normalizationPolicy?: NormalizationPolicyIdentityV1;
  readonly normalizationLedger?: NormalizationLedgerV1;
  readonly [planBrand]: true;
}

export interface ReconciliationResult {
  readonly records: readonly ReconciliationRecord[];
  readonly changed: boolean;
  readonly pending: boolean;
  readonly blocked: boolean;
  readonly applied: boolean;
  readonly normalizationPolicy?: NormalizationPolicyIdentityV1;
  readonly normalizationLedger?: NormalizationLedgerV1;
}

interface CandidateAsset {
  readonly entry: SelectedArchiveSvg;
  readonly asset: NormalizedAsset;
  readonly toml: Uint8Array;
  readonly modelDigest: Sha256Digest;
  readonly entryDigest: Sha256Digest;
}

interface CandidateCompanion {
  readonly entry: SelectedArchiveCompanion;
  readonly digest: Sha256Digest;
}

function context(): DiagnosticContext {
  return { operation: "reconcile", domain: "project" };
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const first = result.diagnostics[0];
  if (first === undefined) throw new Error("Diagnostic result was unexpectedly empty.");
  throw new DiagnosticError(first);
}

function parseAssignments(values: readonly string[], name: string, sides?: readonly string[]): Map<string, string> {
  const ctx = context();
  const result = new Map<string, string>();
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator !== value.lastIndexOf("=") || separator === value.length - 1) {
      fail(ctx, "RECONCILE_INVALID_DIRECTIVE", `${name} requires exactly one non-empty key=value pair.`, value);
    }
    const key = value.slice(0, separator).normalize("NFC");
    const selected = value.slice(separator + 1).normalize("NFC");
    if (result.has(key)) fail(ctx, "RECONCILE_DUPLICATE_DIRECTIVE", `${name} repeats key '${key}'.`, key);
    if (sides !== undefined && !sides.includes(selected)) {
      fail(ctx, "RECONCILE_INVALID_DIRECTIVE", `${name} value must be ${sides.join(" or ")}.`, value);
    }
    result.set(key, selected);
  }
  return result;
}

function parseNames(values: readonly string[], name: string): Set<string> {
  const ctx = context();
  const result = new Set<string>();
  for (const raw of values) {
    const value = raw.normalize("NFC");
    if (value === "") fail(ctx, "RECONCILE_INVALID_DIRECTIVE", `${name} values cannot be empty.`);
    if (result.has(value)) fail(ctx, "RECONCILE_DUPLICATE_DIRECTIVE", `${name} repeats '${value}'.`, value);
    result.add(value);
  }
  return result;
}

function assetRecordKey(id: string): string { return `asset:${id}`; }
function companionFilename(path: string): string { return path.slice(".tfsb/companions/".length); }
function companionRecordKey(filename: string): string { return `companion:${filename}`; }

function recordedAsset(record: AssetProvenanceRecordV1 | undefined) {
  return record === undefined ? undefined : {
    canonicalState: record.canonicalState,
    ...(record.canonicalModelDigest === undefined ? {} : { canonicalDigest: record.canonicalModelDigest }),
    archiveDigest: record.archiveModelDigest,
    resolution: record.resolution,
  };
}

function recordedCompanion(record: CompanionProvenanceRecordV1 | undefined) {
  return record === undefined ? undefined : {
    canonicalState: record.canonicalState,
    ...(record.canonicalByteDigest === undefined ? {} : { canonicalDigest: record.canonicalByteDigest }),
    archiveDigest: record.archiveByteDigest,
    resolution: record.resolution,
  };
}

function alignedAssetRecord(candidate: CandidateAsset, archiveDigest: Sha256Digest): AssetProvenanceRecordV1 {
  return {
    type: "asset", assetId: candidate.asset.id, canonicalPath: `.tfsb/assets/${candidate.asset.id}.toml`,
    archiveDigest, entryName: candidate.entry.entryName, entryDigest: candidate.entryDigest,
    digestBasis: "tfsb-asset-toml-v1", archiveModelDigest: candidate.modelDigest,
    canonicalState: "present", canonicalModelDigest: candidate.modelDigest,
    resolution: "aligned", toolVersion: TOOL_VERSION,
  };
}

function canonicalAssetRecord(
  candidate: CandidateAsset | undefined,
  currentDigest: Sha256Digest | undefined,
  archiveDigest: Sha256Digest,
  prior: AssetProvenanceRecordV1 | undefined,
): AssetProvenanceRecordV1 | undefined {
  if (candidate === undefined && currentDigest === undefined) return undefined;
  const assetId = candidate?.asset.id ?? prior?.assetId;
  const entryName = candidate?.entry.entryName ?? prior?.entryName;
  const entryDigest = candidate?.entryDigest ?? prior?.entryDigest;
  const archiveModelDigest = candidate?.modelDigest ?? prior?.archiveModelDigest;
  if (assetId === undefined || entryName === undefined || entryDigest === undefined || archiveModelDigest === undefined) return undefined;
  const resolution: ProvenanceResolution = currentDigest !== undefined && currentDigest === archiveModelDigest ? "aligned" : "canonical";
  return {
    type: "asset", assetId,
    canonicalPath: `.tfsb/assets/${assetId}.toml`,
    archiveDigest: candidate === undefined && prior !== undefined ? prior.archiveDigest : archiveDigest,
    entryName, entryDigest,
    digestBasis: "tfsb-asset-toml-v1", archiveModelDigest,
    canonicalState: currentDigest === undefined ? "absent" : "present",
    ...(currentDigest === undefined ? {} : { canonicalModelDigest: currentDigest }),
    resolution, toolVersion: TOOL_VERSION,
  };
}

function alignedCompanionRecord(candidate: CandidateCompanion, archiveDigest: Sha256Digest): CompanionProvenanceRecordV1 {
  return {
    type: "companion", canonicalPath: `.tfsb/companions/${candidate.entry.filename}`,
    archiveDigest, entryName: candidate.entry.entryName, entryDigest: candidate.digest,
    archiveByteDigest: candidate.digest, canonicalState: "present", canonicalByteDigest: candidate.digest,
    resolution: "aligned", toolVersion: TOOL_VERSION,
  };
}

function canonicalCompanionRecord(
  candidate: CandidateCompanion | undefined,
  filename: string,
  currentDigest: Sha256Digest | undefined,
  archiveDigest: Sha256Digest,
  prior: CompanionProvenanceRecordV1 | undefined,
): CompanionProvenanceRecordV1 | undefined {
  if (candidate === undefined && currentDigest === undefined) return undefined;
  const entryName = candidate?.entry.entryName ?? prior?.entryName;
  const archiveByteDigest = candidate?.digest ?? prior?.archiveByteDigest;
  const entryDigest = candidate?.digest ?? prior?.entryDigest;
  if (entryName === undefined || archiveByteDigest === undefined || entryDigest === undefined) return undefined;
  const selectedResolution: ProvenanceResolution = currentDigest !== undefined && currentDigest === archiveByteDigest ? "aligned" : "canonical";
  return {
    type: "companion", canonicalPath: `.tfsb/companions/${filename}`,
    archiveDigest: candidate === undefined && prior !== undefined ? prior.archiveDigest : archiveDigest,
    entryName, entryDigest, archiveByteDigest,
    canonicalState: currentDigest === undefined ? "absent" : "present",
    ...(currentDigest === undefined ? {} : { canonicalByteDigest: currentDigest }),
    resolution: selectedResolution, toolVersion: TOOL_VERSION,
  };
}

function actionFor(classification: ReconciliationClassification, key: string): { action: string; blocker: boolean } {
  switch (classification) {
    case "UNCHANGED": case "UNCHANGED_ACCEPTED_DIVERGENCE": case "UNCHANGED_ACCEPTED_ABSENCE":
      return { action: "none", blocker: false };
    case "ARCHIVE_CHANGED": return { action: "replace canonical asset", blocker: false };
    case "COMPANION_CHANGED": return { action: "replace canonical companion", blocker: false };
    case "CONVERGED": case "UNTRACKED_MATCH": case "CONVERGED_ABSENCE":
      return { action: "update provenance", blocker: false };
    case "NEW_ASSET": return { action: "add canonical asset without install rule", blocker: false };
    case "NEW_COMPANION": return { action: "add canonical companion without destination rule", blocker: false };
    case "ARCHIVE_OMISSION": return { action: "retain canonical state; explicit removal required", blocker: false };
    case "RENAMED": return { action: "rename canonical asset and preserve destinations", blocker: false };
    case "COMPANION_RENAMED": return { action: "rename canonical companion and preserve destinations", blocker: false };
    case "REMOVED": case "COMPANION_REMOVED": return { action: "remove canonical record and project policy", blocker: false };
    default: return { action: `requires --resolve ${key}=canonical|archive`, blocker: true };
  }
}

function machineActionFor(classification: ReconciliationClassification, blocker: boolean): {
  plannedAction: ReconcilePlannedAction;
  requiredAuthority: ReconcileRequiredAuthority;
} {
  if (blocker) return { plannedAction: "resolve", requiredAuthority: "resolve" };
  if (["UNCHANGED", "UNCHANGED_ACCEPTED_DIVERGENCE", "UNCHANGED_ACCEPTED_ABSENCE"].includes(classification)) return { plannedAction: "none", requiredAuthority: "none" };
  if (["ARCHIVE_CHANGED", "COMPANION_CHANGED"].includes(classification)) return { plannedAction: "replace_canonical", requiredAuthority: "none" };
  if (["CONVERGED", "UNTRACKED_MATCH", "CONVERGED_ABSENCE"].includes(classification)) return { plannedAction: "update_provenance", requiredAuthority: "none" };
  if (["NEW_ASSET", "NEW_COMPANION"].includes(classification)) return { plannedAction: "add_canonical", requiredAuthority: "none" };
  if (classification === "ARCHIVE_OMISSION") return { plannedAction: "retain", requiredAuthority: "none" };
  if (["RENAMED", "COMPANION_RENAMED"].includes(classification)) return { plannedAction: "rename", requiredAuthority: "rename" };
  return { plannedAction: "remove", requiredAuthority: "remove" };
}

function filesEqual(left: CanonicalTree, right: CanonicalTree): boolean {
  if (left.size !== right.size) return false;
  for (const [path, bytes] of left) {
    const other = right.get(path);
    if (other === undefined || !Buffer.from(bytes).equals(Buffer.from(other))) return false;
  }
  return true;
}

function validateProposedTree(files: CanonicalTree): void {
  const projectBytes = files.get(".tfsb/project.toml");
  if (projectBytes === undefined) throw new Error("Proposed tree lacks project.toml.");
  const project = unwrap(parseProjectToml(Buffer.from(projectBytes).toString("utf8"), ".tfsb/project.toml"));
  validateProjectPathLayout(project);
  const ids = new Set<string>();
  const filenames = new Set<string>();
  const companionFiles = new Set<string>();
  const portablePaths = new Map<string, string>();
  for (const [path, bytes] of files) {
    const portable = path.normalize("NFC").replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    const previous = portablePaths.get(portable);
    if (previous !== undefined && previous !== path) {
      fail(context(), "RECONCILE_COLLISION", `Proposed paths '${previous}' and '${path}' collide portably.`, path);
    }
    portablePaths.set(portable, path);
    if (path.startsWith(".tfsb/assets/")) {
      const asset = unwrap(parseAssetToml(Buffer.from(bytes).toString("utf8"), path));
      if (path !== `.tfsb/assets/${asset.id}.toml` || ids.has(asset.id) || filenames.has(asset.filename)) {
        fail(context(), "RECONCILE_COLLISION", "Proposed canonical asset identity collides.", path);
      }
      ids.add(asset.id);
      filenames.add(asset.filename);
    } else if (path.startsWith(".tfsb/companions/")) {
      const name = path.slice(".tfsb/companions/".length);
      if (name.includes("/") || !isAllowedCompanionFilename(name)) {
        fail(context(), "PROJECT_UNSUPPORTED_SOURCE", `Unsupported proposed companion '${path}'.`, path);
      }
      companionFiles.add(name);
    } else if (path !== ".tfsb/project.toml" && path !== ".tfsb/provenance.json") {
      fail(context(), "PROJECT_UNSUPPORTED_SOURCE", `Unsupported proposed canonical path '${path}'.`, path);
    }
  }
  if (ids.size > 128) fail(context(), "RESOURCE_LIMIT_EXCEEDED", "Complete next canonical project exceeds 128 assets.");
  for (const install of project.installs) {
    if (!ids.has(install.asset)) fail(context(), "PROJECT_UNKNOWN_INSTALL_ASSET", `Install rule refers to unknown asset '${install.asset}'.`);
  }
  for (const companion of project.companions) {
    if (!companionFiles.has(companion.file)) fail(context(), "PROJECT_UNKNOWN_COMPANION", `Companion rule refers to unknown file '${companion.file}'.`);
  }
  const provenanceBytes = files.get(".tfsb/provenance.json");
  if (provenanceBytes !== undefined) {
    unwrapProvenance(parseImportProvenance(Buffer.from(provenanceBytes).toString("utf8"), ".tfsb/provenance.json"));
  }
}

async function planReconciliationInternal(
  options: ReconcileOptions,
  hooks: ReconciliationPlanningHooks,
): Promise<ReconciliationPlan> {
  const ctx = context();
  const root = await findProjectRoot(options.root, "reconcile", options.root !== undefined);
  const canonicalSnapshot = await snapshotCanonicalTree(root);
  await hooks.afterCanonicalSnapshot?.();
  const project = await loadCanonicalProjectFromSnapshot(canonicalSnapshot, "reconcile");
  if (project.project.schemaVersion === 2) {
    const material = await planSchema2Reconciliation(project, options);
    const publicRecords = Object.freeze(material.records.map((record) => Object.freeze(record)));
    const plan: ReconciliationPlan = Object.freeze({ records: publicRecords, changed: material.changed, pending: material.pending, blocked: material.blocked, ...(material.normalizationPolicy === undefined ? {} : { normalizationPolicy: Object.freeze(material.normalizationPolicy), normalizationLedger: Object.freeze({ schemaVersion: 1 as const, entries: Object.freeze(material.normalizationLedger!.entries.map((entry) => Object.freeze(entry))) }) }), [planBrand]: true as const });
    reconciliationPlanInternals.set(plan, { root, nextFiles: material.nextFiles, canonicalSnapshot, archiveSnapshot: material.archiveSnapshot, changed: material.changed, pending: material.pending, blocked: material.blocked, ...(material.verifyExternalState === undefined ? {} : { verifyExternalState: material.verifyExternalState }) });
    return plan;
  }
  const provenanceBytes = canonicalSnapshot.files.get(".tfsb/provenance.json")?.bytes;
  const provenance: ImportProvenanceV1 = provenanceBytes === undefined
    ? { kind: "tfsb-import-provenance", schemaVersion: 1, records: [] }
    : unwrapProvenance(parseImportProvenance(Buffer.from(provenanceBytes).toString("utf8"), ".tfsb/provenance.json"));

  const resolutions = parseAssignments(options.resolutions ?? [], "--resolve", ["canonical", "archive"]);
  const renames = parseAssignments(options.renames ?? [], "--rename");
  const companionRenames = parseAssignments(options.companionRenames ?? [], "--rename-companion");
  const removals = parseNames(options.removals ?? [], "--remove");
  const companionRemovals = parseNames(options.companionRemovals ?? [], "--remove-companion");
  for (const key of renames.keys()) if (removals.has(key)) fail(ctx, "RECONCILE_CONTRADICTORY_DIRECTIVE", `Asset '${key}' is both renamed and removed.`, key);
  for (const key of companionRenames.keys()) if (companionRemovals.has(key)) fail(ctx, "RECONCILE_CONTRADICTORY_DIRECTIVE", `Companion '${key}' is both renamed and removed.`, key);
  for (const key of [...renames.keys(), ...removals]) {
    if (resolutions.has(key)) fail(ctx, "RECONCILE_CONTRADICTORY_DIRECTIVE", `Asset '${key}' has contradictory authority directives.`, key);
  }
  for (const key of [...companionRenames.keys(), ...companionRemovals].map((name) => `companion:${name}`)) {
    if (resolutions.has(key)) fail(ctx, "RECONCILE_CONTRADICTORY_DIRECTIVE", `Companion '${key}' has contradictory authority directives.`, key);
  }

  const assetProvenance = new Map<string, AssetProvenanceRecordV1>();
  const companionProvenance = new Map<string, CompanionProvenanceRecordV1>();
  const assetProvenanceByEntry = new Map<string, AssetProvenanceRecordV1>();
  const companionProvenanceByEntry = new Map<string, CompanionProvenanceRecordV1>();
  for (const item of provenance.records) {
    if (item.type === "asset") {
      assetProvenance.set(item.assetId, item);
      assetProvenanceByEntry.set(item.entryName, item);
    } else {
      companionProvenance.set(companionFilename(item.canonicalPath), item);
      companionProvenanceByEntry.set(item.entryName, item);
    }
  }
  const filtered = (options.selections?.length ?? 0) > 0 || (options.companions?.length ?? 0) > 0;
  const svgSelections = new Set(options.selections ?? []);
  const companionSelections = new Set(options.companions ?? []);
  for (const entry of renames.values()) svgSelections.add(entry);
  for (const entry of companionRenames.values()) companionSelections.add(entry);
  const archive = await readArchive(
    options.archive,
    [...svgSelections],
    [...companionSelections],
    { selectAllSvgs: !filtered, selectAllCompanions: !filtered, allowNoSvgs: true, operation: "reconcile" },
  );

  const candidatesByEntry = new Map<string, CandidateAsset>();
  const candidatesById = new Map<string, CandidateAsset>();
  for (const entry of archive.svgs) {
    const tracked = assetProvenanceByEntry.get(entry.entryName);
    const identity: { id: AssetId; filename: SvgFilename } = tracked !== undefined
      ? {
          id: tracked.assetId as AssetId,
          filename: (entry.entryName.split("/").pop() ?? entry.entryName) as SvgFilename,
        }
      : deriveAssetIdentity(entry.entryName, ctx);
    let text: string;
    try {
      text = new TextDecoder("utf8", { fatal: true }).decode(entry.bytes);
    } catch {
      fail(ctx, "ARCHIVE_INVALID_UTF8", `Selected SVG '${entry.entryName}' is not valid UTF-8.`, entry.entryName);
    }
    const asset: NormalizedAsset = { schemaVersion: 1, ...identity, svg: unwrap(parseSvg(text, entry.entryName)) };
    const serialized = serializeAssetToml(asset);
    const reparsed = unwrap(parseAssetToml(serialized, entry.entryName));
    if (!isDeepStrictEqual(asset, reparsed)) throw new Error("Candidate asset failed canonical round-trip.");
    const candidate = { entry, asset, toml: Buffer.from(serialized, "utf8"), modelDigest: computeAssetSemanticDigest(asset), entryDigest: computeSha256(entry.bytes) };
    const previous = candidatesById.get(asset.id);
    if (previous !== undefined) fail(ctx, "ARCHIVE_COLLISION", `Entries '${previous.entry.entryName}' and '${entry.entryName}' derive the same asset id.`, entry.entryName);
    candidatesByEntry.set(entry.entryName, candidate);
    candidatesById.set(asset.id, candidate);
  }
  const candidateCompanionsByEntry = new Map<string, CandidateCompanion>();
  const candidateCompanionsByFilename = new Map<string, CandidateCompanion>();
  for (const entry of archive.companions) {
    const tracked = companionProvenanceByEntry.get(entry.entryName);
    const filename = tracked !== undefined ? companionFilename(tracked.canonicalPath) : entry.filename;
    const candidate = { entry: { ...entry, filename }, digest: computeCompanionByteDigest(entry.bytes) };
    candidateCompanionsByEntry.set(entry.entryName, candidate);
    candidateCompanionsByFilename.set(filename, candidate);
  }

  const currentAssets = new Map<string, NormalizedAsset>();
  for (const asset of project.assets) {
    if (asset.schemaVersion !== 1) throw new Error("Schema homogeneity was lost after reconcile dispatch.");
    currentAssets.set(asset.id, asset);
  }
  const currentAssetDigests = new Map<string, Sha256Digest>(project.assets.map((asset) => [asset.id, computeAssetSemanticDigest(asset)]));
  const nextFiles = new Map<string, Uint8Array>([...canonicalSnapshot.files].map(([path, file]) => [path, file.bytes]));
  const nextProvenance = new Map<string, ProvenanceRecordV1>();
  for (const item of provenance.records) nextProvenance.set(item.type === "asset" ? assetRecordKey(item.assetId) : companionRecordKey(companionFilename(item.canonicalPath)), item);
  const consumedAssets = new Set<string>();
  const consumedCompanions = new Set<string>();
  const records: ReconciliationRecord[] = [];
  let nextProject: NormalizedProject = project.project;
  let policyChanged = false;

  const addRecord = (key: string, kind: "asset" | "companion", classification: ReconciliationClassification, resolved?: string) => {
    const base = actionFor(classification, key);
    const blocker = resolved === undefined ? base.blocker : false;
    records.push({
      key, kind, classification,
      action: resolved === undefined ? base.action : `accept explicit ${resolved} resolution`,
      blocker,
      ...machineActionFor(classification, blocker),
    });
  };

  for (const [oldId, entryName] of renames) {
    const current = currentAssets.get(oldId);
    const candidate = candidatesByEntry.get(entryName);
    if (current === undefined || candidate === undefined) fail(ctx, "RECONCILE_UNKNOWN_RENAME", `Rename '${oldId}=${entryName}' is not in active scope.`, oldId);
    if (candidate.asset.id !== oldId && (currentAssets.has(candidate.asset.id) || assetProvenance.has(candidate.asset.id))) fail(ctx, "RECONCILE_COLLISION", `Rename target '${candidate.asset.id}' already exists or is tracked.`, candidate.asset.id);
    if (consumedAssets.has(entryName)) fail(ctx, "RECONCILE_CONTRADICTORY_DIRECTIVE", `Archive entry '${entryName}' is mapped more than once.`, entryName);
    consumedAssets.add(entryName);
    nextFiles.delete(`.tfsb/assets/${oldId}.toml`);
    nextFiles.set(`.tfsb/assets/${candidate.asset.id}.toml`, candidate.toml);
    nextProvenance.delete(assetRecordKey(oldId));
    nextProvenance.set(assetRecordKey(candidate.asset.id), alignedAssetRecord(candidate, archive.archiveDigest));
    nextProject = {
      ...nextProject,
      installs: nextProject.installs.map((install) => install.asset === oldId
        ? { ...install, asset: candidate.asset.id }
        : install),
    };
    policyChanged ||= nextProject.installs.some((install, index) => install !== project.project.installs[index]);
    addRecord(oldId, "asset", "RENAMED");
  }

  for (const [oldFilename, entryName] of companionRenames) {
    const current = project.companions.get(oldFilename);
    const candidate = candidateCompanionsByEntry.get(entryName);
    if (current === undefined || candidate === undefined) fail(ctx, "RECONCILE_UNKNOWN_RENAME", `Companion rename '${oldFilename}=${entryName}' is not in active scope.`, oldFilename);
    if (candidate.entry.filename !== oldFilename && (project.companions.has(candidate.entry.filename) || companionProvenance.has(candidate.entry.filename))) fail(ctx, "RECONCILE_COLLISION", `Companion rename target '${candidate.entry.filename}' already exists or is tracked.`, candidate.entry.filename);
    if (consumedCompanions.has(entryName)) fail(ctx, "RECONCILE_CONTRADICTORY_DIRECTIVE", `Archive companion '${entryName}' is mapped more than once.`, entryName);
    consumedCompanions.add(entryName);
    nextFiles.delete(`.tfsb/companions/${oldFilename}`);
    nextFiles.set(`.tfsb/companions/${candidate.entry.filename}`, candidate.entry.bytes);
    nextProvenance.delete(companionRecordKey(oldFilename));
    nextProvenance.set(companionRecordKey(candidate.entry.filename), alignedCompanionRecord(candidate, archive.archiveDigest));
    const hasPolicy = nextProject.companions.some((declaration) => declaration.file === oldFilename);
    nextProject = {
      ...nextProject,
      companions: nextProject.companions.map((declaration) => declaration.file === oldFilename
        ? { ...declaration, file: candidate.entry.filename as ProjectRelativePath }
        : declaration),
    };
    policyChanged ||= hasPolicy;
    addRecord(`companion:${oldFilename}`, "companion", "COMPANION_RENAMED");
  }

  const allAssetIds = new Set([...currentAssets.keys(), ...assetProvenance.keys()]);
  for (const id of [...allAssetIds].sort(compareUtf8)) {
    if (renames.has(id)) continue;
    const current = currentAssets.get(id);
    const prior = assetProvenance.get(id);
    const candidate = prior === undefined ? candidatesById.get(id) : candidatesByEntry.get(prior.entryName);
    const active = !filtered || candidate !== undefined || removals.has(id) || (prior !== undefined && svgSelections.has(prior.entryName));
    if (!active) continue;
    if (candidate !== undefined) consumedAssets.add(candidate.entry.entryName);
    const key = id;
    if (removals.has(id)) {
      nextFiles.delete(`.tfsb/assets/${id}.toml`);
      nextProject = { ...nextProject, installs: nextProject.installs.filter((install) => install.asset !== id) };
      policyChanged ||= nextProject.installs.length !== project.project.installs.length;
      const tombstone = canonicalAssetRecord(candidate, undefined, archive.archiveDigest, prior);
      if (tombstone === undefined || candidate === undefined) nextProvenance.delete(assetRecordKey(id));
      else nextProvenance.set(assetRecordKey(id), tombstone);
      addRecord(key, "asset", "REMOVED");
      continue;
    }
    const recorded = recordedAsset(prior);
    const currentDigest = currentAssetDigests.get(id);
    const classification = classifyPairedCheckpoint({
      ...(recorded === undefined ? {} : { recorded }),
      ...(currentDigest === undefined ? {} : { currentCanonicalDigest: currentDigest }),
      ...(candidate === undefined ? {} : { candidateArchiveDigest: candidate.modelDigest }),
    });
    const direction = resolutions.get(key);
    if (direction !== undefined) {
      if (direction === "archive") {
        if (candidate === undefined) fail(ctx, "RECONCILE_INVALID_RESOLUTION", `Archive resolution for '${key}' has no candidate.`, key);
        nextFiles.set(`.tfsb/assets/${candidate.asset.id}.toml`, candidate.toml);
        nextProvenance.set(assetRecordKey(candidate.asset.id), alignedAssetRecord(candidate, archive.archiveDigest));
      } else {
        const accepted = canonicalAssetRecord(candidate, currentAssetDigests.get(id), archive.archiveDigest, prior);
        if (accepted === undefined) nextProvenance.delete(assetRecordKey(id));
        else nextProvenance.set(assetRecordKey(id), accepted);
      }
      resolutions.delete(key);
      addRecord(key, "asset", classification, direction);
      continue;
    }
    if (classification === "ARCHIVE_CHANGED" || classification === "CONVERGED") {
      if (candidate === undefined) throw new Error("Archive-backed classification lacks candidate.");
      if (classification === "ARCHIVE_CHANGED") nextFiles.set(`.tfsb/assets/${id}.toml`, candidate.toml);
      nextProvenance.set(assetRecordKey(id), alignedAssetRecord(candidate, archive.archiveDigest));
    } else if (classification === "UNTRACKED_MATCH") {
      if (candidate === undefined) throw new Error("Untracked match lacks candidate.");
      nextProvenance.set(assetRecordKey(id), alignedAssetRecord(candidate, archive.archiveDigest));
    } else if (classification === "CONVERGED_ABSENCE") {
      nextProvenance.delete(assetRecordKey(id));
    }
    addRecord(key, "asset", classification);
  }

  for (const candidate of [...candidatesByEntry.values()].sort((left, right) => compareUtf8(left.entry.entryName, right.entry.entryName))) {
    if (consumedAssets.has(candidate.entry.entryName)) continue;
    if (currentAssets.has(candidate.asset.id)) {
      records.push({
        key: candidate.asset.id,
        kind: "asset",
        classification: "NEW_ASSET",
        action: `candidate identity collides with canonical state; use --rename ${candidate.asset.id}=${candidate.entry.entryName}`,
        blocker: true,
        plannedAction: "blocked_collision",
        requiredAuthority: "rename",
      });
      continue;
    }
    if (nextFiles.has(`.tfsb/assets/${candidate.asset.id}.toml`)) {
      fail(ctx, "RECONCILE_COLLISION", `New candidate '${candidate.entry.entryName}' collides with the proposed canonical tree.`, candidate.entry.entryName);
    }
    nextFiles.set(`.tfsb/assets/${candidate.asset.id}.toml`, candidate.toml);
    nextProvenance.set(assetRecordKey(candidate.asset.id), alignedAssetRecord(candidate, archive.archiveDigest));
    addRecord(candidate.asset.id, "asset", "NEW_ASSET");
  }

  const currentCompanions = project.companions;
  const allCompanionNames = new Set([...currentCompanions.keys(), ...companionProvenance.keys()]);
  for (const filename of [...allCompanionNames].sort(compareUtf8)) {
    if (companionRenames.has(filename)) continue;
    const current = currentCompanions.get(filename);
    const currentDigest = current === undefined ? undefined : computeCompanionByteDigest(current);
    const prior = companionProvenance.get(filename);
    const candidate = prior === undefined ? candidateCompanionsByFilename.get(filename) : candidateCompanionsByEntry.get(prior.entryName);
    const active = !filtered || candidate !== undefined || companionRemovals.has(filename) || (prior !== undefined && companionSelections.has(prior.entryName));
    if (!active) continue;
    if (candidate !== undefined) consumedCompanions.add(candidate.entry.entryName);
    const key = `companion:${filename}`;
    if (companionRemovals.has(filename)) {
      nextFiles.delete(`.tfsb/companions/${filename}`);
      nextProject = { ...nextProject, companions: nextProject.companions.filter((item) => item.file !== filename) };
      policyChanged ||= nextProject.companions.length !== project.project.companions.length;
      const tombstone = canonicalCompanionRecord(candidate, filename, undefined, archive.archiveDigest, prior);
      if (tombstone === undefined || candidate === undefined) nextProvenance.delete(companionRecordKey(filename));
      else nextProvenance.set(companionRecordKey(filename), tombstone);
      addRecord(key, "companion", "COMPANION_REMOVED");
      continue;
    }
    const recorded = recordedCompanion(prior);
    const baseClassification = classifyPairedCheckpoint({
      ...(recorded === undefined ? {} : { recorded }),
      ...(currentDigest === undefined ? {} : { currentCanonicalDigest: currentDigest }),
      ...(candidate === undefined ? {} : { candidateArchiveDigest: candidate.digest }),
    });
    const classification: ReconciliationClassification = baseClassification === "ARCHIVE_CHANGED" ? "COMPANION_CHANGED" : baseClassification;
    const direction = resolutions.get(key);
    if (direction !== undefined) {
      if (direction === "archive") {
        if (candidate === undefined) fail(ctx, "RECONCILE_INVALID_RESOLUTION", `Archive resolution for '${key}' has no candidate.`, key);
        nextFiles.set(`.tfsb/companions/${candidate.entry.filename}`, candidate.entry.bytes);
        nextProvenance.set(companionRecordKey(candidate.entry.filename), alignedCompanionRecord(candidate, archive.archiveDigest));
      } else {
        const accepted = canonicalCompanionRecord(candidate, filename, currentDigest, archive.archiveDigest, prior);
        if (accepted === undefined) nextProvenance.delete(companionRecordKey(filename));
        else nextProvenance.set(companionRecordKey(filename), accepted);
      }
      resolutions.delete(key);
      addRecord(key, "companion", classification, direction);
      continue;
    }
    if (classification === "COMPANION_CHANGED" || classification === "CONVERGED") {
      if (candidate === undefined) throw new Error("Companion classification lacks candidate.");
      if (classification === "COMPANION_CHANGED") nextFiles.set(`.tfsb/companions/${filename}`, candidate.entry.bytes);
      nextProvenance.set(companionRecordKey(filename), alignedCompanionRecord(candidate, archive.archiveDigest));
    } else if (classification === "UNTRACKED_MATCH") {
      if (candidate === undefined) throw new Error("Untracked companion match lacks candidate.");
      nextProvenance.set(companionRecordKey(filename), alignedCompanionRecord(candidate, archive.archiveDigest));
    } else if (classification === "CONVERGED_ABSENCE") nextProvenance.delete(companionRecordKey(filename));
    addRecord(key, "companion", classification);
  }

  for (const candidate of [...candidateCompanionsByEntry.values()].sort((left, right) => compareUtf8(left.entry.entryName, right.entry.entryName))) {
    if (consumedCompanions.has(candidate.entry.entryName)) continue;
    if (currentCompanions.has(candidate.entry.filename) || nextFiles.has(`.tfsb/companions/${candidate.entry.filename}`)) {
      fail(ctx, "RECONCILE_COLLISION", `New companion '${candidate.entry.entryName}' collides with canonical companion.`, candidate.entry.entryName);
    }
    nextFiles.set(`.tfsb/companions/${candidate.entry.filename}`, candidate.entry.bytes);
    nextProvenance.set(companionRecordKey(candidate.entry.filename), alignedCompanionRecord(candidate, archive.archiveDigest));
    addRecord(`companion:${candidate.entry.filename}`, "companion", "NEW_COMPANION");
  }

  if (resolutions.size > 0) fail(ctx, "RECONCILE_UNKNOWN_RESOLUTION", `Resolution key '${resolutions.keys().next().value}' is unknown or out of scope.`);
  for (const id of removals) if (!records.some((item) => item.kind === "asset" && item.key === id && item.classification === "REMOVED")) fail(ctx, "RECONCILE_UNKNOWN_REMOVAL", `Removal asset '${id}' is unknown.`, id);
  for (const filename of companionRemovals) if (!records.some((item) => item.key === `companion:${filename}` && item.classification === "COMPANION_REMOVED")) fail(ctx, "RECONCILE_UNKNOWN_REMOVAL", `Removal companion '${filename}' is unknown.`, filename);

  const assetCount = [...nextFiles.keys()].filter((path) => path.startsWith(".tfsb/assets/")).length;
  if (assetCount > 128) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Complete next canonical project exceeds 128 assets.");
  if (policyChanged) nextFiles.set(".tfsb/project.toml", Buffer.from(serializeProjectToml(nextProject), "utf8"));
  const provenanceDocument: ImportProvenanceV1 = { kind: "tfsb-import-provenance", schemaVersion: 1, records: [...nextProvenance.values()] };
  if (provenanceDocument.records.length === 0) nextFiles.delete(".tfsb/provenance.json");
  else {
    const rendered = serializeImportProvenance(provenanceDocument);
    const changedRecord = serializeImportProvenance(provenance) !== rendered;
    if (changedRecord || provenanceBytes === undefined) nextFiles.set(".tfsb/provenance.json", Buffer.from(rendered, "utf8"));
  }
  validateProposedTree(nextFiles);
  records.sort((left, right) => compareUtf8(left.key, right.key));
  const currentFiles = new Map([...canonicalSnapshot.files].map(([path, file]) => [path, file.bytes]));
  const changed = !filesEqual(currentFiles, nextFiles);
  const pending = records.some((item) => !["UNCHANGED", "UNCHANGED_ACCEPTED_DIVERGENCE", "UNCHANGED_ACCEPTED_ABSENCE"].includes(item.classification));
  const blocked = records.some((item) => item.blocker);
  let currentSnapshot: CanonicalSnapshot;
  try {
    currentSnapshot = await snapshotCanonicalTree(root);
  } catch (error) {
    if (error instanceof DiagnosticError) {
      fail(ctx, "CANONICAL_CHANGED_DURING_PLAN", "Canonical tree changed during reconciliation planning.");
    }
    throw error;
  }
  if (!snapshotsEqual(canonicalSnapshot, currentSnapshot)) {
    fail(ctx, "CANONICAL_CHANGED_DURING_PLAN", "Canonical tree changed during reconciliation planning.");
  }
  const publicRecords = Object.freeze(records.map((record) => Object.freeze(record)));
  const plan: ReconciliationPlan = Object.freeze({ records: publicRecords, changed, pending, blocked, [planBrand]: true as const });
  reconciliationPlanInternals.set(plan, { root, nextFiles, canonicalSnapshot, archiveSnapshot: archive.snapshot, changed, pending, blocked });
  return plan;
}

export async function planReconciliation(options: ReconcileOptions): Promise<ReconciliationPlan> {
  return planReconciliationInternal(options, {});
}

/** Internal deterministic seam for concurrency tests; not re-exported by the package root. */
export async function planReconciliationWithHooks(
  options: ReconcileOptions,
  hooks: ReconciliationPlanningHooks,
): Promise<ReconciliationPlan> {
  return planReconciliationInternal(options, hooks);
}

function requirePlanInternals(plan: ReconciliationPlan): ReconciliationPlanInternals {
  const internals = reconciliationPlanInternals.get(plan);
  if (internals === undefined) fail(context(), "RECONCILE_INVALID_PLAN", "Reconciliation plan was not produced by this planner instance.");
  return internals;
}

export async function executeReconciliationPlan(plan: ReconciliationPlan): Promise<void> {
  const internals = requirePlanInternals(plan);
  if (internals.blocked) fail(context(), "RECONCILE_UNRESOLVED", "One unresolved record blocks the complete reconciliation apply.");
  if (!internals.changed) return;
  await executeCanonicalTransaction({
    root: internals.root, nextFiles: internals.nextFiles, expectedSnapshot: internals.canonicalSnapshot,
    archiveSnapshot: internals.archiveSnapshot,
    ...(internals.verifyExternalState === undefined ? {} : { verifyExternalState: internals.verifyExternalState }),
  });
}

export async function reconcileProject(options: ReconcileOptions): Promise<ReconciliationResult> {
  const plan = await planReconciliation(options);
  const internals = requirePlanInternals(plan);
  let applied = false;
  if (options.apply === true && !internals.blocked) {
    await executeReconciliationPlan(plan);
    applied = internals.changed;
  }
  return { records: plan.records, changed: plan.changed, pending: plan.pending, blocked: plan.blocked, applied, ...(plan.normalizationPolicy === undefined ? {} : { normalizationPolicy: plan.normalizationPolicy, normalizationLedger: plan.normalizationLedger! }) };
}
