import { DOMParser, XMLSerializer, type Element } from "@xmldom/xmldom";

import { scanAnalyzeSvg } from "./analyze-scanner.js";
import type { AnalyzeNormalization } from "./analyze-contract.js";
import { computeAssetSemanticDigest, computeSha256 } from "./digests.js";
import { fail, type DiagnosticContext } from "./diagnostics.js";
import { normalizationAuthorityFor, type NormalizationMapV1, type UnlabelledAccessibilityAuthority } from "./normalization-map.js";
import type { NormalizationLedgerEntryV1, NormalizationOperationCode } from "./normalization-ledger.js";
import type { NormalizationPolicyIdentityV1 } from "./normalization-policy.js";
import { parseSvgV2, serializeSvgV2 } from "./schema2-svg.js";
import type { NormalizedAssetV2 } from "./schema2-types.js";
import type { AssetId, Result, SvgFilename } from "./types.js";
import { DiagnosticError } from "./diagnostics.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const OPERATION_ORDER: readonly NormalizationOperationCode[] = [
  "accessibility_authority_required", "title_only_to_labelled", "labelled_ids_and_references",
  "declare_decorative", "promote_root_presentation", "canonicalize_svg_version",
  "xlink_namespace_to_svg2_href", "xlink_href_to_href", "geometry_defaults_expanded",
  "rect_corner_completion", "canonicalize_definition_order", "canonicalize_parser_whitespace",
];

export interface NormalizeSvgOptions {
  readonly bytes: Uint8Array;
  readonly source: string;
  readonly assetId: AssetId;
  readonly filename: SvgFilename;
  readonly map?: NormalizationMapV1;
  readonly policy: NormalizationPolicyIdentityV1;
}

export interface NormalizedSvgResult {
  readonly asset: NormalizedAssetV2;
  readonly canonicalSvg: string;
  readonly ledger: NormalizationLedgerEntryV1;
}

function context(source: string): DiagnosticContext { return { operation: "import", domain: "svg", source }; }
function unwrap<T>(result: Result<T>): T { if (result.ok) return result.value; const first = result.diagnostics[0]; if (first === undefined) throw new Error("Diagnostic result was unexpectedly empty."); throw new DiagnosticError(first); }
function directChildren(root: Element): Element[] { const result: Element[] = []; for (let index = 0; index < root.childNodes.length; index += 1) { const child = root.childNodes.item(index); if (child?.nodeType === 1) result.push(child as Element); } return result; }
function noncanonicalParserWhitespace(source: string): boolean { return /(?:viewBox|d|transform|fill|stroke|points)=(?:"[^"]*(?:[\t\n\r]| {2,}|^ +| +$)[^"]*"|'[^']*(?:[\t\n\r]| {2,}|^ +| +$)[^']*')/.test(source); }
function ordered(values: Iterable<NormalizationOperationCode>): NormalizationOperationCode[] { const set = new Set(values); return OPERATION_ORDER.filter((value) => set.has(value)); }

