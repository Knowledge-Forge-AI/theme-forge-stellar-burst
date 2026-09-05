import { diagnostic } from "./diagnostics.js";
import { createJsonEnvelope, mapMachineDiagnostic, type JsonResultEnvelope } from "./json.js";
import { compareUtf8 } from "./provenance.js";
import {
  ANALYZE_COMMON_V03_PROFILE,
  ANALYZE_LIMITS,
  ANALYZE_SCHEMA1_PROFILE,
  analyzeMessage,
  type AnalyzeCode,
  type AnalyzeCounts,
  type AnalyzeDetailsFile,
  type AnalyzeFeatureCode,
  type AnalyzeIdentitySummary,
  type AnalyzeJsonData,
  type AnalyzeNormalization,
  type AnalyzeProfileKey,
  type AnalyzeResult,
} from "./analyze-contract.js";
import { executeAnalyzeSource, inspectAnalyzeInput, type AnalyzeInputPlan, type AnalyzeSourceHooks } from "./analyze-source.js";

export interface AnalyzeOptions { readonly input: string; readonly cwd?: string; }
export type AnalyzeEnvelope = JsonResultEnvelope<"analyze", AnalyzeJsonData>;

function emptyCounts(): AnalyzeCounts { return { directlyImportable: 0, importableWithNormalization: 0, unsupported: 0, unsafe: 0 }; }
function incrementClassification(counts: AnalyzeCounts, classification: string): void {
  if (classification === "directly_importable") (counts as { directlyImportable: number }).directlyImportable += 1;
  else if (classification === "importable_with_normalization") (counts as { importableWithNormalization: number }).importableWithNormalization += 1;
  else if (classification === "unsupported") (counts as { unsupported: number }).unsupported += 1;
  else (counts as { unsafe: number }).unsafe += 1;
}
function increment<K extends string>(target: Partial<Record<K, number>>, key: K): void { target[key] = (target[key] ?? 0) + 1; }
function orderedRecord<K extends string>(value: Partial<Record<K, number>>): Partial<Record<K, number>> { return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareUtf8(left, right))) as Partial<Record<K, number>>; }
function collision(values: readonly (readonly [string, string])[]): { readonly groups: number; readonly affectedFiles: number } {
  const groups = new Map<string, string[]>();
  for (const [key, path] of values) groups.set(key, [...(groups.get(key) ?? []), path]);
  const collisions = [...groups.values()].filter((paths) => paths.length > 1);
  return { groups: collisions.length, affectedFiles: collisions.reduce((total, paths) => total + paths.length, 0) };
}
function identity(files: readonly AnalyzeDetailsFile[]): AnalyzeIdentitySummary {
  return {
    invalidAssetIdentities: files.filter((file) => file.derivedAssetId === null).length,
    assetIdCollisions: collision(files.flatMap((file) => file.derivedAssetId === null ? [] : [[file.derivedAssetId, file.path] as const])),
    portablePathCollisions: collision(files.map((file) => [file.path.normalize("NFC").replace(/[A-Z]/g, (letter) => letter.toLowerCase()), file.path] as const)),
  };
}

function aggregateProfile(files: readonly AnalyzeDetailsFile[], profile: AnalyzeProfileKey) {
  const counts = emptyCounts();
  const diagnosticCounts: Partial<Record<AnalyzeCode, number>> = {};
  const featureCounts: Partial<Record<AnalyzeFeatureCode, number>> = {};
  const normalizationCounts: Partial<Record<AnalyzeNormalization, number>> = {};
  for (const file of files) {
    const result = file.profiles[profile]; incrementClassification(counts, result.classification);
    for (const code of result.diagnosticCodes) increment(diagnosticCounts, code);
    for (const code of result.featureCodes) increment(featureCounts, code);
    if (profile === "commonV03") for (const normalization of file.profiles.commonV03.normalizations) increment(normalizationCounts, normalization);
  }
  return { profile: profile === "schema1" ? ANALYZE_SCHEMA1_PROFILE : ANALYZE_COMMON_V03_PROFILE, counts, diagnosticCounts: orderedRecord(diagnosticCounts), featureCounts: orderedRecord(featureCounts), normalizationCounts: profile === "schema1" ? {} : orderedRecord(normalizationCounts) };
}

function representativeDiagnostics(files: readonly AnalyzeDetailsFile[]) {
  const diagnostics = [];
  const seen = new Set<string>(); const perCode = new Map<AnalyzeCode, number>();
  for (const file of files) for (const location of file.locations) {
    const key = `${location.code}\0svg\0${location.modelLocation}\0${analyzeMessage(location.code)}`;
    if (seen.has(key) || (perCode.get(location.code) ?? 0) >= ANALYZE_LIMITS.samplesPerDiagnostic) continue;
    seen.add(key); perCode.set(location.code, (perCode.get(location.code) ?? 0) + 1);
    diagnostics.push(diagnostic({ operation: "analyze", domain: "svg", source: file.path }, location.code, analyzeMessage(location.code), location.modelLocation));
  }
  return diagnostics.sort((left, right) => compareUtf8(left.code, right.code) || compareUtf8(left.location ?? "", right.location ?? "") || compareUtf8(left.message, right.message));
}

