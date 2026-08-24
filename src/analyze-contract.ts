import type { Diagnostic } from "./types.js";
import type { JsonExitCode, JsonStatus, MachineDiagnostic } from "./json.js";

export const ANALYZE_LIMITS = {
  candidateEntries: 100_000,
  svgFiles: 50_000,
  fileBytes: 8 * 1024 * 1024,
  aggregateSvgBytes: 512 * 1024 * 1024,
  archiveBytes: 512 * 1024 * 1024,
  archiveDeclaredBytes: 1024 * 1024 * 1024,
  compressionRatio: 100,
  fileXmlElements: 250_000,
  analysisXmlElements: 2_000_000,
  modeledElements: 1_024,
  groupDepth: 8,
  samplesPerDiagnostic: 20,
} as const;

export const ANALYZE_SCHEMA1_PROFILE = "tfsb-svg-schema-1" as const;
export const ANALYZE_COMMON_V03_PROFILE = "tfsb-svg-common-v0.3" as const;

export const ANALYZE_DIAGNOSTIC_REGISTRY = [
  ["ANALYZE_UNSAFE_XML_DECLARATION", "unsafe", "unsafe", "complete", "unsafe_dominates", "The SVG contains a prohibited XML declaration or entity construct."],
  ["ANALYZE_UNSAFE_ACTIVE_ELEMENT", "unsafe", "unsafe", "complete", "unsafe_dominates", "The SVG contains an active or externally loaded element."],
  ["ANALYZE_UNSAFE_ACTIVE_ATTRIBUTE", "unsafe", "unsafe", "complete", "unsafe_dominates", "The SVG contains an active style or event attribute."],
  ["ANALYZE_UNSAFE_EXTERNAL_REFERENCE", "unsafe", "unsafe", "complete", "unsafe_dominates", "The SVG contains an external, data, or protocol-relative reference."],
  ["ANALYZE_UNSUPPORTED_ELEMENT", "unsupported", "unsupported", "complete", "drift_candidate", "The selected SVG profile does not support this element."],
  ["ANALYZE_UNSUPPORTED_ATTRIBUTE", "unsupported", "unsupported", "complete", "drift_candidate", "The selected SVG profile does not support this attribute."],
  ["ANALYZE_UNSUPPORTED_CSS_CLASS", "unsupported", "unsupported", "complete", "drift_candidate", "The selected SVG profile does not support CSS classes."],
  ["ANALYZE_UNSUPPORTED_VERSION", "unsupported", "unsupported", "complete", "drift_candidate", "The selected SVG profile does not support this SVG version."],
  ["ANALYZE_UNSUPPORTED_NAMESPACE", "unsupported", "unsupported", "complete", "drift_candidate", "The selected SVG profile does not support this namespace."],
  ["ANALYZE_UNSUPPORTED_PAINT", "unsupported", "unsupported", "complete", "drift_candidate", "The selected SVG profile does not support this paint family."],
  ["ANALYZE_UNSUPPORTED_TRANSFORM", "unsupported", "unsupported", "complete", "drift_candidate", "The selected SVG profile does not support this transform."],
  ["ANALYZE_UNSUPPORTED_XML_NODE", "unsupported", "unsupported", "complete", "drift_candidate", "The selected SVG profile does not support this XML node class."],
  ["ANALYZE_INVALID_ROOT", "invalid", "unsupported", "complete", "drift_candidate", "The document root is not a supported SVG root."],
  ["ANALYZE_MISSING_ARTWORK", "invalid", "unsupported", "complete", "drift_candidate", "The SVG contains no supported artwork element."],
  ["ANALYZE_INVALID_VIEWBOX", "invalid", "unsupported", "complete", "drift_candidate", "The SVG viewBox is invalid."],
  ["ANALYZE_INVALID_CANVAS_DIMENSION", "invalid", "unsupported", "complete", "drift_candidate", "An SVG canvas dimension is invalid."],
  ["ANALYZE_INVALID_ID", "invalid", "unsupported", "complete", "drift_candidate", "An SVG identifier is invalid or duplicated."],
  ["ANALYZE_INVALID_GEOMETRY", "invalid", "unsupported", "complete", "drift_candidate", "An SVG geometry or presentation value is invalid."],
  ["ANALYZE_INVALID_PATH_DATA", "invalid", "unsupported", "complete", "drift_candidate", "An SVG path has invalid or empty path data."],
  ["ANALYZE_INVALID_ACCESSIBILITY", "invalid", "unsupported", "complete", "drift_candidate", "The SVG accessibility signals are invalid or contradictory."],
  ["ANALYZE_INVALID_REFERENCE", "invalid", "unsupported", "complete", "drift_candidate", "An SVG local reference is unresolved, unauthorized, or cyclic."],
  ["ANALYZE_INVALID_SHAPE_RENDERING", "invalid", "unsupported", "complete", "drift_candidate", "The SVG shape-rendering value is invalid."],
  ["ANALYZE_SYNTAX_ERROR", "syntax", "unsupported", "complete", "drift_candidate", "The SVG is not well-formed XML."],
  ["ANALYZE_INVALID_UTF8", "syntax", "unsupported", "complete", "drift_candidate", "The SVG is not valid UTF-8."],
  ["ANALYZE_FILE_BYTE_LIMIT_EXCEEDED", "file_resource", "unsupported", "complete", "drift_candidate", "The SVG exceeds the fixed 8 MiB per-file analysis limit."],
  ["ANALYZE_FILE_ELEMENT_LIMIT_EXCEEDED", "file_resource", "unsupported", "complete", "drift_candidate", "The SVG exceeds the fixed 250,000-element per-file limit."],
  ["ANALYZE_PROFILE_ELEMENT_LIMIT_EXCEEDED", "profile_resource", "unsupported", "complete", "drift_candidate", "The SVG exceeds the target profile's 1,024-modeled-element limit."],
  ["ANALYZE_PROFILE_DEPTH_LIMIT_EXCEEDED", "profile_resource", "unsupported", "complete", "drift_candidate", "The SVG exceeds the target profile's eight-level group-depth limit."],
  ["ANALYZE_CANDIDATE_LIMIT_EXCEEDED", "scan_resource", null, "null", "scan_abort", "The input exceeds the fixed 100,000-candidate limit."],
  ["ANALYZE_SVG_FILE_LIMIT_EXCEEDED", "scan_resource", null, "null", "scan_abort", "The input exceeds the fixed 50,000-SVG limit."],
  ["ANALYZE_AGGREGATE_BYTE_LIMIT_EXCEEDED", "scan_resource", null, "null", "scan_abort", "The input exceeds the fixed 512 MiB aggregate SVG limit."],
  ["ANALYZE_ANALYSIS_ELEMENT_LIMIT_EXCEEDED", "scan_resource", null, "null", "scan_abort", "The input exceeds the fixed 2,000,000-element analysis limit."],
  ["ANALYZE_ARCHIVE_BYTE_LIMIT_EXCEEDED", "archive_resource", null, "null", "scan_abort", "The ZIP exceeds the fixed 512 MiB raw archive limit."],
  ["ANALYZE_ARCHIVE_DECLARED_BYTE_LIMIT_EXCEEDED", "archive_resource", null, "null", "scan_abort", "The ZIP exceeds the fixed 1 GiB declared-byte limit."],
  ["ANALYZE_ARCHIVE_COMPRESSION_RATIO_EXCEEDED", "archive_resource", null, "null", "scan_abort", "A ZIP entry exceeds the fixed 100:1 expansion ratio."],
  ["ANALYZE_ARCHIVE_INVALID", "archive", null, "null", "scan_abort", "The input is not a supported safe ZIP archive."],
  ["ANALYZE_INPUT_INVALID", "input", null, "null", "scan_abort", "Analyze input must be a non-symlink directory or regular ZIP file."],
  ["ANALYZE_SOURCE_CHANGED", "snapshot", null, "null", "scan_abort", "The analyze input changed while it was being inspected."],
  ["ANALYZE_SNAPSHOT_FAILED", "snapshot", null, "null", "scan_abort", "The analyze input could not be snapshotted safely."],
  ["ANALYZE_DETAILS_TARGET_INVALID", "details_output", null, "null", "scan_abort", "The details target is not an absent safe output path."],
  ["ANALYZE_DETAILS_WRITE_FAILED", "details_output", null, "null", "scan_abort", "The details report could not be published transactionally."],
] as const;

