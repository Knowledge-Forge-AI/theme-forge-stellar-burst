import { readArchive, readManifestArchive } from "./archive.js";
import { inspectBuildSnapshot } from "./build.js";
import { computeAssetSemanticDigest, computeCompanionByteDigest, computePathTextDigest, computeRawSha256, type Sha256Digest } from "./digests.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import { deriveAssetIdentity } from "./importer.js";
import { optionalLstat, readRegularFileSnapshot } from "./filesystem.js";
import { loadCanonicalProject, verifyLoadedProjectSnapshot, type LoadedProject } from "./project.js";
import { compareUtf8, parseImportProvenance, unwrapProvenance, type ImportProvenanceV1, type ProvenanceRecordV1 } from "./provenance.js";
import { parseImportProvenanceV2, unwrapProvenanceV2, type ProvenanceRecordV2 } from "./provenance2.js";
import { BUILD_RECEIPT_FILENAME, type BuildReceiptProjectPolicyV3 } from "./receipt.js";
import { findProjectRoot } from "./root.js";
import type { AnyNormalizedAsset } from "./schema-dispatch.js";
import { parseSvgV2 } from "./schema2-svg.js";
import { parseAssetTomlV2 } from "./schema2-toml.js";
import type { ArtworkElementV2, SvgDocumentV2 } from "./schema2-types.js";
import { planSchema2Reconciliation } from "./reconcile2.js";
import { parseSvg } from "./svg.js";
import type { ArtworkElement, AssetId, NormalizedAsset, Result, SvgDocument } from "./types.js";

export type DiffBaseline = "provenance" | "archive" | "build" | "install";

export type ProvenanceRelation = "aligned" | "accepted_divergence" | "accepted_absence" | "canonical_changed_since_decision" | "canonical_missing" | "untracked_current_record" | "stale_tracked_record" | "checkpoint_convergence";
export interface ProvenanceDiffRecord {
  readonly key: string;
  readonly kind: "asset" | "companion";
  readonly currentPresent: boolean;
  readonly currentDigest?: Sha256Digest;
  readonly acceptedCanonicalPresent?: boolean;
  readonly acceptedCanonicalDigest?: Sha256Digest;
  readonly acceptedArchiveDigest?: Sha256Digest;
  readonly priorResolution?: "aligned" | "canonical";
  readonly relation: ProvenanceRelation;
}
export interface ProvenanceDiffResult { readonly baseline: "provenance"; readonly records: readonly ProvenanceDiffRecord[]; readonly different: boolean; }

export type ArchiveChangeCategory = "canvas" | "accessibility" | "metadata" | "gradient" | "gradient_stop" | "definition" | "artwork_element" | "presentation" | "transform" | "path_geometry" | "companion" | "asset_identity" | "asset_addition_removal";
export type DiffScalar = string | number | boolean | null | readonly number[];
export interface PathTextChange {
  readonly basis: "tfsb-path-text-v1";
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
  readonly beforeLength?: number;
  readonly afterLength?: number;
  readonly beforePrefix?: string;
  readonly beforeSuffix?: string;
  readonly afterPrefix?: string;
  readonly afterSuffix?: string;
}
export interface ArchiveSemanticChange {
  readonly key: string;
  readonly category: ArchiveChangeCategory;
  readonly location: string;
  readonly changeType: "added" | "removed" | "changed";
  readonly before?: DiffScalar;
  readonly after?: DiffScalar;
  readonly pathText?: PathTextChange;
  readonly diagnosticCode?: string;
}
export interface ArchiveSourceRelation {
  readonly key: string;
  readonly rawRelation: "unchanged" | "changed" | "new" | "omitted" | "conflict" | "untracked";
  readonly normalizationRelation: "direct" | "normalized" | "accepted_migration_divergence" | "authority_required" | "not_applicable";
  readonly semanticComparison: "unchanged" | "changed" | "unavailable";
}
export interface ArchiveDiffResult { readonly baseline: "archive"; readonly assets: readonly string[]; readonly companions: readonly string[]; readonly changes: readonly ArchiveSemanticChange[]; readonly sourceRelations?: readonly ArchiveSourceRelation[]; readonly different: boolean; }

export interface FileHashChange { readonly path: string; readonly changeType: "added" | "removed" | "changed"; readonly beforeSha256?: string; readonly afterSha256?: string; }
export interface PolicyChange { readonly kind: "build_directory" | "install_declaration" | "asset_destination" | "companion_declaration" | "companion_destination"; readonly key: string; readonly changeType: "added" | "removed" | "changed"; readonly destination?: string; readonly before?: string; readonly after?: string; }
export interface BuildDiffResult { readonly baseline: "build"; readonly canonicalSources: readonly FileHashChange[]; readonly outputs: readonly FileHashChange[]; readonly policyChanges: readonly PolicyChange[]; readonly different: boolean; }

