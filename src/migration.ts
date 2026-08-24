import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ASSET_DIGEST_BASIS, ASSET_DIGEST_BASIS_V2, SVG_OUTPUT_DIGEST_BASIS, computeAssetSemanticDigest, computeSvgOutputDigest, type Sha256Digest } from "./digests.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import { findProjectRoot } from "./root.js";
import { parseAssetTomlV2, parseProjectTomlV2, serializeAssetTomlV2, serializeProjectTomlV2 } from "./schema2-toml.js";
import { serializeSvgV2 } from "./schema2-svg.js";
import type { ArtworkElementV2, DefinitionsV2, NormalizedAssetV2, NormalizedProjectV2, PaintV2, PresentationV2, SvgDocumentV2 } from "./schema2-types.js";
import { serializeSvg } from "./svg.js";
import { executeCanonicalTransaction, type CanonicalSnapshot, type TransactionHooks } from "./transaction.js";
import { enforceMutationAssetLimit, loadCanonicalProject, type LoadedProject } from "./project.js";
import { serializeAssetToml, serializeProjectToml } from "./toml-writer.js";
import { parseImportProvenance, unwrapProvenance, type AssetProvenanceRecordV1, type CompanionProvenanceRecordV1, type ImportProvenanceV1 } from "./provenance.js";
import { ARCHIVE_DIGEST_BASIS, ARCHIVE_SOURCE_DIGEST_BASIS, COMPANION_DIGEST_BASIS, MIGRATION_RESOLUTION, parseImportProvenanceV2, serializeImportProvenanceV2, unwrapProvenanceV2, type ArchiveCheckpointV2, type AssetProvenanceRecordV2, type CompanionProvenanceRecordV2, type ImportProvenanceV2, type MigrationEvidenceV2 } from "./provenance2.js";
import { TOOL_VERSION } from "./version.js";
import type { ArtworkElement, NormalizedAsset, NormalizedProject, Paint, Presentation, Result } from "./types.js";

const MAX_MUTATION_BYTES = 32 * 1024 * 1024;

export interface MigrationFilePlan {
  readonly path: string;
  readonly beforeBasis: typeof ASSET_DIGEST_BASIS;
  readonly beforeDigest: Sha256Digest;
  readonly afterBasis: typeof ASSET_DIGEST_BASIS_V2;
  readonly afterDigest: Sha256Digest;
  readonly svgOutputDigest: Sha256Digest;
  readonly svgEquivalent: true;
}

export interface MigrationPlan {
  readonly root: string;
  readonly mode: "check" | "apply";
  readonly fromSchemaVersion: 1 | 2;
  readonly toSchemaVersion: 2;
  readonly assetCount: number;
  readonly companionCount: number;
  readonly svgEquivalentCount: number;
  readonly files: readonly MigrationFilePlan[];
  readonly projectPath: ".tfsb/project.toml";
  readonly companionPaths: readonly string[];
  readonly provenancePath: ".tfsb/provenance.json" | null;
  readonly provenanceTransition: "schema_migration_checkpoint" | "already_current";
  readonly buildReceiptSourceStale: boolean;
  readonly migrationNeeded: boolean;
  readonly applied: false;
}

export interface MigrationResult extends Omit<MigrationPlan, "applied"> { readonly applied: boolean; }
export interface MigrationOptions { readonly root?: string; readonly check?: boolean; }

interface MigrationInternals {
  readonly snapshot: CanonicalSnapshot;
  readonly nextFiles: ReadonlyMap<string, Uint8Array>;
  readonly expectedSvgByAsset: ReadonlyMap<string, Uint8Array>;
}

const internals = new WeakMap<MigrationPlan, MigrationInternals>();

function context(domain: DiagnosticContext["domain"] = "project"): DiagnosticContext { return { operation: "migrate", domain }; }
function unwrap<T>(result: Result<T>): T { if (result.ok) return result.value; const first = result.diagnostics[0]; if (first === undefined) throw new Error("Diagnostic result was unexpectedly empty."); throw new DiagnosticError(first); }

