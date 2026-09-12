import { isAbsolute } from "node:path";

import type { CheckResult } from "./check.js";
import type { DiffResult } from "./diff.js";
import type { FormatResult } from "./fmt.js";
import type { ProjectInventory } from "./list.js";
import type { PreviewResult } from "./preview.js";
import type { WorkspaceCheckResult } from "./workspace-check.js";
import type { WorkspaceListResult } from "./workspace-list.js";
import type { WorkspacePreviewResult } from "./workspace-preview.js";
import { compareUtf8 } from "./provenance.js";
import type { ReconcilePlannedAction, ReconcileRequiredAuthority, ReconciliationClassification, ReconciliationResult } from "./reconcile.js";
import type { DirectoryReconciliationClassification, DirectoryReconciliationPlannedAction, DirectoryReconciliationRequiredAuthority, DirectoryReconciliationResult } from "./reconcile-directory.js";
import type { NormalizationLedgerV1 } from "./normalization-ledger.js";
import type { NormalizationPolicyIdentityV1 } from "./normalization-policy.js";
import type { Diagnostic } from "./types.js";
import type { SceneMetrics, SceneReceipt, VectorScene } from "./scene/types.js";

export const JSON_RESULT_SCHEMA_VERSION = 1 as const;
export type JsonCommand = "import" | "check" | "list" | "reconcile" | "diff" | "bundle" | "fmt" | "preview" | "analyze" | "migrate" | "shard" | "derive" | "qa" | "consumer" | "export" | "scene";
export type JsonStatus = "ok" | "drift" | "conflict" | "unavailable" | "error";
export type JsonExitCode = 0 | 1 | 2 | 3;

export interface MachineDiagnostic {
  readonly code: string;
  readonly severity: "error";
  readonly operation: string;
  readonly domain: string;
  readonly path?: string;
  readonly archiveEntry?: string;
  readonly modelLocation?: string;
  readonly message: string;
}

export interface JsonResultEnvelope<C extends JsonCommand = JsonCommand, D = unknown> {
  readonly schemaVersion: 1;
  readonly command: C;
  readonly status: JsonStatus;
  readonly exitCode: JsonExitCode;
  readonly summary: string;
  readonly diagnostics: readonly MachineDiagnostic[];
  readonly data: D | null;
}

export interface CheckJsonData { readonly canonical: { readonly valid: boolean; readonly sourceChanged: boolean }; readonly build: CheckResult["build"]; readonly install: CheckResult["install"]; readonly brand?: CheckResult["brand"]; readonly consumer?: CheckResult["consumer"]; readonly rasterExports?: CheckResult["rasterExports"]; }
export type ListJsonData = ProjectInventory;
export interface ReconcileJsonRecord { readonly key: string; readonly kind: "asset" | "companion"; readonly classification: ReconciliationClassification | DirectoryReconciliationClassification; readonly plannedAction: ReconcilePlannedAction | DirectoryReconciliationPlannedAction; readonly requiredAuthority: ReconcileRequiredAuthority | DirectoryReconciliationRequiredAuthority; readonly blocker: boolean; readonly resolutionRequired: boolean; }
export interface ReconcileJsonData { readonly applied: boolean; readonly changed: boolean; readonly pending: boolean; readonly blocked: boolean; readonly sourceKind?: "directory"; readonly sourceMapDigest?: string; readonly snapshotDigest?: string; readonly records: readonly ReconcileJsonRecord[]; readonly normalizationPolicy?: NormalizationPolicyIdentityV1; readonly normalizationLedger?: NormalizationLedgerV1; }
export type DiffJsonData = DiffResult;
export interface BundleJsonEntry { readonly type: "asset" | "companion" | "manifest" | "file"; readonly name: string; readonly assetId?: string; readonly size: number; readonly sha256: string; }
export interface BundleJsonData {
  readonly output: string;
  readonly dryRun: boolean;
  readonly written: boolean;
  readonly replaced: boolean;
  readonly archiveBytes: number;
  readonly assetCount: number;
  readonly companionCount: number;
  readonly domainCount?: number;
  readonly packageId?: string;
  readonly brandVersion?: string;
  readonly genericManifestByteDigest?: string;
  readonly brandPackageDigest?: string;
  readonly brandSystemDigest?: string;
  readonly brandManifestDigest?: string;
  readonly entries: readonly BundleJsonEntry[];
}
export interface ImportJsonData {
  readonly input: { readonly kind: "archive" | "directory" };
  readonly schemaVersion: 1 | 2;
  readonly provenanceSchemaVersion?: 3;
  readonly sourceMapDigest?: string;
  readonly snapshotDigest?: string;
  readonly collections?: readonly string[];
  readonly assetCount: number;
  readonly companionCount: number;
  readonly normalization?: { readonly policyDigest: string };
  readonly brand?: {
    readonly packageId: string;
    readonly name: string;
    readonly brandVersion: string;
    readonly brandPackageDigest: string;
    readonly brandSystemDigest: string;
    readonly brandManifestDigest: string;
  };
}
export interface ShardJsonData {
  readonly planOnly: boolean;
  readonly manifestWritten: boolean;
  readonly collectionId: string;
  readonly sourceMapDigest: string;
  readonly sourceSnapshotDigest: string;
  readonly membershipDigest: string;
  readonly assetCount: number;
  readonly selectedBytes: number;
  readonly directlyImportable: number;
  readonly normalizationRequired: number;
  readonly assets: readonly {
    readonly sourcePath: string;
    readonly assetId: string;
    readonly sourceDigest: string;
    readonly sourceBytes: number;
  }[];
}
export interface DeriveJsonTargetSummary {
  readonly targetAssetId: string;
  readonly recipeId: string;
  readonly state: "create" | "update" | "unchanged";
  readonly oldDigest?: string;
  readonly newDigest: string;
  readonly newSvgDigest: string;
}