export interface InstallDiffRecord { readonly key: string; readonly kind: "asset" | "companion"; readonly destination: string; readonly expectedKind: "svg" | "companion"; readonly state: "clean" | "missing" | "byte_different"; }
export interface InstallDiffResult { readonly baseline: "install"; readonly destinations: readonly InstallDiffRecord[]; readonly different: boolean; }
export type DiffResult = ProvenanceDiffResult | ArchiveDiffResult | BuildDiffResult | InstallDiffResult;
export interface DiffOptions { readonly root?: string; readonly baseline?: DiffBaseline; readonly archive?: string; }

function context(domain: DiagnosticContext["domain"] = "project"): DiagnosticContext { return { operation: "diff", domain }; }
function unwrap<T>(result: Result<T>): T { if (result.ok) return result.value; const first = result.diagnostics[0]; if (first === undefined) throw new Error("Diagnostic result was unexpectedly empty."); throw new DiagnosticError(first); }
function provenanceKey(record: ProvenanceRecordV1): string { return record.type === "asset" ? `asset:${record.assetId}` : `companion:${record.canonicalPath.slice(".tfsb/companions/".length)}`; }
function provenanceKeyV2(record: ProvenanceRecordV2): string { return record.type === "asset" ? `asset:${record.assetId}` : `companion:${record.canonicalPath.slice(".tfsb/companions/".length)}`; }

export async function diffProvenance(project: LoadedProject): Promise<ProvenanceDiffResult> {
  if (project.project.schemaVersion === 2) {
    const bytes = project.snapshot.files.get(".tfsb/provenance.json")?.bytes;
    const provenance = bytes === undefined
      ? { kind: "tfsb-import-provenance" as const, schemaVersion: 2 as const, records: [] }
      : unwrapProvenanceV2(parseImportProvenanceV2(Buffer.from(bytes).toString("utf8"), ".tfsb/provenance.json"));
    const recordsByKey = new Map(provenance.records.map((record) => [provenanceKeyV2(record), record]));
    const current = new Map<string, { kind: "asset" | "companion"; digest: Sha256Digest }>();
    for (const asset of project.assets) current.set(`asset:${asset.id}`, { kind: "asset", digest: computeAssetSemanticDigest(asset) });
    for (const [file, value] of project.companions) current.set(`companion:${file}`, { kind: "companion", digest: computeCompanionByteDigest(value) });
    const keys = [...new Set([...recordsByKey.keys(), ...current.keys()])].sort(compareUtf8);
    const records: ProvenanceDiffRecord[] = keys.map((key) => {
      const accepted = recordsByKey.get(key); const now = current.get(key);
      if (accepted === undefined) return { key, kind: now!.kind, currentPresent: true, currentDigest: now!.digest, relation: "untracked_current_record" };
      const archive = accepted.archive;
      const acceptedDigest = accepted.type === "asset" ? accepted.migration?.afterDigest ?? archive?.canonicalDigest ?? undefined : accepted.archive.canonicalDigest ?? undefined;
      const archiveComparable = archive !== null && archive !== undefined && archive.canonicalBasis === (accepted.type === "asset" ? "tfsb-asset-toml-v2" : "tfsb-companion-bytes-v1");
      let relation: ProvenanceRelation;
      if (now === undefined) relation = "canonical_missing";
      else if (acceptedDigest === undefined) relation = "untracked_current_record";
      else if (now.digest === acceptedDigest) relation = accepted.type === "asset" && accepted.migration !== null ? "accepted_divergence" : archive === null || archive === undefined || archive.archiveCanonicalDigest !== acceptedDigest ? "accepted_divergence" : "aligned";
      else if (archiveComparable && now.digest === archive!.archiveCanonicalDigest) relation = "checkpoint_convergence";
      else relation = "canonical_changed_since_decision";
      return {
        key,
        kind: accepted.type,
        currentPresent: now !== undefined,
        ...(now === undefined ? {} : { currentDigest: now.digest }),
        ...(acceptedDigest === undefined ? {} : { acceptedCanonicalPresent: true, acceptedCanonicalDigest: acceptedDigest }),
        ...(archive === null || archive === undefined || accepted.type === "asset" && accepted.migration !== null ? {} : { acceptedArchiveDigest: archive.archiveCanonicalDigest, priorResolution: archive.resolution }),
        relation,
      };
    });
    const result: ProvenanceDiffResult = { baseline: "provenance", records, different: records.some((record) => !["aligned", "accepted_divergence"].includes(record.relation)) };
    await verifyLoadedProjectSnapshot(project, "diff");
    return result;
  }
  const bytes = project.snapshot.files.get(".tfsb/provenance.json")?.bytes;
  const provenance: ImportProvenanceV1 = bytes === undefined ? { kind: "tfsb-import-provenance", schemaVersion: 1, records: [] } : unwrapProvenance(parseImportProvenance(Buffer.from(bytes).toString("utf8"), ".tfsb/provenance.json"));
  const recordsByKey = new Map(provenance.records.map((record) => [provenanceKey(record), record]));
  const current = new Map<string, { kind: "asset" | "companion"; digest: Sha256Digest }>();
  for (const asset of project.assets) current.set(`asset:${asset.id}`, { kind: "asset", digest: computeAssetSemanticDigest(asset) });
  for (const [file, value] of project.companions) current.set(`companion:${file}`, { kind: "companion", digest: computeCompanionByteDigest(value) });
  const keys = [...new Set([...recordsByKey.keys(), ...current.keys()])].sort(compareUtf8);
  const records: ProvenanceDiffRecord[] = keys.map((key) => {
    const accepted = recordsByKey.get(key);
    const now = current.get(key);
    if (accepted === undefined) return { key, kind: now!.kind, currentPresent: true, currentDigest: now!.digest, relation: "untracked_current_record" };
    const canonicalDigest = accepted.type === "asset" ? accepted.canonicalModelDigest : accepted.canonicalByteDigest;
    const archiveDigest = accepted.type === "asset" ? accepted.archiveModelDigest : accepted.archiveByteDigest;
    let relation: ProvenanceRelation;
    if (accepted.canonicalState === "absent") relation = now === undefined ? (accepted.resolution === "canonical" ? "accepted_absence" : "stale_tracked_record") : now.digest === archiveDigest ? "checkpoint_convergence" : "canonical_changed_since_decision";
    else if (now === undefined) relation = "canonical_missing";
    else if (now.digest === canonicalDigest) relation = canonicalDigest === archiveDigest ? "aligned" : "accepted_divergence";
    else if (now.digest === archiveDigest) relation = "checkpoint_convergence";
    else relation = "canonical_changed_since_decision";
    return {
      key, kind: accepted.type, currentPresent: now !== undefined,
      ...(now === undefined ? {} : { currentDigest: now.digest }),
      acceptedCanonicalPresent: accepted.canonicalState === "present",
      ...(canonicalDigest === undefined ? {} : { acceptedCanonicalDigest: canonicalDigest }),
      acceptedArchiveDigest: archiveDigest, priorResolution: accepted.resolution, relation,
    };
  });
  const result: ProvenanceDiffResult = { baseline: "provenance", records, different: records.some((record) => record.relation !== "aligned") };
  await verifyLoadedProjectSnapshot(project, "diff");
  return result;
}