function transformDocument(source: string, assetId: string, authority: UnlabelledAccessibilityAuthority | undefined, normalizations: readonly AnalyzeNormalization[], ctx: DiagnosticContext): string {
  const errors: string[] = [];
  const document = new DOMParser({ onError: (level) => { if (level !== "warning") errors.push(level); } }).parseFromString(source, "application/xml");
  const root = document.documentElement;
  if (errors.length > 0 || root === null || root.localName !== "svg") fail(ctx, "IMPORT_UNSUPPORTED_SOURCE", "Source cannot be normalized as a supported SVG.", "/svg");
  root.setAttribute("xmlns", SVG_NS);
  root.removeAttribute("version");
  const children = directChildren(root);
  const title = children.find((child) => child.localName === "title");
  const description = children.find((child) => child.localName === "desc");
  const requiresAuthority = normalizations.includes("accessibility_authority_required");
  if (requiresAuthority && authority === undefined) fail(ctx, "NORMALIZATION_AUTHORITY_REQUIRED", "Unlabelled or conflicting accessibility requires explicit map authority.", "/svg");
  if (requiresAuthority) {
    if (title !== undefined || description !== undefined) fail(ctx, "IMPORT_UNSUPPORTED_SOURCE", "Authored title or description cannot be discarded by unlabelled accessibility authority.", "/svg");
    if (authority === "decorative") {
      root.removeAttribute("role"); root.removeAttribute("aria-labelledby"); root.setAttribute("aria-hidden", "true");
    } else if (authority === "consumer_labelled") {
      root.removeAttribute("aria-hidden"); root.removeAttribute("aria-labelledby"); root.setAttribute("role", "img");
    }
  } else if (normalizations.includes("title_only_to_labelled") || normalizations.includes("labelled_ids_and_references")) {
    if (title === undefined) fail(ctx, "NORMALIZATION_AUTHORITY_REQUIRED", "Labelled normalization requires an observed title.", "/svg/title");
    const titleId = title.getAttribute("id") || `tfsb-${assetId}-title`;
    title.setAttribute("id", titleId);
    let labelledBy = titleId;
    if (description !== undefined) { const descriptionId = description.getAttribute("id") || `tfsb-${assetId}-description`; description.setAttribute("id", descriptionId); labelledBy += ` ${descriptionId}`; }
    root.removeAttribute("aria-hidden"); root.setAttribute("role", "img"); root.setAttribute("aria-labelledby", labelledBy);
  }
  const all = Array.from({ length: document.getElementsByTagName("*").length }, (_, index) => document.getElementsByTagName("*").item(index)).filter((item): item is Element => item !== null);
  for (const element of all) {
    const defaults: Record<string, readonly string[]> = {
      circle: ["cx", "cy"], ellipse: ["cx", "cy"], rect: ["x", "y"], line: ["x1", "y1", "x2", "y2"],
    };
    for (const attribute of defaults[element.localName ?? ""] ?? []) if (!element.hasAttribute(attribute)) element.setAttribute(attribute, "0");
    if (element.hasAttribute("fill")) { const fill = element.getAttribute("fill"); if (fill !== null) element.setAttribute("fill", fill.trim()); }
    if (element.hasAttribute("stroke")) { const stroke = element.getAttribute("stroke"); if (stroke !== null) element.setAttribute("stroke", stroke.trim()); }
    if (element.hasAttribute("points")) { const points = element.getAttribute("points"); if (points !== null) element.setAttribute("points", points.trim().replace(/[\t\n\r ]+/g, " ")); }
    if (element.localName === "rect") {
      if (element.hasAttribute("rx") && !element.hasAttribute("ry")) element.setAttribute("ry", element.getAttribute("rx") ?? "0");
      if (element.hasAttribute("ry") && !element.hasAttribute("rx")) element.setAttribute("rx", element.getAttribute("ry") ?? "0");
    }
    const href = element.getAttributeNS(XLINK_NS, "href");
    if (href !== null && href !== "") { if (!href.startsWith("#")) fail(ctx, "IMPORT_UNSAFE_SOURCE", "Only asset-local xlink references may be normalized.", "/svg/use/@xlink:href"); element.setAttribute("href", href); element.removeAttributeNS(XLINK_NS, "href"); }
    element.removeAttribute("xmlns:xlink");
  }
  const reordered = directChildren(root);
  const defs = reordered.find((child) => child.localName === "defs");
  if (defs !== undefined) {
    const firstArtwork = reordered.find((child) => !["title", "desc", "metadata", "defs"].includes(child.localName ?? child.tagName));
    if (firstArtwork !== undefined && reordered.indexOf(defs) > reordered.indexOf(firstArtwork)) root.insertBefore(defs, firstArtwork);
  }
  return new XMLSerializer().serializeToString(document);
}

export function normalizeCommonSvg(options: NormalizeSvgOptions): NormalizedSvgResult {
  const ctx = context(options.source);
  let source: string;
  try { source = new TextDecoder("utf8", { fatal: true }).decode(options.bytes); }
  catch { fail(ctx, "ARCHIVE_INVALID_UTF8", "Selected SVG is not valid UTF-8.", options.source); }
  const analysis = scanAnalyzeSvg(options.bytes, options.source, options.assetId).file;
  const common = analysis.profiles.commonV03;
  if (common.classification === "unsafe") fail(ctx, "IMPORT_UNSAFE_SOURCE", "Unsafe SVG content cannot be normalized.", options.source);
  if (common.classification === "unsupported") fail(ctx, "IMPORT_UNSUPPORTED_SOURCE", "Unsupported SVG content cannot be normalized.", options.source);
  const authority = normalizationAuthorityFor(options.map, options.source);
  const operations = new Set<NormalizationOperationCode>(common.normalizations);
  if (noncanonicalParserWhitespace(source)) operations.add("canonicalize_parser_whitespace");
  if (common.normalizations.includes("accessibility_authority_required") && authority !== undefined) operations.add(authority === "decorative" ? "declare_decorative" : "accessibility_authority_required");
  if (operations.size === 0) fail(ctx, "IMPORT_NORMALIZATION_REQUIRED", "Source differs from canonical schema 2 without an authorized exact-common operation.", options.source);
  const transformed = transformDocument(source, options.assetId, authority, common.normalizations, ctx);
  const svg = unwrap(parseSvgV2(transformed, options.source));
  const asset: NormalizedAssetV2 = { schemaVersion: 2, id: options.assetId, filename: options.filename, svg };
  const canonicalSvg = unwrap(serializeSvgV2(svg, options.source));
  unwrap(parseSvgV2(canonicalSvg, options.source));
  const rawParsed = parseSvgV2(source, options.source);
  const beforeSemanticDigest = rawParsed.ok
    ? computeAssetSemanticDigest({ schemaVersion: 2, id: options.assetId, filename: options.filename, svg: rawParsed.value })
    : null;
  const semanticDigest = computeAssetSemanticDigest(asset);
  return {
    asset,
    canonicalSvg,
    ledger: {
      source: options.source,
      sourceDigest: computeSha256(options.bytes),
      schema1Classification: analysis.profiles.schema1.classification,
      commonV03Classification: common.classification,
      consumedAccessibilityAuthority: common.normalizations.includes("accessibility_authority_required") ? authority ?? null : null,
      operations: ordered(operations),
      beforeSemanticDigest,
      afterCanonicalDigest: semanticDigest,
      policyDigest: options.policy.policyDigest,
      disposition: "normalized",
    },
  };
}