export type AnalyzeCode = typeof ANALYZE_DIAGNOSTIC_REGISTRY[number][0];
export type AnalyzeDiagnosticDomain = typeof ANALYZE_DIAGNOSTIC_REGISTRY[number][1];

export const ANALYZE_NORMALIZATION_REGISTRY = [
  "accessibility_authority_required",
  "canonicalize_definition_order",
  "canonicalize_svg_version",
  "declare_decorative",
  "geometry_defaults_expanded",
  "labelled_ids_and_references",
  "promote_root_presentation",
  "rect_corner_completion",
  "title_only_to_labelled",
  "xlink_href_to_href",
  "xlink_namespace_to_svg2_href",
] as const;
export type AnalyzeNormalization = typeof ANALYZE_NORMALIZATION_REGISTRY[number];

export const ANALYZE_FEATURE_CODE_REGISTRY = [
  "accessibility.consumer_labelled", "accessibility.decorative", "accessibility.labelled", "accessibility.unlabelled",
  "attribute.class", "attribute.clip-path", "attribute.event", "attribute.href", "attribute.style", "attribute.xlink-href",
  "definition.basic_geometry", "definition.group", "definition.linearGradient", "definition.path", "definitions.forward_order",
  "element.animation", "element.circle", "element.clipPath", "element.defs", "element.desc", "element.ellipse", "element.foreignObject", "element.g", "element.image", "element.line", "element.linearGradient", "element.metadata", "element.other", "element.path", "element.polygon", "element.polyline", "element.rect", "element.script", "element.stop", "element.style", "element.svg", "element.symbol", "element.title", "element.use",
  "group.mixed_or_nested_children", "namespace.other", "namespace.svg", "namespace.xlink",
  "paint.currentColor", "paint.external", "paint.hex", "paint.linearGradient", "paint.none", "paint.other",
  "presentation.clip-rule", "presentation.fill-opacity", "presentation.fill-rule", "presentation.opacity", "presentation.stroke-opacity",
  "reference.external", "reference.local", "reference.xlink_local",
  "root-presentation.clip-rule", "root-presentation.fill", "root-presentation.fill-opacity", "root-presentation.fill-rule", "root-presentation.opacity", "root-presentation.stroke", "root-presentation.stroke-linecap", "root-presentation.stroke-linejoin", "root-presentation.stroke-miterlimit", "root-presentation.stroke-opacity", "root-presentation.stroke-width",
  "transform.matrix", "transform.rotate", "transform.scale", "transform.skewX", "transform.skewY", "transform.translate", "transform.unknown",
  "xml.cdata", "xml.comment", "xml.declaration", "xml.doctype", "xml.processing-instruction",
] as const;
export type AnalyzeFeatureCode = typeof ANALYZE_FEATURE_CODE_REGISTRY[number];