interface CandidateArchive { readonly assets: ReadonlyMap<string, AnyNormalizedAsset>; readonly companions: ReadonlyMap<string, Uint8Array>; }
async function loadArchiveCandidates(project: LoadedProject, archivePath: string): Promise<CandidateArchive> {
  const provenanceBytes = project.snapshot.files.get(".tfsb/provenance.json")?.bytes;
  const provenance = provenanceBytes === undefined ? undefined : unwrapProvenance(parseImportProvenance(Buffer.from(provenanceBytes).toString("utf8"), ".tfsb/provenance.json"));
  const byEntry = new Map((provenance?.records ?? []).map((record) => [record.entryName, record]));
  let manifest: Awaited<ReturnType<typeof readManifestArchive>> | undefined;
  try { manifest = await readManifestArchive(archivePath, [], [], { allowNoSvgs: true, operation: "diff" }); }
  catch (error) { if (!(error instanceof DiagnosticError) || error.diagnostic.code !== "ARCHIVE_MANIFEST_MISSING") throw error; }
  const ordinary = manifest === undefined ? await readArchive(archivePath, [], [], { selectAllSvgs: true, selectAllCompanions: true, allowNoSvgs: true, operation: "diff" }) : undefined;
  const assets = new Map<string, AnyNormalizedAsset>();
  const assetEntries = manifest?.svgs ?? ordinary!.svgs;
  for (const entry of assetEntries) {
    const tracked = byEntry.get(entry.entryName);
    const currentId: AssetId = "assetId" in entry && typeof entry.assetId === "string" ? entry.assetId as AssetId : tracked?.type === "asset" ? tracked.assetId as AssetId : deriveAssetIdentity(entry.entryName, context("archive")).id;
    const filename = manifest === undefined
      ? deriveAssetIdentity(entry.entryName, context("archive")).filename
      : entry.entryName as NormalizedAsset["filename"];
    let text: string;
    try { text = new TextDecoder("utf8", { fatal: true }).decode(entry.bytes); }
    catch { fail(context("archive"), "ARCHIVE_INVALID_UTF8", `Selected SVG '${entry.entryName}' is not valid UTF-8.`, entry.entryName); }
    const asset: AnyNormalizedAsset = project.project.schemaVersion === 1
      ? { schemaVersion: 1, id: currentId, filename, svg: unwrap(parseSvg(text, entry.entryName)) }
      : { schemaVersion: 2, id: currentId, filename, svg: unwrap(parseSvgV2(text, entry.entryName)) };
    if (assets.has(asset.id)) fail(context("archive"), "ARCHIVE_COLLISION", `Archive contains duplicate asset identity '${asset.id}'.`, entry.entryName);
    assets.set(asset.id, asset);
  }
  const companions = new Map<string, Uint8Array>();
  for (const entry of manifest?.companions ?? ordinary!.companions) {
    const tracked = byEntry.get(entry.entryName);
    const file = tracked?.type === "companion" ? tracked.canonicalPath.slice(".tfsb/companions/".length) : entry.filename;
    if (companions.has(file)) fail(context("archive"), "ARCHIVE_COLLISION", `Archive contains duplicate companion identity '${file}'.`, entry.entryName);
    companions.set(file, entry.bytes);
  }
  return { assets, companions };
}