export interface DeriveJsonData {
  readonly dryRun: boolean;
  readonly written: boolean;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly unchangedCount: number;
  readonly tokenDigest: string;
  readonly recipeDigest: string;
  readonly selectedRecipes: readonly string[];
  readonly transitiveRecipes: readonly string[];
  readonly affectedTargets: readonly string[];
  readonly targets: readonly DeriveJsonTargetSummary[];
  readonly warnings: readonly string[];
}

export type FormatJsonData = FormatResult;
export type PreviewJsonData = PreviewResult;
export type WorkspaceListJsonData = WorkspaceListResult;
export type WorkspaceCheckJsonData = WorkspaceCheckResult;
export type WorkspacePreviewJsonData = WorkspacePreviewResult;

export interface SceneValidateJsonData {
  readonly schema: "tfsb.scene-result-v1";
  readonly action: "validate";
  readonly valid: true;
  readonly metrics: SceneMetrics;
  readonly scene: VectorScene;
}

export interface SceneInspectJsonData {
  readonly schema: "tfsb.scene-result-v1";
  readonly action: "inspect";
  readonly valid: true;
  readonly metrics: SceneMetrics;
  readonly receipt: SceneReceipt;
  readonly warnings: readonly string[];
  readonly scene: VectorScene;
}

export interface SceneCompileJsonData {
  readonly schema: "tfsb.scene-result-v1";
  readonly action: "compile";
  readonly valid: true;
  readonly output: string;
  readonly dryRun: boolean;
  readonly written: boolean;
  readonly cleanupResidue: string | null;
  readonly receipt: SceneReceipt;
  readonly metrics: SceneMetrics;
}

export interface SceneImportSvgJsonData {
  readonly schema: "tfsb.scene-result-v1";
  readonly action: "import-svg";
  readonly valid?: boolean;
  readonly classification: string;
  readonly reasons: readonly string[];
  readonly reasonCodes?: readonly string[];
  readonly sourceSha256: string;
  readonly normalizations: readonly string[];
  readonly written: boolean;
  readonly output?: string;
  readonly metrics?: SceneMetrics;
}

export type SceneJsonData =
  | SceneValidateJsonData
  | SceneInspectJsonData
  | SceneCompileJsonData
  | SceneImportSvgJsonData;

