import { computeSha256, type Sha256Digest } from "../digests.js";
import { compareUtf8 } from "../provenance.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import { BRAND_QA_MAX_RESULT_BYTES, type BrandQaBackground } from "./qa-schema.js";
import type { BrandQaRendererDescriptor } from "./qa-capability.js";

export const BRAND_QA_RESULT_SCHEMA = "tfsb.brand-qa-result" as const;
export const BRAND_QA_RESULT_SCHEMA_VERSION = 1 as const;
export const BRAND_QA_RESULT_DIGEST_BASIS = "tfsb.brand-qa-result-v1\n" as const;
export type BrandQaStatus = "pass" | "fail" | "skipped" | "unavailable" | "error";
export type BrandQaExitCode = 0 | 1 | 2 | 3;
export type BrandQaJsonValue = null | boolean | number | string | readonly BrandQaJsonValue[] | { readonly [key: string]: BrandQaJsonValue };

export interface BrandQaTargetIdentity {
  readonly assetId: string;
  readonly family?: string;
  readonly role?: string;
  readonly variant?: string;
}

export interface BrandQaDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly location?: string;
}

export interface BrandQaEvaluationResult {
  readonly target: BrandQaTargetIdentity;
  readonly width?: number;
  readonly height?: number;
  readonly background?: BrandQaBackground;
  readonly status: BrandQaStatus;
  readonly measurements: Readonly<Record<string, BrandQaJsonValue>>;
  readonly diagnostics: readonly BrandQaDiagnostic[];
}

export interface BrandQaCaseResult {
  readonly caseId: string;
  readonly kind: string;
  readonly status: BrandQaStatus;
  readonly capability: "semantic-core-v1" | "renderer";
  readonly capabilityRequired: boolean;
  readonly measurements: Readonly<Record<string, BrandQaJsonValue>>;
  readonly diagnostics: readonly BrandQaDiagnostic[];
  readonly evaluations: readonly BrandQaEvaluationResult[];
}

export interface BrandQaCounts {
  readonly pass: number;
  readonly fail: number;
  readonly skipped: number;
  readonly unavailable: number;
  readonly error: number;
}

export interface BrandQaResult {
  readonly schema: typeof BRAND_QA_RESULT_SCHEMA;
  readonly schemaVersion: typeof BRAND_QA_RESULT_SCHEMA_VERSION;
  readonly profileId: string;
  readonly qaDigest: Sha256Digest;
  readonly brandSystemDigest: Sha256Digest;
  readonly status: BrandQaStatus;
  readonly exitCode: BrandQaExitCode;
  readonly counts: BrandQaCounts;
  readonly renderer?: BrandQaRendererDescriptor;
  readonly results: readonly BrandQaCaseResult[];
  readonly resultDigest: Sha256Digest;
}

export interface CreateBrandQaResultInput {
  readonly profileId: string;
  readonly qaDigest: Sha256Digest;
  readonly brandSystemDigest: Sha256Digest;
  readonly renderer?: BrandQaRendererDescriptor;
  readonly results: readonly BrandQaCaseResult[];
  readonly selectedCaseIds: readonly string[];
}

function targetKey(target: BrandQaTargetIdentity): string {
  return [target.family ?? "", target.role ?? "", target.variant ?? "", target.assetId].join("\u0000");
}

function evaluationCompare(left: BrandQaEvaluationResult, right: BrandQaEvaluationResult): number {
  return compareUtf8(targetKey(left.target), targetKey(right.target)) || (left.width ?? 0) - (right.width ?? 0) || (left.height ?? 0) - (right.height ?? 0) || compareUtf8(left.background ?? "", right.background ?? "");
}

function diagnosticCompare(left: BrandQaDiagnostic, right: BrandQaDiagnostic): number {
  return compareUtf8(left.code, right.code) || compareUtf8(left.location ?? "", right.location ?? "") || compareUtf8(left.message, right.message);
}

function cloneDiagnostic(value: BrandQaDiagnostic): BrandQaDiagnostic {
  if (typeof value.code !== "string" || typeof value.message !== "string" || (value.location !== undefined && typeof value.location !== "string")) throw new Error("Invalid QA diagnostic.");
  return Object.freeze({ code: value.code, message: value.message, ...(value.location === undefined ? {} : { location: value.location }) });
}