function paint(value: Paint): PaintV2 { return value; }
function presentation(value: Presentation): PresentationV2 & { readonly ariaHidden?: boolean } {
  return {
    ...(value.fill === undefined ? {} : { fill: paint(value.fill) }),
    ...(value.stroke === undefined ? {} : { stroke: paint(value.stroke) }),
    ...(value.strokeWidth === undefined ? {} : { strokeWidth: value.strokeWidth }),
    ...(value.strokeLinecap === undefined ? {} : { strokeLinecap: value.strokeLinecap }),
    ...(value.strokeLinejoin === undefined ? {} : { strokeLinejoin: value.strokeLinejoin }),
    ...(value.strokeMiterlimit === undefined ? {} : { strokeMiterlimit: value.strokeMiterlimit }),
    ...(value.opacity === undefined ? {} : { opacity: value.opacity }),
    ...(value.ariaHidden === undefined ? {} : { ariaHidden: value.ariaHidden }),
  };
}

function element(value: ArtworkElement): ArtworkElementV2 {
  const common = { ...presentation(value), ...(value.id === undefined ? {} : { id: value.id }), ...(value.transform === undefined ? {} : { transforms: value.transform }) };
  if (value.type === "path") return { type: "path", ...common, d: value.d };
  if (value.type === "use") return { type: "use", ...common, reference: value.href, ...(value.x === undefined ? {} : { x: value.x }), ...(value.y === undefined ? {} : { y: value.y }) };
  const children: ArtworkElementV2[] = value.body.type === "paths"
    ? value.body.paths.map((child) => element({ type: "path", ...child }))
    : value.body.uses.map((child) => element({ type: "use", ...child }));
  return { type: "group", ...common, children };
}

export function migrateAssetModel(asset: NormalizedAsset): NormalizedAssetV2 {
  const svg = asset.svg;
  const definitions: DefinitionsV2 = {
    linearGradients: svg.definitions.linearGradients,
    groups: svg.definitions.groups.map((group) => ({ type: "group" as const, ...presentation(group), id: group.id, children: group.paths.map((path) => element({ type: "path", ...path })) })),
    paths: svg.definitions.paths.map((path) => ({ type: "path" as const, ...presentation(path), id: path.id, ...(path.transform === undefined ? {} : { transforms: path.transform }), d: path.d })),
    circles: [], ellipses: [], rects: [], lines: [], polylines: [], polygons: [],
  };
  const migratedSvg: SvgDocumentV2 = {
    canvas: svg.canvas,
    accessibility: { mode: "labelled", title: svg.accessibility.title, titleId: svg.accessibility.titleId, description: svg.accessibility.description, descriptionId: svg.accessibility.descriptionId, ...(svg.accessibility.focusable === undefined ? {} : { focusable: svg.accessibility.focusable }) },
    presentation: {},
    ...(svg.metadataText === undefined ? {} : { metadataText: svg.metadataText }),
    definitions,
    elements: svg.elements.map(element),
  };
  return { schemaVersion: 2, id: asset.id, filename: asset.filename, svg: migratedSvg };
}

function migrateProjectModel(project: NormalizedProject): NormalizedProjectV2 { return { schemaVersion: 2, name: project.name, buildDirectory: project.buildDirectory, installs: project.installs, companions: project.companions }; }

function archiveFromAsset(record: AssetProvenanceRecordV1): ArchiveCheckpointV2 {
  return { archiveDigestBasis: ARCHIVE_DIGEST_BASIS, archiveDigest: record.archiveDigest, entryName: record.entryName, sourceBasis: ARCHIVE_SOURCE_DIGEST_BASIS, sourceDigest: record.entryDigest, archiveCanonicalBasis: ASSET_DIGEST_BASIS, archiveCanonicalDigest: record.archiveModelDigest, canonicalBasis: ASSET_DIGEST_BASIS, canonicalState: record.canonicalState, canonicalDigest: record.canonicalModelDigest ?? null, resolution: record.resolution, toolVersion: record.toolVersion };
}
function archiveFromCompanion(record: CompanionProvenanceRecordV1): ArchiveCheckpointV2 {
  return { archiveDigestBasis: ARCHIVE_DIGEST_BASIS, archiveDigest: record.archiveDigest, entryName: record.entryName, sourceBasis: ARCHIVE_SOURCE_DIGEST_BASIS, sourceDigest: record.entryDigest, archiveCanonicalBasis: COMPANION_DIGEST_BASIS, archiveCanonicalDigest: record.archiveByteDigest, canonicalBasis: COMPANION_DIGEST_BASIS, canonicalState: record.canonicalState, canonicalDigest: record.canonicalByteDigest ?? null, resolution: record.resolution, toolVersion: record.toolVersion };
}