interface FlatField { readonly category: ArchiveChangeCategory; readonly location: string; readonly value: DiffScalar; readonly pathText?: string; }
const PRESENTATION = new Set(["fill", "stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeMiterlimit", "opacity", "ariaHidden", "fillOpacity", "strokeOpacity", "fillRule", "clipRule"]);
function scalarFields(target: Map<string, FlatField>, base: string, value: unknown, defaultCategory: ArchiveChangeCategory): void {
  if (value === undefined) return;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const name = base.split(".").at(-1) ?? base;
    const presentation = PRESENTATION.has(name) || [...PRESENTATION].some((field) => base.includes(`.${field}.`));
    const category: ArchiveChangeCategory = name === "d" ? "path_geometry" : base.includes(".transform") ? "transform" : presentation ? "presentation" : defaultCategory;
    target.set(`${category}\0${base}`, { category, location: base, value, ...(name === "d" && typeof value === "string" ? { pathText: value } : {}) });
    return;
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "number")) target.set(`${defaultCategory}\0${base}`, { category: defaultCategory, location: base, value: value as readonly number[] });
    else value.forEach((item, index) => scalarFields(target, `${base}[${index}]`, item, base.includes(".stops") ? "gradient_stop" : defaultCategory));
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>).sort(compareUtf8)) scalarFields(target, `${base}.${key}`, (value as Record<string, unknown>)[key], defaultCategory);
}
function uniqueElementKeys(elements: readonly (ArtworkElement | ArtworkElementV2)[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const element of elements) if (element.id !== undefined) counts.set(element.id, (counts.get(element.id) ?? 0) + 1);
  return elements.map((element, index) => element.id !== undefined && counts.get(element.id) === 1 ? `id:${element.id}` : `position:${index}`);
}
function flattenSvg(svg: SvgDocument | SvgDocumentV2): Map<string, FlatField> {
  const fields = new Map<string, FlatField>();
  scalarFields(fields, "canvas", svg.canvas, "canvas");
  scalarFields(fields, "accessibility", svg.accessibility, "accessibility");
  if ("presentation" in svg) scalarFields(fields, "presentation", svg.presentation, "presentation");
  if (svg.metadataText !== undefined) scalarFields(fields, "metadata.text", svg.metadataText, "metadata");
  for (const gradient of svg.definitions.linearGradients) scalarFields(fields, `definitions.gradient[id:${gradient.id}]`, gradient, "gradient");
  for (const path of svg.definitions.paths) scalarFields(fields, `definitions.path[id:${path.id}]`, path, "definition");
  for (const group of svg.definitions.groups) scalarFields(fields, `definitions.group[id:${group.id}]`, group, "definition");
  if ("circles" in svg.definitions) {
    for (const kind of ["circles", "ellipses", "rects", "lines", "polylines", "polygons"] as const) {
      for (const value of svg.definitions[kind]) scalarFields(fields, `definitions.${kind}[id:${value.id}]`, value, "definition");
    }
  }
  const keys = uniqueElementKeys(svg.elements);
  svg.elements.forEach((element, index) => scalarFields(fields, `artwork[${keys[index]}]`, element, "artwork_element"));
  return fields;
}
function preview(text: string): { length: number; prefix: string; suffix: string } { const scalars = Array.from(text); return { length: scalars.length, prefix: scalars.slice(0, 64).join(""), suffix: scalars.slice(-64).join("") }; }
function compareAsset(id: string, before: AnyNormalizedAsset, after: AnyNormalizedAsset): ArchiveSemanticChange[] {
  const left = flattenSvg(before.svg); const right = flattenSvg(after.svg);
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort(compareUtf8);
  const changes: ArchiveSemanticChange[] = [];
  if (before.filename !== after.filename) {
    changes.push({ key: `asset:${id}`, category: "asset_identity", location: "filename", changeType: "changed", before: before.filename, after: after.filename });
  }
  for (const key of keys) {
    const a = left.get(key); const b = right.get(key);
    if (a !== undefined && b !== undefined && JSON.stringify(a.value) === JSON.stringify(b.value)) continue;
    const field = a ?? b!; const changeType = a === undefined ? "added" : b === undefined ? "removed" : "changed";
    let pathText: PathTextChange | undefined;
    if (a?.pathText !== undefined || b?.pathText !== undefined) {
      const ap = a?.pathText === undefined ? undefined : preview(a.pathText); const bp = b?.pathText === undefined ? undefined : preview(b.pathText);
      pathText = { basis: "tfsb-path-text-v1", ...(a?.pathText === undefined ? {} : { beforeSha256: computePathTextDigest(a.pathText), beforeLength: ap!.length, beforePrefix: ap!.prefix, beforeSuffix: ap!.suffix }), ...(b?.pathText === undefined ? {} : { afterSha256: computePathTextDigest(b.pathText), afterLength: bp!.length, afterPrefix: bp!.prefix, afterSuffix: bp!.suffix }) };
    }
    changes.push({ key: `asset:${id}`, category: field.category, location: field.location, changeType, ...(pathText === undefined ? { ...(a === undefined ? {} : { before: a.value }), ...(b === undefined ? {} : { after: b.value }) } : { pathText }) });
  }
  return changes;
}