export type AnalyzeInputKind = "directory" | "archive";
export type AnalyzeProfileKey = "schema1" | "commonV03";
export type Schema1Classification = "directly_importable" | "unsupported" | "unsafe";
export type CommonV03Classification = Schema1Classification | "importable_with_normalization";

export interface AnalyzeCounts { readonly directlyImportable: number; readonly importableWithNormalization: number; readonly unsupported: number; readonly unsafe: number; }
export interface AnalyzeProfileAggregate<P extends string> { readonly profile: P; readonly counts: AnalyzeCounts; readonly diagnosticCounts: Partial<Record<AnalyzeCode, number>>; readonly featureCounts: Partial<Record<AnalyzeFeatureCode, number>>; readonly normalizationCounts: Partial<Record<AnalyzeNormalization, number>>; }
export interface AnalyzeIdentitySummary { readonly invalidAssetIdentities: number; readonly assetIdCollisions: { readonly groups: number; readonly affectedFiles: number }; readonly portablePathCollisions: { readonly groups: number; readonly affectedFiles: number }; }
export interface AnalyzeJsonData {
  readonly scanCompleted: true;
  readonly input: { readonly kind: AnalyzeInputKind };
  readonly totals: { readonly files: number; readonly svgFiles: number };
  readonly profiles: { readonly schema1: AnalyzeProfileAggregate<typeof ANALYZE_SCHEMA1_PROFILE>; readonly commonV03: AnalyzeProfileAggregate<typeof ANALYZE_COMMON_V03_PROFILE> };
  readonly resourceObservations: { readonly sourceBytes: number; readonly maxFileBytes: number; readonly xmlElements: number };
  readonly identity: AnalyzeIdentitySummary;
  readonly samples: Record<AnalyzeProfileKey, Partial<Record<AnalyzeCode, readonly string[]>>>;
}