function safeRelative(value: string): boolean {
  return value !== "" && !value.includes("\0") && !isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value) &&
    !value.startsWith("~") && !value.includes("\\") && !value.split("/").some((part) => part === ".." || part === "");
}
function safeMessage(value: string): string {
  const unsafe = value.includes("\0") || /(?:^|[\s'"(])(?:\/[^\s'"()]+|[A-Za-z]:[\\/][^\s'"()]*|~\/[^\s'"()]*)/i.test(value) ||
    /(?:(?:api|access)[_-]?token|api[_-]?key|authorization|password|cookie|user(?:name)?|host(?:name)?)\s*[:=]/i.test(value) || /\n\s*at\s+\S+/.test(value) || /\b(?:process\.env|environment dump)\b/i.test(value);
  return unsafe ? "The operation could not be completed safely." : value;
}
function safeModelLocation(value: string, domain: Diagnostic["domain"]): boolean {
  if (domain === "scene") return /^\$(?:\.[A-Za-z][A-Za-z0-9]*|\[[0-9]+\])*$/.test(value);
  if (value === "" || value.includes("\0") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("~")) return false;
  if (!isAbsolute(value)) return true;
  return domain === "svg" && /^\/svg(?:\/|$)/.test(value);
}

export function mapMachineDiagnostic(diagnostic: Diagnostic): MachineDiagnostic {
  const location = diagnostic.location;
  const domain = diagnostic.domain;
  return {
    code: diagnostic.code,
    severity: "error",
    operation: diagnostic.operation,
    domain: diagnostic.domain,
    ...(location === undefined ? {} : domain === "project-toml" || domain === "asset-toml" || domain === "svg" || domain === "manifest" || domain === "provenance" || domain === "scene"
      ? (safeModelLocation(location, diagnostic.domain) ? { modelLocation: location } : {})
      : !safeRelative(location) ? {} : domain === "archive" ? { archiveEntry: location } : { path: location }),
    message: safeMessage(diagnostic.message),
  };
}

export function createJsonEnvelope<C extends JsonCommand, D>(command: C, status: JsonStatus, exitCode: JsonExitCode, summary: string, diagnostics: readonly MachineDiagnostic[], data: D | null): JsonResultEnvelope<C, D> {
  const orderedDiagnostics = [...diagnostics].sort((left, right) => compareUtf8(left.code, right.code) || compareUtf8(left.path ?? left.archiveEntry ?? left.modelLocation ?? "", right.path ?? right.archiveEntry ?? right.modelLocation ?? "") || compareUtf8(left.message, right.message));
  return { schemaVersion: JSON_RESULT_SCHEMA_VERSION, command, status, exitCode, summary, diagnostics: orderedDiagnostics, data };
}

export function serializeJsonEnvelope(envelope: JsonResultEnvelope): string { return `${JSON.stringify(envelope, null, 2)}\n`; }

export function mapCheckJson(result: CheckResult, projectRelative: (path: string) => string): CheckJsonData {
  return { canonical: { valid: result.valid, sourceChanged: result.sourceChanged }, build: { missing: [...result.build.missing].sort(compareUtf8), extra: [...result.build.extra].sort(compareUtf8), different: [...result.build.different].sort(compareUtf8) }, install: { missing: result.install.missing.map(projectRelative).sort(compareUtf8), different: result.install.different.map(projectRelative).sort(compareUtf8) }, ...(result.brand === undefined ? {} : { brand: result.brand }), ...(result.consumer === undefined ? {} : { consumer: result.consumer }), ...(result.rasterExports === undefined ? {} : { rasterExports: result.rasterExports }) };
}

export function mapListJson(result: ProjectInventory): ListJsonData {
  return {
    assets: [...result.assets].sort((left, right) => compareUtf8(left.id, right.id)).map((item) => ({ ...item, destinations: [...item.destinations].sort(compareUtf8) })),
    companions: [...result.companions].sort((left, right) => compareUtf8(left.file, right.file)).map((item) => ({ ...item, destinations: [...item.destinations].sort(compareUtf8) })),
    ...(result.brand === undefined ? {} : { brand: result.brand }),
    ...(result.consumer === undefined ? {} : { consumer: result.consumer }),
    ...(result.rasterExports === undefined ? {} : { rasterExports: result.rasterExports }),
  };
}

export function mapReconcileJson(result: ReconciliationResult | DirectoryReconciliationResult): ReconcileJsonData {
  const records = result.records.map((record) => ({ key: record.key, kind: record.kind, classification: record.classification, plannedAction: record.plannedAction, requiredAuthority: record.requiredAuthority, blocker: record.blocker, resolutionRequired: record.requiredAuthority === "resolve" })).sort((left, right) => compareUtf8(left.key, right.key));
  return { applied: result.applied, changed: result.changed, pending: result.pending, blocked: result.blocked, ...( "sourceMapDigest" in result ? { sourceKind: "directory" as const, sourceMapDigest: result.sourceMapDigest, snapshotDigest: result.snapshotDigest } : {}), records, ...(result.normalizationPolicy === undefined ? {} : { normalizationPolicy: result.normalizationPolicy, normalizationLedger: result.normalizationLedger! }) };
}