export async function diffArchive(project: LoadedProject, archivePath: string): Promise<ArchiveDiffResult> {
  if (project.project.schemaVersion === 2) return diffArchiveV2(project, archivePath);
  const candidate = await loadArchiveCandidates(project, archivePath);
  const currentAssets = new Map<string, AnyNormalizedAsset>(project.assets.map((asset) => [asset.id, asset]));
  const changes: ArchiveSemanticChange[] = [];
  for (const id of [...new Set([...currentAssets.keys(), ...candidate.assets.keys()])].sort(compareUtf8)) {
    const before = currentAssets.get(id); const after = candidate.assets.get(id);
    if (before === undefined || after === undefined) changes.push({ key: `asset:${id}`, category: "asset_addition_removal", location: `asset:${id}`, changeType: before === undefined ? "added" : "removed" });
    else changes.push(...compareAsset(id, before, after));
  }
  for (const file of [...new Set([...project.companions.keys(), ...candidate.companions.keys()])].sort(compareUtf8)) {
    const before = project.companions.get(file); const after = candidate.companions.get(file);
    if (before !== undefined && after !== undefined && Buffer.from(before).equals(Buffer.from(after))) continue;
    changes.push({ key: `companion:${file}`, category: "companion", location: `.tfsb/companions/${file}`, changeType: before === undefined ? "added" : after === undefined ? "removed" : "changed", ...(before === undefined ? {} : { before: computeRawSha256(before) }), ...(after === undefined ? {} : { after: computeRawSha256(after) }) });
  }
  changes.sort((left, right) => compareUtf8(left.key, right.key) || compareUtf8(left.category, right.category) || compareUtf8(left.location, right.location) || compareUtf8(left.changeType, right.changeType) || compareUtf8(left.diagnosticCode ?? "", right.diagnosticCode ?? ""));
  const result: ArchiveDiffResult = { baseline: "archive", assets: [...candidate.assets.keys()].sort(compareUtf8), companions: [...candidate.companions.keys()].sort(compareUtf8), changes, different: changes.length > 0 };
  await verifyLoadedProjectSnapshot(project, "diff");
  return result;
}