function cloneEvaluation(value: BrandQaEvaluationResult): BrandQaEvaluationResult {
  if (typeof value.target !== "object" || value.target === null || typeof value.target.assetId !== "string") throw new Error("Invalid QA evaluation target.");
  return Object.freeze({
    target: Object.freeze({ ...value.target }),
    ...(value.width === undefined ? {} : { width: value.width }),
    ...(value.height === undefined ? {} : { height: value.height }),
    ...(value.background === undefined ? {} : { background: value.background }),
    status: value.status,
    measurements: JSON.parse(encodeCanonicalJson(value.measurements)) as Readonly<Record<string, BrandQaJsonValue>>,
    diagnostics: Object.freeze(value.diagnostics.map(cloneDiagnostic).sort(diagnosticCompare)),
  });
}

export function computeBrandQaExitCode(results: readonly BrandQaCaseResult[]): BrandQaExitCode {
  if (results.some((result) => result.status === "error")) return 1;
  if (results.some((result) => result.status === "unavailable" && result.capabilityRequired)) return 3;
  if (results.some((result) => result.status === "fail")) return 2;
  return 0;
}

export function computeBrandQaResultDigest(result: Omit<BrandQaResult, "resultDigest">): Sha256Digest {
  return computeSha256(Buffer.from(BRAND_QA_RESULT_DIGEST_BASIS + encodeCanonicalJson(result), "utf8"));
}

export function createBrandQaResult(input: CreateBrandQaResultInput): BrandQaResult {
  const selected = [...input.selectedCaseIds].sort(compareUtf8);
  if (new Set(selected).size !== selected.length) throw new Error("Selected QA case IDs must be unique.");
  const results = input.results.map((record): BrandQaCaseResult => Object.freeze({
    caseId: record.caseId,
    kind: record.kind,
    status: record.status,
    capability: record.capability,
    capabilityRequired: record.capabilityRequired,
    measurements: JSON.parse(encodeCanonicalJson(record.measurements)) as Readonly<Record<string, BrandQaJsonValue>>,
    diagnostics: Object.freeze(record.diagnostics.map(cloneDiagnostic).sort(diagnosticCompare)),
    evaluations: Object.freeze(record.evaluations.map(cloneEvaluation).sort(evaluationCompare)),
  })).sort((a, b) => compareUtf8(a.caseId, b.caseId));
  if (new Set(results.map((result) => result.caseId)).size !== results.length || encodeCanonicalJson(results.map((result) => result.caseId)) !== encodeCanonicalJson(selected)) throw new Error("QA result must contain exactly one record for every selected case.");
  for (const result of results) {
    const keys = result.evaluations.map((evaluation) => `${targetKey(evaluation.target)}\u0000${evaluation.width ?? ""}\u0000${evaluation.height ?? ""}\u0000${evaluation.background ?? ""}`);
    if (new Set(keys).size !== keys.length) throw new Error(`QA case '${result.caseId}' contains duplicate evaluations.`);
    if (result.status === "pass" && result.evaluations.some((evaluation) => evaluation.status !== "pass")) throw new Error(`QA case '${result.caseId}' cannot pass with a non-passing evaluation.`);
  }
  const counts: BrandQaCounts = Object.freeze({
    pass: results.filter((result) => result.status === "pass").length,
    fail: results.filter((result) => result.status === "fail").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    unavailable: results.filter((result) => result.status === "unavailable").length,
    error: results.filter((result) => result.status === "error").length,
  });
  const exitCode = computeBrandQaExitCode(results);
  const status: BrandQaStatus = exitCode === 1 ? "error" : exitCode === 3 ? "unavailable" : exitCode === 2 ? "fail" : "pass";
  const withoutDigest: Omit<BrandQaResult, "resultDigest"> = Object.freeze({ schema: BRAND_QA_RESULT_SCHEMA, schemaVersion: BRAND_QA_RESULT_SCHEMA_VERSION, profileId: input.profileId, qaDigest: input.qaDigest, brandSystemDigest: input.brandSystemDigest, status, exitCode, counts, ...(input.renderer === undefined ? {} : { renderer: Object.freeze({ ...input.renderer }) }), results: Object.freeze(results) });
  const result = Object.freeze({ ...withoutDigest, resultDigest: computeBrandQaResultDigest(withoutDigest) });
  if (Buffer.byteLength(encodeCanonicalJson(result), "utf8") > BRAND_QA_MAX_RESULT_BYTES) throw new Error("Serialized QA result exceeds 16 MiB.");
  return result;
}