function loadV1Provenance(project: LoadedProject): ImportProvenanceV1 | undefined {
  const bytes = project.snapshot.files.get(".tfsb/provenance.json")?.bytes;
  if (bytes === undefined) return undefined;
  return unwrapProvenance(parseImportProvenance(Buffer.from(bytes).toString("utf8"), ".tfsb/provenance.json"));
}

async function validateProposedTree(stageRoot: string, expectedSvgByAsset: ReadonlyMap<string, Uint8Array>): Promise<void> {
  const projectText = await readFile(join(stageRoot, "project.toml"), "utf8");
  const project = unwrap(parseProjectTomlV2(projectText, ".tfsb/project.toml"));
  if (project.schemaVersion !== 2) fail(context(), "MIGRATION_STAGE_INVALID", "Staged project is not schema 2.", ".tfsb/project.toml");
  for (const [assetId, expectedSvg] of expectedSvgByAsset) {
    const path = `.tfsb/assets/${assetId}.toml`;
    const asset = unwrap(parseAssetTomlV2(await readFile(join(stageRoot, "assets", `${assetId}.toml`), "utf8"), path));
    const actualSvg = Buffer.from(unwrap(serializeSvgV2(asset.svg, path)), "utf8");
    if (!actualSvg.equals(expectedSvg)) fail(context("transaction"), "MIGRATION_SVG_MISMATCH", "Staged schema-2 SVG output differs from the frozen schema-1 output.", path);
  }
  const provenanceText = await readFile(join(stageRoot, "provenance.json"), "utf8");
  unwrapProvenanceV2(parseImportProvenanceV2(provenanceText, ".tfsb/provenance.json"));
}