async function diffArchiveV2(project: LoadedProject, archivePath: string): Promise<ArchiveDiffResult> {
  const provenanceBytes = project.snapshot.files.get(".tfsb/provenance.json")?.bytes;
  if (provenanceBytes === undefined) {
    const candidate = await loadArchiveCandidates(project, archivePath);
    const currentAssets = new Map<string, AnyNormalizedAsset>(project.assets.map((asset) => [asset.id, asset]));
    const changes: ArchiveSemanticChange[] = [];
    for (const id of [...new Set([...currentAssets.keys(), ...candidate.assets.keys()])].sort(compareUtf8)) {
      const before = currentAssets.get(id); const after = candidate.assets.get(id);
      if (before === undefined || after === undefined) changes.push({ key: `asset:${id}`, category: "asset_addition_removal", location: `asset:${id}`, changeType: before === undefined ? "added" : "removed" });
      else changes.push(...compareAsset(id, before, after));
    }
    for (const file of [...new Set([...project.companions.keys(), ...candidate.companions.keys()])].sort(compareUtf8)) {
      const before = project.companions.get(file); const after = candidate.companions.get(file);
      if (before !== undefined && after !== undefined && Buffer.from(before).equals(Buffer.from(after))) continue;
      changes.push({ key: `companion:${file}`, category: "companion", location: `.tfsb/companions/${file}`, changeType: before === undefined ? "added" : after === undefined ? "removed" : "changed", ...(before === undefined ? {} : { before: computeRawSha256(before) }), ...(after === undefined ? {} : { after: computeRawSha256(after) }) });
    }
    changes.sort((left, right) => compareUtf8(left.key, right.key) || compareUtf8(left.category, right.category) || compareUtf8(left.location, right.location));
    const sourceKeys = [...new Set([...candidate.assets.keys()].map((id) => `asset:${id}`).concat([...candidate.companions.keys()].map((file) => `companion:${file}`)))].sort(compareUtf8);
    const sourceRelations: ArchiveSourceRelation[] = sourceKeys.map((key) => ({ key, rawRelation: "untracked", normalizationRelation: key.startsWith("asset:") ? "direct" : "not_applicable", semanticComparison: changes.some((change) => change.key === key) ? "changed" : "unchanged" }));
    const result: ArchiveDiffResult = { baseline: "archive", assets: [...candidate.assets.keys()].sort(compareUtf8), companions: [...candidate.companions.keys()].sort(compareUtf8), changes, sourceRelations, different: changes.length > 0 };
    await verifyLoadedProjectSnapshot(project, "diff");
    return result;
  }
  const provenance = provenanceBytes === undefined ? undefined : unwrapProvenanceV2(parseImportProvenanceV2(Buffer.from(provenanceBytes).toString("utf8"), ".tfsb/provenance.json"));
  const normalizedKeys = new Set((provenance?.records ?? []).flatMap((record) => record.type === "asset" && record.normalizationPolicy !== null ? [`asset:${record.assetId}`] : []));
  const planned = await planSchema2Reconciliation(project, { archive: archivePath });
  const currentAssets = new Map<string, AnyNormalizedAsset>(project.assets.map((asset) => [asset.id, asset]));
  const candidateAssets = new Map<string, AnyNormalizedAsset>();
  for (const [path, bytes] of planned.nextFiles) {
    if (!path.startsWith(".tfsb/assets/")) continue;
    const parsed = unwrap(parseAssetTomlV2(Buffer.from(bytes).toString("utf8"), path));
    candidateAssets.set(parsed.id, parsed);
  }
  const sourceRelations: ArchiveSourceRelation[] = planned.records.map((record) => {
    const rawRelation: ArchiveSourceRelation["rawRelation"] = record.classification === "ARCHIVE_OMISSION" ? "omitted"
      : record.classification === "NEW_ASSET" || record.classification === "NEW_COMPANION" ? "new"
        : record.classification === "UNCHANGED" || record.classification === "UNCHANGED_ACCEPTED_DIVERGENCE" ? "unchanged"
          : record.classification === "CONFLICT" ? "conflict" : "changed";
    const normalizationRelation: ArchiveSourceRelation["normalizationRelation"] = record.classification === "POLICY_AUTHORITY_REQUIRED" ? "authority_required"
      : record.classification === "UNCHANGED_ACCEPTED_DIVERGENCE" ? "accepted_migration_divergence"
        : record.kind === "companion" ? "not_applicable"
          : normalizedKeys.has(record.key) ? "normalized" : "direct";
    const semanticComparison: ArchiveSourceRelation["semanticComparison"] = record.classification === "POLICY_AUTHORITY_REQUIRED" ? "unavailable"
      : ["UNCHANGED", "UNCHANGED_ACCEPTED_DIVERGENCE", "ARCHIVE_OMISSION"].includes(record.classification) ? "unchanged" : "changed";
    return { key: record.key, rawRelation, normalizationRelation, semanticComparison };
  }).sort((left, right) => compareUtf8(left.key, right.key));
  const unavailable = new Set(sourceRelations.filter((record) => record.semanticComparison === "unavailable").map((record) => record.key));
  const changes: ArchiveSemanticChange[] = [];
  for (const id of [...new Set([...currentAssets.keys(), ...candidateAssets.keys()])].sort(compareUtf8)) {
    if (unavailable.has(`asset:${id}`)) continue;
    const before = currentAssets.get(id); const after = candidateAssets.get(id);
    if (before === undefined || after === undefined) changes.push({ key: `asset:${id}`, category: "asset_addition_removal", location: `asset:${id}`, changeType: before === undefined ? "added" : "removed" });
    else changes.push(...compareAsset(id, before, after));
  }
  const candidateCompanions = new Map<string, Uint8Array>();
  for (const [path, bytes] of planned.nextFiles) if (path.startsWith(".tfsb/companions/")) candidateCompanions.set(path.slice(".tfsb/companions/".length), bytes);
  for (const file of [...new Set([...project.companions.keys(), ...candidateCompanions.keys()])].sort(compareUtf8)) {
    const before = project.companions.get(file); const after = candidateCompanions.get(file);
    if (before !== undefined && after !== undefined && Buffer.from(before).equals(Buffer.from(after))) continue;
    changes.push({ key: `companion:${file}`, category: "companion", location: `.tfsb/companions/${file}`, changeType: before === undefined ? "added" : after === undefined ? "removed" : "changed", ...(before === undefined ? {} : { before: computeRawSha256(before) }), ...(after === undefined ? {} : { after: computeRawSha256(after) }) });
  }
  changes.sort((left, right) => compareUtf8(left.key, right.key) || compareUtf8(left.category, right.category) || compareUtf8(left.location, right.location));
  const result: ArchiveDiffResult = {
    baseline: "archive",
    assets: [...new Set(planned.records.filter((record) => record.kind === "asset").map((record) => record.key.slice("asset:".length)))].sort(compareUtf8),
    companions: [...new Set(planned.records.filter((record) => record.kind === "companion").map((record) => record.key.slice("companion:".length)))].sort(compareUtf8),
    changes,
    sourceRelations,
    different: changes.length > 0 || sourceRelations.some((record) => record.rawRelation !== "unchanged" && record.rawRelation !== "omitted"),
  };
  await verifyLoadedProjectSnapshot(project, "diff");
  return result;
}

