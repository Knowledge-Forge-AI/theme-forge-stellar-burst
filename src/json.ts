import { isAbsolute } from "node:path";

import type { CheckResult } from "./check.js";
import type { DiffResult } from "./diff.js";
import type { FormatResult } from "./fmt.js";
import type { ProjectInventory } from "./list.js";
import type { PreviewResult } from "./preview.js";
import { compareUtf8 } from "./provenance.js";
import type { ReconcilePlannedAction, ReconcileRequiredAuthority, ReconciliationClassification, ReconciliationResult } from "./reconcile.js";
import type { NormalizationLedgerV1 } from "./normalization-ledger.js";
import type { NormalizationPolicyIdentityV1 } from "./normalization-policy.js";
import type { Diagnostic } from "./types.js";

export const JSON_RESULT_SCHEMA_VERSION = 1 as const;
export type JsonCommand = "check" | "list" | "reconcile" | "diff" | "bundle" | "fmt" | "preview" | "analyze" | "migrate";
export type JsonStatus = "ok" | "drift" | "conflict" | "error";
export type JsonExitCode = 0 | 1 | 2;

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

export interface CheckJsonData { readonly canonical: { readonly valid: boolean; readonly sourceChanged: boolean }; readonly build: CheckResult["build"]; readonly install: CheckResult["install"]; }
export type ListJsonData = ProjectInventory;
export interface ReconcileJsonRecord { readonly key: string; readonly kind: "asset" | "companion"; readonly classification: ReconciliationClassification; readonly plannedAction: ReconcilePlannedAction; readonly requiredAuthority: ReconcileRequiredAuthority; readonly blocker: boolean; readonly resolutionRequired: boolean; }
export interface ReconcileJsonData { readonly applied: boolean; readonly changed: boolean; readonly pending: boolean; readonly blocked: boolean; readonly records: readonly ReconcileJsonRecord[]; readonly normalizationPolicy?: NormalizationPolicyIdentityV1; readonly normalizationLedger?: NormalizationLedgerV1; }
export type DiffJsonData = DiffResult;
export interface BundleJsonEntry { readonly type: "asset" | "companion" | "manifest"; readonly name: string; readonly assetId?: string; readonly size: number; readonly sha256: string; }
export interface BundleJsonData { readonly output: string; readonly dryRun: boolean; readonly written: boolean; readonly replaced: boolean; readonly archiveBytes: number; readonly assetCount: number; readonly companionCount: number; readonly entries: readonly BundleJsonEntry[]; }
export type FormatJsonData = FormatResult;
export type PreviewJsonData = PreviewResult;

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
  if (value === "" || value.includes("\0") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("~")) return false;
  if (!isAbsolute(value)) return true;
  return domain === "svg" && /^\/svg(?:\/|$)/.test(value);
}

export function mapMachineDiagnostic(diagnostic: Diagnostic): MachineDiagnostic {
  const location = diagnostic.location;
  return {
    code: diagnostic.code,
    severity: "error",
    operation: diagnostic.operation,
    domain: diagnostic.domain,
    ...(location === undefined ? {} : diagnostic.domain === "project-toml" || diagnostic.domain === "asset-toml" || diagnostic.domain === "svg" || diagnostic.domain === "manifest" || diagnostic.domain === "provenance"
      ? (safeModelLocation(location, diagnostic.domain) ? { modelLocation: location } : {})
      : !safeRelative(location) ? {} : diagnostic.domain === "archive" ? { archiveEntry: location } : { path: location }),
    message: safeMessage(diagnostic.message),
  };
}

export function createJsonEnvelope<C extends JsonCommand, D>(command: C, status: JsonStatus, exitCode: JsonExitCode, summary: string, diagnostics: readonly MachineDiagnostic[], data: D | null): JsonResultEnvelope<C, D> {
  const orderedDiagnostics = [...diagnostics].sort((left, right) => compareUtf8(left.code, right.code) || compareUtf8(left.path ?? left.archiveEntry ?? left.modelLocation ?? "", right.path ?? right.archiveEntry ?? right.modelLocation ?? "") || compareUtf8(left.message, right.message));
  return { schemaVersion: JSON_RESULT_SCHEMA_VERSION, command, status, exitCode, summary, diagnostics: orderedDiagnostics, data };
}

export function serializeJsonEnvelope(envelope: JsonResultEnvelope): string { return `${JSON.stringify(envelope, null, 2)}\n`; }

export function mapCheckJson(result: CheckResult, projectRelative: (path: string) => string): CheckJsonData {
  return { canonical: { valid: result.valid, sourceChanged: result.sourceChanged }, build: { missing: [...result.build.missing].sort(compareUtf8), extra: [...result.build.extra].sort(compareUtf8), different: [...result.build.different].sort(compareUtf8) }, install: { missing: result.install.missing.map(projectRelative).sort(compareUtf8), different: result.install.different.map(projectRelative).sort(compareUtf8) } };
}

export function mapListJson(result: ProjectInventory): ListJsonData {
  return {
    assets: [...result.assets].sort((left, right) => compareUtf8(left.id, right.id)).map((item) => ({ ...item, destinations: [...item.destinations].sort(compareUtf8) })),
    companions: [...result.companions].sort((left, right) => compareUtf8(left.file, right.file)).map((item) => ({ ...item, destinations: [...item.destinations].sort(compareUtf8) })),
  };
}

export function mapReconcileJson(result: ReconciliationResult): ReconcileJsonData {
  const records = result.records.map((record) => ({ key: record.key, kind: record.kind, classification: record.classification, plannedAction: record.plannedAction, requiredAuthority: record.requiredAuthority, blocker: record.blocker, resolutionRequired: record.requiredAuthority === "resolve" })).sort((left, right) => compareUtf8(left.key, right.key));
  return { applied: result.applied, changed: result.changed, pending: result.pending, blocked: result.blocked, records, ...(result.normalizationPolicy === undefined ? {} : { normalizationPolicy: result.normalizationPolicy, normalizationLedger: result.normalizationLedger! }) };
}