export interface AnalyzeDetailsProfile<P extends string, C> { readonly profile: P; readonly classification: C; readonly diagnosticCodes: readonly AnalyzeCode[]; readonly featureCodes: readonly AnalyzeFeatureCode[]; }
export interface AnalyzeDetailsLocation { readonly profile: AnalyzeProfileKey; readonly code: AnalyzeCode; readonly modelLocation: string; }
export interface AnalyzeDetailsFile {
  readonly recordType: "file"; readonly path: string; readonly derivedAssetId: string | null;
  readonly profiles: { readonly schema1: AnalyzeDetailsProfile<typeof ANALYZE_SCHEMA1_PROFILE, Schema1Classification>; readonly commonV03: AnalyzeDetailsProfile<typeof ANALYZE_COMMON_V03_PROFILE, CommonV03Classification> & { readonly normalizations: readonly AnalyzeNormalization[] } };
  readonly locations: readonly AnalyzeDetailsLocation[];
}
export interface AnalyzeDetailsHeader { readonly recordType: "header"; readonly schema: "tfsb-analyze-details"; readonly schemaVersion: 1; readonly inputKind: AnalyzeInputKind; readonly profiles: { readonly schema1: typeof ANALYZE_SCHEMA1_PROFILE; readonly commonV03: typeof ANALYZE_COMMON_V03_PROFILE } }
export interface AnalyzeDetailsFooter { readonly recordType: "footer"; readonly records: number; readonly profiles: { readonly schema1: AnalyzeCounts; readonly commonV03: AnalyzeCounts }; readonly recordsSha256: `sha256:${string}` }

export interface AnalyzeResult {
  readonly status: JsonStatus; readonly exitCode: JsonExitCode; readonly summary: string;
  readonly diagnostics: readonly Diagnostic[]; readonly machineDiagnostics: readonly MachineDiagnostic[];
  readonly data: AnalyzeJsonData; readonly files: readonly AnalyzeDetailsFile[];
}

const registryByCode = new Map(ANALYZE_DIAGNOSTIC_REGISTRY.map((entry) => [entry[0], entry]));
export function analyzeDiagnosticSpec(code: AnalyzeCode): typeof ANALYZE_DIAGNOSTIC_REGISTRY[number] { const value = registryByCode.get(code); if (value === undefined) throw new Error("Analyze diagnostic registry is incomplete."); return value; }
export function analyzeMessage(code: AnalyzeCode): string { return analyzeDiagnosticSpec(code)[5]; }