function hashChanges(current: Readonly<Record<string, string>>, baseline: Readonly<Record<string, string>>, prefix = ""): FileHashChange[] {
  const keys = [...new Set([...Object.keys(current), ...Object.keys(baseline)])].sort(compareUtf8);
  return keys.flatMap((key): FileHashChange[] => current[key] === baseline[key] ? [] : [{ path: `${prefix}${key}`, changeType: baseline[key] === undefined ? "added" : current[key] === undefined ? "removed" : "changed", ...(baseline[key] === undefined ? {} : { beforeSha256: baseline[key] }), ...(current[key] === undefined ? {} : { afterSha256: current[key] }) }]);
}
function currentPolicy(project: LoadedProject): BuildReceiptProjectPolicyV3 { return { buildDirectory: project.project.buildDirectory, installs: project.project.installs.map((item) => ({ assetId: item.asset, destinations: [...item.destinations].sort(compareUtf8) })).sort((a, b) => compareUtf8(a.assetId, b.assetId)), companions: project.project.companions.map((item) => ({ file: item.file, destinations: [...item.destinations].sort(compareUtf8) })).sort((a, b) => compareUtf8(a.file, b.file)) }; }
function policyChanges(before: BuildReceiptProjectPolicyV3, after: BuildReceiptProjectPolicyV3): PolicyChange[] {
  const changes: PolicyChange[] = [];
  if (before.buildDirectory !== after.buildDirectory) changes.push({ kind: "build_directory", key: "buildDirectory", changeType: "changed", before: before.buildDirectory, after: after.buildDirectory });
  const compareDeclarations = (kind: "install" | "companion", left: readonly { readonly destinations: readonly string[] }[], right: readonly { readonly destinations: readonly string[] }[], keyOf: (value: { readonly destinations: readonly string[] }) => string) => {
    const l = new Map(left.map((item) => [keyOf(item), item.destinations])); const r = new Map(right.map((item) => [keyOf(item), item.destinations]));
    for (const key of [...new Set([...l.keys(), ...r.keys()])].sort(compareUtf8)) {
      const a = l.get(key); const b = r.get(key);
      if (a === undefined || b === undefined) changes.push({ kind: kind === "install" ? "install_declaration" : "companion_declaration", key, changeType: a === undefined ? "added" : "removed" });
      else for (const destination of [...new Set([...a, ...b])].sort(compareUtf8)) if (a.includes(destination) !== b.includes(destination)) changes.push({ kind: kind === "install" ? "asset_destination" : "companion_destination", key, changeType: a.includes(destination) ? "removed" : "added", destination });
    }
  };
  compareDeclarations("install", before.installs, after.installs, (value) => (value as BuildReceiptProjectPolicyV3["installs"][number]).assetId);
  compareDeclarations("companion", before.companions, after.companions, (value) => (value as BuildReceiptProjectPolicyV3["companions"][number]).file);
  return changes;
}
export async function diffBuild(project: LoadedProject): Promise<BuildDiffResult> {
  const state = await inspectBuildSnapshot(project, "diff");
  const receipt = state.inspection.receipt;
  if (receipt?.schemaVersion !== 3 || state.snapshot.kind !== "directory") fail(context("filesystem"), "BUILD_DIFF_BASELINE_UNAVAILABLE", "Build policy baseline is unavailable; run a fresh 'tfsb build' to write v3 evidence.", project.project.buildDirectory);
  const currentSources = Object.fromEntries([...project.canonicalFiles].map(([path, bytes]) => [path, computeRawSha256(bytes)]));
  const canonicalSources = hashChanges(currentSources, receipt.canonicalSources);
  const actualOutputs: Record<string, string> = {};
  for (const [name, file] of state.snapshot.files) if (name !== BUILD_RECEIPT_FILENAME && file.kind === "file") actualOutputs[name] = file.sha256;
  const outputs = hashChanges(actualOutputs, receipt.outputs, `${project.project.buildDirectory}/`);
  const policies = policyChanges(receipt.projectPolicy, currentPolicy(project));
  const result: BuildDiffResult = { baseline: "build", canonicalSources, outputs, policyChanges: policies, different: canonicalSources.length + outputs.length + policies.length > 0 };
  await verifyLoadedProjectSnapshot(project, "diff");
  return result;
}