export async function planMigration(options: MigrationOptions = {}): Promise<MigrationPlan> {
  const root = await findProjectRoot(options.root ?? process.cwd(), "migrate", options.root !== undefined);
  const loaded = await loadCanonicalProject(root, "migrate");
  enforceMutationAssetLimit(loaded, "migrate");
  const mutationBytes = [...loaded.snapshot.files].filter(([path]) => path.startsWith(".tfsb/assets/") || path.startsWith(".tfsb/companions/")).reduce((sum, [, file]) => sum + file.bytes.byteLength, 0);
  if (mutationBytes > MAX_MUTATION_BYTES) fail(context(), "RESOURCE_LIMIT_EXCEEDED", "Migration source assets and companions exceed the 32 MiB mutation boundary.", ".tfsb");
  const companionPaths = [...loaded.companions.keys()].map((name) => `.tfsb/companions/${name}`).sort();
  if (loaded.project.schemaVersion === 2) return { root, mode: options.check === true ? "check" : "apply", fromSchemaVersion: 2, toSchemaVersion: 2, assetCount: loaded.assets.length, companionCount: loaded.companions.size, svgEquivalentCount: loaded.assets.length, files: [], projectPath: ".tfsb/project.toml", companionPaths, provenancePath: loaded.snapshot.files.has(".tfsb/provenance.json") ? ".tfsb/provenance.json" : null, provenanceTransition: "already_current", buildReceiptSourceStale: false, migrationNeeded: false, applied: false };
  const project = loaded.project as NormalizedProject;
  const v1Provenance = loadV1Provenance(loaded);
  const oldAssetsById = new Map(v1Provenance?.records.filter((record): record is AssetProvenanceRecordV1 => record.type === "asset").map((record) => [record.assetId, record]) ?? []);
  const nextFiles = new Map([...loaded.snapshot.files].map(([path, file]) => [path, file.bytes]));
  const migratedProject = migrateProjectModel(project);
  const projectToml = serializeProjectTomlV2(migratedProject);
  if (!isDeepStrictEqual(unwrap(parseProjectTomlV2(projectToml, ".tfsb/project.toml")), migratedProject)) throw new Error("Generated schema-2 project failed round-trip.");
  nextFiles.set(".tfsb/project.toml", Buffer.from(projectToml, "utf8"));
  const filePlans: MigrationFilePlan[] = [];
  const expectedSvgByAsset = new Map<string, Uint8Array>();
  const records: (AssetProvenanceRecordV2 | CompanionProvenanceRecordV2)[] = [];
  for (const source of loaded.assets as readonly NormalizedAsset[]) {
    const target = migrateAssetModel(source);
    const path = `.tfsb/assets/${source.id}.toml`;
    const beforeSvg = Buffer.from(unwrap(serializeSvg(source.svg, path)), "utf8");
    const afterSvg = Buffer.from(unwrap(serializeSvgV2(target.svg, path)), "utf8");
    if (!afterSvg.equals(beforeSvg)) fail(context(), "MIGRATION_SVG_MISMATCH", "Schema-1 and schema-2 canonical SVG bytes differ.", path);
    const beforeDigest = computeAssetSemanticDigest(source); const afterDigest = computeAssetSemanticDigest(target); const svgOutputDigest = computeSvgOutputDigest(beforeSvg);
    const targetToml = serializeAssetTomlV2(target);
    if (!isDeepStrictEqual(unwrap(parseAssetTomlV2(targetToml, path)), target)) throw new Error(`Generated schema-2 asset '${source.id}' failed round-trip.`);
    nextFiles.set(path, Buffer.from(targetToml, "utf8")); expectedSvgByAsset.set(source.id, beforeSvg);
    filePlans.push({ path, beforeBasis: ASSET_DIGEST_BASIS, beforeDigest, afterBasis: ASSET_DIGEST_BASIS_V2, afterDigest, svgOutputDigest, svgEquivalent: true });
    const migration: MigrationEvidenceV2 = { fromSchemaVersion: 1, toSchemaVersion: 2, beforeBasis: ASSET_DIGEST_BASIS, beforeDigest, afterBasis: ASSET_DIGEST_BASIS_V2, afterDigest, svgBasis: SVG_OUTPUT_DIGEST_BASIS, beforeSvgDigest: svgOutputDigest, afterSvgDigest: computeSvgOutputDigest(afterSvg), svgEquivalent: true, resolution: MIGRATION_RESOLUTION, toolVersion: TOOL_VERSION };
    const previous = oldAssetsById.get(source.id); oldAssetsById.delete(source.id);
    records.push({ type: "asset", assetId: source.id, canonicalPath: path, archive: previous === undefined ? null : archiveFromAsset(previous), migration, normalizationPolicy: null });
  }
  for (const previous of oldAssetsById.values()) records.push({ type: "asset", assetId: previous.assetId, canonicalPath: previous.canonicalPath, archive: archiveFromAsset(previous), migration: null, normalizationPolicy: null });
  for (const companion of v1Provenance?.records.filter((record): record is CompanionProvenanceRecordV1 => record.type === "companion") ?? []) records.push({ type: "companion", canonicalPath: companion.canonicalPath, archive: archiveFromCompanion(companion) });
  const provenance: ImportProvenanceV2 = { kind: "tfsb-import-provenance", schemaVersion: 2, records };
  const provenanceText = serializeImportProvenanceV2(provenance); unwrapProvenanceV2(parseImportProvenanceV2(provenanceText, ".tfsb/provenance.json")); nextFiles.set(".tfsb/provenance.json", Buffer.from(provenanceText, "utf8"));
  const plan: MigrationPlan = { root, mode: options.check === true ? "check" : "apply", fromSchemaVersion: 1, toSchemaVersion: 2, assetCount: loaded.assets.length, companionCount: loaded.companions.size, svgEquivalentCount: filePlans.length, files: filePlans.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))), projectPath: ".tfsb/project.toml", companionPaths, provenancePath: ".tfsb/provenance.json", provenanceTransition: "schema_migration_checkpoint", buildReceiptSourceStale: true, migrationNeeded: true, applied: false };
  if (plan.mode === "apply") internals.set(plan, { snapshot: loaded.snapshot, nextFiles, expectedSvgByAsset });
  return plan;
}

export async function executeMigration(plan: MigrationPlan, hooks?: TransactionHooks): Promise<MigrationResult> {
  if (!plan.migrationNeeded) return { ...plan, applied: false };
  if (plan.mode !== "apply") fail(context("transaction"), "TRANSACTION_INVALID_PLAN", "Migration apply requires an apply-mode plan.");
  const privatePlan = internals.get(plan);
  if (privatePlan === undefined) fail(context("transaction"), "TRANSACTION_INVALID_PLAN", "Migration apply requires an authentic private plan.");
  await executeCanonicalTransaction({ root: plan.root, nextFiles: privatePlan.nextFiles, expectedSnapshot: privatePlan.snapshot, operation: "migrate", ...(hooks === undefined ? {} : { hooks }), validateStagedTree: (stageRoot) => validateProposedTree(stageRoot, privatePlan.expectedSvgByAsset) });
  return { ...plan, applied: true };
}

export async function migrateProject(options: MigrationOptions = {}): Promise<MigrationResult> { const plan = await planMigration(options); return options.check === true ? { ...plan, applied: false } : executeMigration(plan); }