function samples(files: readonly AnalyzeDetailsFile[]): AnalyzeJsonData["samples"] {
  const result: AnalyzeJsonData["samples"] = { schema1: {}, commonV03: {} };
  for (const profile of ["schema1", "commonV03"] as const) for (const file of files) for (const code of file.profiles[profile].diagnosticCodes) {
    const current = result[profile][code] ?? [];
    if (current.length < ANALYZE_LIMITS.samplesPerDiagnostic) result[profile][code] = [...current, file.path];
  }
  for (const profile of ["schema1", "commonV03"] as const) result[profile] = Object.fromEntries(Object.entries(result[profile]).sort(([left], [right]) => compareUtf8(left, right)));
  return result;
}

export async function executeCompleteAnalysis(plan: AnalyzeInputPlan, hooks: AnalyzeSourceHooks = {}): Promise<AnalyzeResult> {
  const source = await executeAnalyzeSource(plan, hooks);
  const files = source.files;
  const schema1 = aggregateProfile(files, "schema1");
  const commonV03 = aggregateProfile(files, "commonV03");
  const data: AnalyzeJsonData = {
    scanCompleted: true, input: { kind: plan.kind }, totals: { files: source.totalFiles, svgFiles: files.length },
    profiles: { schema1: { ...schema1, profile: ANALYZE_SCHEMA1_PROFILE }, commonV03: { ...commonV03, profile: ANALYZE_COMMON_V03_PROFILE } },
    resourceObservations: { sourceBytes: source.sourceBytes, maxFileBytes: source.maxFileBytes, xmlElements: source.xmlElements },
    identity: identity(files), samples: samples(files),
  };
  const diagnostics = representativeDiagnostics(files);
  const status = commonV03.counts.unsafe > 0 ? "error" as const : commonV03.counts.unsupported > 0 || commonV03.counts.importableWithNormalization > 0 ? "drift" as const : "ok" as const;
  const exitCode = status === "ok" ? 0 as const : status === "drift" ? 2 as const : 1 as const;
  const summary = status === "ok" ? `${files.length} SVG file(s) are directly importable by the common v0.3 profile.` : status === "drift" ? `${files.length} SVG file(s) were scanned; normalization or unsupported compatibility drift was found.` : `${files.length} SVG file(s) were scanned; unsafe content was found.`;
  return { status, exitCode, summary, diagnostics, machineDiagnostics: diagnostics.map(mapMachineDiagnostic), data, files };
}

export async function analyze(options: AnalyzeOptions): Promise<AnalyzeResult> { return executeCompleteAnalysis(await inspectAnalyzeInput(options.input, options.cwd)); }
export function mapAnalyzeJson(result: AnalyzeResult): AnalyzeJsonData { return result.data; }
export function createAnalyzeEnvelope(result: AnalyzeResult): AnalyzeEnvelope { return createJsonEnvelope("analyze", result.status, result.exitCode, result.summary, result.machineDiagnostics, result.data); }

function countsLine(label: string, counts: AnalyzeCounts): string { return `${label}: directly importable ${counts.directlyImportable}; normalization required ${counts.importableWithNormalization}; unsupported ${counts.unsupported}; unsafe ${counts.unsafe}`; }
export function renderAnalyzeHuman(result: AnalyzeResult): string {
  const lines = [
    `Analyze: ${result.data.totals.svgFiles} SVG file(s) from ${result.data.input.kind} input`,
    countsLine(ANALYZE_SCHEMA1_PROFILE, result.data.profiles.schema1.counts),
    countsLine(ANALYZE_COMMON_V03_PROFILE, result.data.profiles.commonV03.counts),
    "Command status is based only on tfsb-svg-common-v0.3.",
  ];
  for (const profile of ["schema1", "commonV03"] as const) for (const [code, paths] of Object.entries(result.data.samples[profile]).sort(([left], [right]) => compareUtf8(left, right))) {
    const all = paths ?? []; const shown = all.slice(0, ANALYZE_LIMITS.samplesPerDiagnostic);
    lines.push(`${profile} ${code}: ${shown.join(", ")} (${shown.length} displayed, ${Math.max(0, (result.data.profiles[profile].diagnosticCounts[code as AnalyzeCode] ?? shown.length) - shown.length)} omitted)`);
  }
  lines.push("Compatibility analysis is not import, legal, trademark, or redistribution permission.");
  return `${lines.join("\n")}\n`;
}