export async function diffInstall(project: LoadedProject): Promise<InstallDiffResult> {
  const records: InstallDiffRecord[] = [];
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const inspect = async (key: string, kind: "asset" | "companion", configured: string, resolved: string, expected: Uint8Array, expectedKind: "svg" | "companion") => {
    let state: InstallDiffRecord["state"] = "clean";
    if (await optionalLstat(resolved) === undefined) state = "missing";
    else {
      const actual = await readRegularFileSnapshot(resolved, context("filesystem"), "INSTALL_UNSAFE_DESTINATION", "Install destination must be one non-symlink regular file.");
      if (!Buffer.from(actual.bytes).equals(Buffer.from(expected))) state = "byte_different";
    }
    records.push({ key, kind, destination: configured, expectedKind, state });
  };
  for (const declaration of project.project.installs) {
    const asset = assets.get(declaration.asset)!; const expected = project.outputs.get(asset.filename)!; const resolved = project.installDestinations.get(declaration.asset) ?? [];
    for (const [index, destination] of declaration.destinations.entries()) await inspect(`asset:${declaration.asset}`, "asset", destination, resolved[index]!, expected, "svg");
  }
  for (const declaration of project.project.companions) {
    const expected = project.companions.get(declaration.file)!; const resolved = project.companionDestinations.get(declaration.file) ?? [];
    for (const [index, destination] of declaration.destinations.entries()) await inspect(`companion:${declaration.file}`, "companion", destination, resolved[index]!, expected, "companion");
  }
  records.sort((a, b) => compareUtf8(a.key, b.key) || compareUtf8(a.destination, b.destination));
  const result: InstallDiffResult = { baseline: "install", destinations: records, different: records.some((record) => record.state !== "clean") };
  await verifyLoadedProjectSnapshot(project, "diff");
  return result;
}

export async function diffProject(options: DiffOptions = {}): Promise<DiffResult> {
  const baseline = options.baseline ?? "provenance";
  const root = await findProjectRoot(options.root, "diff", options.root !== undefined);
  const project = await loadCanonicalProject(root, "diff");
  let result: DiffResult;
  if (baseline === "provenance") result = await diffProvenance(project);
  else if (baseline === "archive") { if (options.archive === undefined) fail(context("cli"), "DIFF_ARCHIVE_REQUIRED", "Archive diff requires an archive path."); result = await diffArchive(project, options.archive); }
  else if (baseline === "build") result = await diffBuild(project);
  else result = await diffInstall(project);
  await verifyLoadedProjectSnapshot(project, "diff");
  return result;
}