export function serializeBrandQaResult(result: BrandQaResult): string {
  const { resultDigest: _ignored, ...withoutDigest } = result;
  const expected = computeBrandQaResultDigest(withoutDigest);
  if (expected !== result.resultDigest) throw new Error("QA result digest is invalid.");
  const bytes = encodeCanonicalJson(result) + "\n";
  if (Buffer.byteLength(bytes, "utf8") > BRAND_QA_MAX_RESULT_BYTES) throw new Error("Serialized QA result exceeds 16 MiB.");
  return bytes;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ").replace(/[\u0000-\u001f\u007f]/gu, "�");
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;").replace(/[\u0000-\u001f\u007f]/gu, "�");
}

export function projectBrandQaResultMarkdown(result: BrandQaResult): string {
  const lines = ["# Brand QA result", "", `Profile: \`${escapeMarkdown(result.profileId)}\``, `Status: **${result.status}** (exit ${result.exitCode})`, `QA digest: \`${result.qaDigest}\``, `Brand-system digest: \`${result.brandSystemDigest}\``, `Result digest: \`${result.resultDigest}\``, "", "| Case | Kind | Status | Evaluations |", "| --- | --- | --- | ---: |"];
  for (const record of result.results) lines.push(`| ${escapeMarkdown(record.caseId)} | ${escapeMarkdown(record.kind)} | ${record.status} | ${record.evaluations.length} |`);
  lines.push("");
  for (const record of result.results) {
    lines.push(`## ${escapeMarkdown(record.caseId)}`, "", `Capability: ${record.capability}`, "", "| Target | Size | Background | Status |", "| --- | --- | --- | --- |");
    for (const evaluation of record.evaluations) lines.push(`| ${escapeMarkdown(targetKey(evaluation.target).replace(/\u0000/gu, "/"))} | ${evaluation.width === undefined ? "-" : `${evaluation.width}x${evaluation.height}`} | ${escapeMarkdown(evaluation.background ?? "-")} | ${evaluation.status} |`);
    lines.push("");
  }
  const output = lines.join("\n");
  if (Buffer.byteLength(output, "utf8") > BRAND_QA_MAX_RESULT_BYTES) throw new Error("Markdown QA report exceeds 16 MiB.");
  return output;
}

export function projectBrandQaResultHtml(result: BrandQaResult): string {
  const rows = result.results.map((record) => `<tr><td>${escapeHtml(record.caseId)}</td><td>${escapeHtml(record.kind)}</td><td>${record.status}</td><td>${record.evaluations.length}</td></tr>`).join("");
  const sections = result.results.map((record) => `<section><h2>${escapeHtml(record.caseId)}</h2><p>Capability: ${record.capability}</p><table><thead><tr><th>Target</th><th>Size</th><th>Background</th><th>Status</th></tr></thead><tbody>${record.evaluations.map((evaluation) => `<tr><td>${escapeHtml(targetKey(evaluation.target).replace(/\u0000/gu, "/"))}</td><td>${evaluation.width === undefined ? "-" : `${evaluation.width}x${evaluation.height}`}</td><td>${escapeHtml(evaluation.background ?? "-")}</td><td>${evaluation.status}</td></tr>`).join("")}</tbody></table></section>`).join("");
  const output = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brand QA result</title><style>body{font-family:system-ui,sans-serif;max-width:72rem;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #888;padding:.35rem;text-align:left}code{overflow-wrap:anywhere}</style></head><body><h1>Brand QA result</h1><p>Profile: <code>${escapeHtml(result.profileId)}</code></p><p>Status: <strong>${result.status}</strong> (exit ${result.exitCode})</p><p>QA digest: <code>${result.qaDigest}</code><br>Brand-system digest: <code>${result.brandSystemDigest}</code><br>Result digest: <code>${result.resultDigest}</code></p><table><thead><tr><th>Case</th><th>Kind</th><th>Status</th><th>Evaluations</th></tr></thead><tbody>${rows}</tbody></table>${sections}</body></html>\n`;
  if (Buffer.byteLength(output, "utf8") > BRAND_QA_MAX_RESULT_BYTES) throw new Error("HTML QA report exceeds 16 MiB.");
  return output;
}
