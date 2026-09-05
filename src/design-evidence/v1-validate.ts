import { parseDuplicateFreeJson } from "../brand/consumer-lock.js";
import { validateVisualEvidenceResult } from "../service-protocol/v1-validate.js";
import { canonicalDesignEvidenceJson, computeDesignEvidenceDigest } from "./v1-canonical.js";
import type {
  CandidateProposalIntentV1, DesignCandidatePacketV1, DesignEvidenceMaterialV1,
  DesignEvidencePacketV1, DesignEvidenceRenderTupleV1, DesignEvidenceTargetV1,
  DesignReviewPacketV1, ReviewAnnotationV1,
} from "./v1-types.js";

export const DESIGN_EVIDENCE_LIMITS = Object.freeze({
  packetBytes: 16_777_216,
  visualBytes: 8_388_608,
  visualEntries: 8,
  targets: 32,
  renderTuples: 16,
  candidates: 8,
  claims: 64,
  annotations: 128,
  acceptanceCriteria: 64,
  prohibitedChanges: 64,
  sourcePackages: 8,
  profileIds: 32,
  parameterSelections: 32,
  parameterValues: 32,
  parameterValueBytes: 512,
  licenseExpressionBytes: 256,
  materials: 64,
  textBytes: 4_096,
  annotationCommentBytes: 2_048,
});

type Rec = Record<string, unknown>;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/u;
const PACKAGE_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
const PROPOSALS = ["evidence-only", "derive", "qa-baseline", "consumer-install", "consumer-sync", "export"] as const;
const CLAIM_CATEGORIES = ["composition", "alignment", "spacing", "legibility", "contrast", "color", "brand-fit", "accessibility", "small-size", "technical", "other"] as const;
const CLAIM_SEVERITIES = ["note", "minor", "substantive", "blocking"] as const;

export class DesignEvidenceValidationError extends Error {
  readonly code = "DESIGN_EVIDENCE_INVALID";
  constructor(message: string) { super(message); this.name = "DesignEvidenceValidationError"; }
}

function invalid(message: string): never { throw new DesignEvidenceValidationError(message); }
function record(value: unknown, path: string): Rec {
  const prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) invalid(`${path} must be an object.`);
  return value as Rec;
}
function exact(value: Rec, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`Unknown field ${key}.`);
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`Missing field ${key}.`);
}
function array(value: unknown, path: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid(`${path} has an invalid item count.`);
  return value;
}
function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid(`${path} must be a bounded safe integer.`);
  return value as number;
}
function safeText(value: unknown, path: string, maximum: number = DESIGN_EVIDENCE_LIMITS.textBytes, lineBreaks = false): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > maximum || value.normalize("NFC") !== value) invalid(`${path} must be bounded NFC text.`);
  const controls = lineBreaks ? /[\u0000-\u0009\u000b-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u;
  if (controls.test(value)) invalid(`${path} contains a control character.`);
  return value;
}
function id(value: unknown, path: string): string { const result = safeText(value, path, 128); if (!ID.test(result)) invalid(`${path} is not a public identifier.`); return result; }
function digest(value: unknown, path: string): string { if (typeof value !== "string" || !DIGEST.test(value)) invalid(`${path} is not a SHA-256 digest.`); return value; }
function packageId(value: unknown, path: string): string { const result = safeText(value, path, 214); if (!PACKAGE_ID.test(result)) invalid(`${path} is not a package identity.`); return result; }
function version(value: unknown, path: string): string { const result = safeText(value, path, 64); if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(result)) invalid(`${path} is not a version.`); return result; }
function enumeration<T extends string>(value: unknown, values: readonly T[], path: string): T { if (typeof value !== "string" || !values.includes(value as T)) invalid(`${path} is invalid.`); return value as T; }
function sortedUnique(values: unknown, path: string, maximum: number, validator: (value: unknown, path: string) => string, minimum = 0): string[] {
  const items = array(values, path, minimum, maximum).map((value, index) => validator(value, `${path}[${index}]`));
  const sorted = [...items].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (new Set(items).size !== items.length || items.some((value, index) => value !== sorted[index])) invalid(`${path} must be UTF-8 sorted and unique.`);
  return items;
}

function assertSortedUnique(items: readonly string[], path: string): void {
  const sorted = [...items].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (new Set(items).size !== items.length || items.some((value, index) => value !== sorted[index])) invalid(`${path} must be UTF-8 sorted and unique.`);
}

function validateContext(raw: unknown): void {
  const value = record(raw, "context"); exact(value, ["corePackageVersion", "studioVersion", "studioProtocolVersion", "project"], ["source"]);
  if (value.corePackageVersion !== "0.4.0" || value.studioVersion !== "0.1.0" || value.studioProtocolVersion !== "1.2") invalid("Packet version context is invalid.");
  const project = record(value.project, "context.project"); exact(project, ["canonicalDigest", "brandSystemDigest"], ["label"]); digest(project.canonicalDigest, "context.project.canonicalDigest"); digest(project.brandSystemDigest, "context.project.brandSystemDigest"); if (project.label !== undefined) safeText(project.label, "context.project.label", 256);
  if (value.source !== undefined) { const source = record(value.source, "context.source"); exact(source, ["packageId", "brandVersion", "brandSystemDigest"]); packageId(source.packageId, "context.source.packageId"); version(source.brandVersion, "context.source.brandVersion"); digest(source.brandSystemDigest, "context.source.brandSystemDigest"); }
}

function validateTarget(raw: unknown, index: number): string {
  const value = record(raw, `targets[${index}]`); exact(value, ["targetId", "selector", "canonicalAssetDigest", "svgDigest", "purpose"]);
  const targetId = id(value.targetId, `targets[${index}].targetId`); digest(value.canonicalAssetDigest, `targets[${index}].canonicalAssetDigest`); digest(value.svgDigest, `targets[${index}].svgDigest`); id(value.purpose, `targets[${index}].purpose`);
  const selector = record(value.selector, `targets[${index}].selector`);
  if (selector.kind === "asset") { exact(selector, ["kind", "assetId"]); id(selector.assetId, `targets[${index}].selector.assetId`); }
  else if (selector.kind === "binding") { exact(selector, ["kind", "family", "role", "variant"]); id(selector.family, "selector.family"); id(selector.role, "selector.role"); id(selector.variant, "selector.variant"); }
  else invalid(`targets[${index}].selector kind is invalid.`);
  return targetId;
}

function validateRenderTuple(raw: unknown, index: number): void {
  const value = record(raw, `constraints.renderTuples[${index}]`); exact(value, ["width", "height", "background"]);
  integer(value.width, "render width", 16, 1_024); integer(value.height, "render height", 16, 1_024);
  const background = safeText(value.background, "render background", 128);
  if (background !== "transparent" && !/^token:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(background) && !/^#[0-9A-F]{8}$/u.test(background)) invalid("Render background is invalid.");
}

function validateMaterial(raw: unknown, index: number): string {
  const value = record(raw, `materials[${index}]`); exact(value, ["kind", "identifier", "digest"], ["licenseExpression", "noticeDigest"]);
  enumeration(value.kind, ["user-supplied", "tfsb-rendered", "third-party", "external-claim"], `materials[${index}].kind`);
  const identifier = id(value.identifier, `materials[${index}].identifier`); digest(value.digest, `materials[${index}].digest`);
  if (value.licenseExpression !== undefined) safeText(value.licenseExpression, `materials[${index}].licenseExpression`, DESIGN_EVIDENCE_LIMITS.licenseExpressionBytes);
  if (value.noticeDigest !== undefined) digest(value.noticeDigest, `materials[${index}].noticeDigest`);
  return `${String(value.kind)}\u0000${identifier}\u0000${String(value.digest)}`;
}

function validateMaterials(raw: unknown): void {
  const values = array(raw, "materials", 0, DESIGN_EVIDENCE_LIMITS.materials); const identities = values.map(validateMaterial);
  assertSortedUnique(identities, "materials");
}

function validateVisualEvidence(raw: unknown, minimum: number): void {
  const values = array(raw, "visualEvidence", minimum, DESIGN_EVIDENCE_LIMITS.visualEntries);
  let bytes = 0; const identities = new Set<string>();
  for (const value of values) {
    try { validateVisualEvidenceResult(value); } catch { invalid("Visual evidence is invalid."); }
    const evidence = value as { readonly evidenceDigest: string; readonly artifacts: readonly { readonly byteLength: number }[] };
    if (identities.has(evidence.evidenceDigest)) invalid("Visual evidence identities must be unique."); identities.add(evidence.evidenceDigest);
    bytes += evidence.artifacts.reduce((total, artifact) => total + artifact.byteLength, 0);
  }
  if (bytes > DESIGN_EVIDENCE_LIMITS.visualBytes) invalid("Decoded visual evidence exceeds the packet limit.");
}

function validateBrief(value: Rec): void {
  exact(value, ["schema", "schemaVersion", "briefId", "revision", "title", "objective", "context", "targets", "constraints", "materials", "visualEvidence", "briefDigest"]);
  id(value.briefId, "briefId"); integer(value.revision, "revision", 1, Number.MAX_SAFE_INTEGER); safeText(value.title, "title", 512); safeText(value.objective, "objective", 4_096, true); validateContext(value.context);
  const targets = array(value.targets, "targets", 1, DESIGN_EVIDENCE_LIMITS.targets).map(validateTarget); assertSortedUnique(targets, "targets");
  const constraints = record(value.constraints, "constraints"); exact(constraints, ["allowedProposalKinds", "requiredTokenIds", "requiredRecipeIds", "qaProfileIds", "renderTuples", "acceptanceCriteria", "prohibitedChanges"]);
  sortedUnique(constraints.allowedProposalKinds, "constraints.allowedProposalKinds", PROPOSALS.length, (entry, path) => enumeration(entry, PROPOSALS, path), 1);
  sortedUnique(constraints.requiredTokenIds, "constraints.requiredTokenIds", 128, id); sortedUnique(constraints.requiredRecipeIds, "constraints.requiredRecipeIds", 128, id); sortedUnique(constraints.qaProfileIds, "constraints.qaProfileIds", 128, id);
  array(constraints.renderTuples, "constraints.renderTuples", 1, DESIGN_EVIDENCE_LIMITS.renderTuples).forEach(validateRenderTuple);
  array(constraints.acceptanceCriteria, "constraints.acceptanceCriteria", 1, DESIGN_EVIDENCE_LIMITS.acceptanceCriteria).forEach((entry, index) => safeText(entry, `acceptanceCriteria[${index}]`, 4_096, true));
  array(constraints.prohibitedChanges, "constraints.prohibitedChanges", 0, DESIGN_EVIDENCE_LIMITS.prohibitedChanges).forEach((entry, index) => safeText(entry, `prohibitedChanges[${index}]`, 4_096, true));
  validateMaterials(value.materials); validateVisualEvidence(value.visualEvidence, 0); digest(value.briefDigest, "briefDigest");
}

function validateSourcePackages(raw: unknown): void {
  const values = array(raw, "proposal.sourcePackages", 1, DESIGN_EVIDENCE_LIMITS.sourcePackages); const ids: string[] = [];
  for (const [index, rawValue] of values.entries()) { const value = record(rawValue, `sourcePackages[${index}]`); exact(value, ["packageId", "brandVersion", "brandSystemDigest"]); ids.push(packageId(value.packageId, "sourcePackages.packageId")); version(value.brandVersion, "sourcePackages.brandVersion"); digest(value.brandSystemDigest, "sourcePackages.brandSystemDigest"); }
  const sorted = [...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))); if (new Set(ids).size !== ids.length || ids.some((entry, index) => entry !== sorted[index])) invalid("Source packages must be sorted and unique.");
}
function validateParameters(raw: unknown): void {
  const values = array(raw, "proposal.parameters", 0, DESIGN_EVIDENCE_LIMITS.parameterSelections); const profiles: string[] = [];
  for (const rawValue of values) { const value = record(rawValue, "proposal.parameter"); exact(value, ["profileId", "values"]); profiles.push(id(value.profileId, "parameter.profileId")); const entries = array(value.values, "parameter.values", 0, DESIGN_EVIDENCE_LIMITS.parameterValues); const keys: string[] = []; for (const rawEntry of entries) { const entry = record(rawEntry, "parameter.value"); exact(entry, ["parameter", "value"]); keys.push(id(entry.parameter, "parameter.value.parameter")); safeText(entry.value, "parameter.value.value", DESIGN_EVIDENCE_LIMITS.parameterValueBytes); } assertSortedUnique(keys, "parameter values"); }
  assertSortedUnique(profiles, "parameter profile IDs");
}
function validateProposal(raw: unknown): void {
  const value = record(raw, "proposal"); const kind = enumeration(value.kind, PROPOSALS, "proposal.kind");
  if (kind === "evidence-only") exact(value, ["kind"]);
  else if (kind === "derive") { exact(value, ["kind", "selection"]); const selection = record(value.selection, "proposal.selection"); if (selection.kind === "all") exact(selection, ["kind"]); else if (selection.kind === "recipes") { exact(selection, ["kind", "recipeIds"]); sortedUnique(selection.recipeIds, "proposal.selection.recipeIds", 128, id, 1); } else invalid("Derive selection is invalid."); }
  else if (kind === "qa-baseline") { exact(value, ["kind", "profileId", "caseId"]); id(value.profileId, "proposal.profileId"); id(value.caseId, "proposal.caseId"); }
  else if (kind === "consumer-install") { exact(value, ["kind", "sourcePackages", "profileIds", "parameters"]); validateSourcePackages(value.sourcePackages); sortedUnique(value.profileIds, "proposal.profileIds", DESIGN_EVIDENCE_LIMITS.profileIds, id, 1); validateParameters(value.parameters); }
  else if (kind === "consumer-sync") { exact(value, ["kind", "sourcePackages"], ["profileIds", "parameters"]); validateSourcePackages(value.sourcePackages); if (value.profileIds !== undefined) sortedUnique(value.profileIds, "proposal.profileIds", DESIGN_EVIDENCE_LIMITS.profileIds, id, 1); if (value.parameters !== undefined) validateParameters(value.parameters); }
  else { exact(value, ["kind", "profileId"], ["outputIds"]); id(value.profileId, "proposal.profileId"); if (value.outputIds !== undefined) sortedUnique(value.outputIds, "proposal.outputIds", 128, id, 1); }
}

function validateCandidate(value: Rec): void {
  exact(value, ["schema", "schemaVersion", "briefDigest", "candidateId", "revision", "author", "title", "rationale", "proposal", "claims", "qaSummary", "materials", "visualEvidence", "candidateDigest"], ["revisionOf"]);
  digest(value.briefDigest, "briefDigest"); id(value.candidateId, "candidateId"); integer(value.revision, "revision", 1, Number.MAX_SAFE_INTEGER); if (value.revisionOf !== undefined) digest(value.revisionOf, "revisionOf");
  const author = record(value.author, "author"); exact(author, ["kind", "label"], ["toolName", "toolVersion"]); enumeration(author.kind, ["human", "agent", "tool"], "author.kind"); safeText(author.label, "author.label", 256); if (author.toolName !== undefined) safeText(author.toolName, "author.toolName", 256); if (author.toolVersion !== undefined) safeText(author.toolVersion, "author.toolVersion", 128);
  safeText(value.title, "title", 512); safeText(value.rationale, "rationale", 4_096, true); validateProposal(value.proposal);
  for (const [index, rawClaim] of array(value.claims, "claims", 0, DESIGN_EVIDENCE_LIMITS.claims).entries()) { const claim = record(rawClaim, `claims[${index}]`); exact(claim, ["category", "severity", "message"]); enumeration(claim.category, CLAIM_CATEGORIES, "claim.category"); enumeration(claim.severity, CLAIM_SEVERITIES, "claim.severity"); safeText(claim.message, "claim.message", 4_096, true); }
  const qa = record(value.qaSummary, "qaSummary"); exact(qa, ["status"], ["qaResultDigest"]); enumeration(qa.status, ["pass", "fail", "skipped", "unavailable", "error"], "qaSummary.status"); if (qa.qaResultDigest !== undefined) digest(qa.qaResultDigest, "qaSummary.qaResultDigest");
  validateMaterials(value.materials); validateVisualEvidence(value.visualEvidence, 1); digest(value.candidateDigest, "candidateDigest");
}

function validateAnnotation(raw: unknown, index: number, candidates: ReadonlySet<string>): void {
  const value = record(raw, `annotations[${index}]`); exact(value, ["annotationId", "candidateDigest", "visualEvidenceDigest", "artifactRole", "pngDigest", "scope", "category", "severity", "comment"], ["elementId"]);
  id(value.annotationId, "annotationId"); const candidate = digest(value.candidateDigest, "annotation.candidateDigest"); if (!candidates.has(candidate)) invalid("Annotation candidate is absent from the review."); digest(value.visualEvidenceDigest, "annotation.visualEvidenceDigest"); enumeration(value.artifactRole, ["current", "baseline", "before", "after"], "annotation.artifactRole"); digest(value.pngDigest, "annotation.pngDigest"); enumeration(value.category, CLAIM_CATEGORIES, "annotation.category"); enumeration(value.severity, CLAIM_SEVERITIES, "annotation.severity"); safeText(value.comment, "annotation.comment", DESIGN_EVIDENCE_LIMITS.annotationCommentBytes, true); if (value.elementId !== undefined) id(value.elementId, "annotation.elementId");
  const scope = record(value.scope, "annotation.scope"); if (scope.kind === "artifact") exact(scope, ["kind"]); else if (scope.kind === "region") { exact(scope, ["kind", "xMillionths", "yMillionths", "widthMillionths", "heightMillionths"]); const x = integer(scope.xMillionths, "region.xMillionths", 0, 1_000_000), y = integer(scope.yMillionths, "region.yMillionths", 0, 1_000_000), width = integer(scope.widthMillionths, "region.widthMillionths", 1, 1_000_000), height = integer(scope.heightMillionths, "region.heightMillionths", 1, 1_000_000); if (x + width > 1_000_000 || y + height > 1_000_000) invalid("Annotation region escapes its image."); } else invalid("Annotation scope is invalid.");
}

function validateReview(value: Rec): void {
  exact(value, ["schema", "schemaVersion", "briefDigest", "candidateDigests", "annotations", "dispositions", "overallDisposition", "summary", "reviewDigest"], ["previousReviewDigest"]);
  digest(value.briefDigest, "briefDigest"); const candidates = new Set(sortedUnique(value.candidateDigests, "candidateDigests", DESIGN_EVIDENCE_LIMITS.candidates, digest, 1)); if (value.previousReviewDigest !== undefined) digest(value.previousReviewDigest, "previousReviewDigest");
  const annotationIds: string[] = []; for (const [index, raw] of array(value.annotations, "annotations", 0, DESIGN_EVIDENCE_LIMITS.annotations).entries()) { validateAnnotation(raw, index, candidates); annotationIds.push((raw as Rec).annotationId as string); } assertSortedUnique(annotationIds, "annotations");
  const dispositions = array(value.dispositions, "dispositions", candidates.size, candidates.size); const seen = new Set<string>(); let selected: { candidate: string; value: string } | undefined; let nonUnreviewed = 0;
  for (const raw of dispositions) { const disposition = record(raw, "disposition"); exact(disposition, ["candidateDigest", "disposition"]); const candidate = digest(disposition.candidateDigest, "disposition.candidateDigest"); if (!candidates.has(candidate) || seen.has(candidate)) invalid("Disposition candidate set is invalid."); seen.add(candidate); const status = enumeration(disposition.disposition, ["unreviewed", "preferred", "approved", "rejected", "needs-revision", "deferred"], "disposition.disposition"); if (status !== "unreviewed") nonUnreviewed++; if (status === "preferred" || status === "approved") { if (selected !== undefined) invalid("At most one candidate may be preferred or approved."); selected = { candidate, value: status }; } }
  assertSortedUnique(dispositions.map((raw) => String((raw as Rec).candidateDigest)), "dispositions");
  if (nonUnreviewed === 0) invalid("Review export requires a disposition.");
  const overall = record(value.overallDisposition, "overallDisposition"); const kind = enumeration(overall.kind, ["no-decision", "preferred", "approved", "needs-revision", "rejected-all"], "overallDisposition.kind");
  if (kind === "preferred" || kind === "approved" || kind === "needs-revision") { exact(overall, ["kind", "candidateDigest"]); const candidate = digest(overall.candidateDigest, "overallDisposition.candidateDigest"); if (!candidates.has(candidate)) invalid("Overall candidate is absent."); const matching = dispositions.filter((raw) => (raw as Rec).candidateDigest === candidate && (raw as Rec).disposition === kind); if (matching.length !== 1) invalid("Overall and candidate dispositions disagree."); }
  else { exact(overall, ["kind"]); if (kind === "no-decision" && selected !== undefined) invalid("No-decision cannot coexist with a preferred or approved candidate."); if (kind === "rejected-all" && dispositions.some((raw) => (raw as Rec).disposition !== "rejected")) invalid("Rejected-all requires every candidate to be rejected."); }
  safeText(value.summary, "summary", 4_096, true); digest(value.reviewDigest, "reviewDigest");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === "object" && !seen.has(value)) { seen.add(value); for (const child of Object.values(value as Rec)) deepFreeze(child, seen); Object.freeze(value); }
  return value;
}

export function validateDesignEvidencePacket(raw: unknown): DesignEvidencePacketV1 {
  const value = record(raw, "packet");
  if (value.schemaVersion !== 1) invalid("Packet schemaVersion must be 1.");
  if (value.schema === "tfsb.design-brief") validateBrief(value);
  else if (value.schema === "tfsb.design-candidate") validateCandidate(value);
  else if (value.schema === "tfsb.design-review") validateReview(value);
  else invalid("Packet schema is invalid.");
  const packet = value as unknown as DesignEvidencePacketV1;
  const field = packet.schema === "tfsb.design-brief" ? packet.briefDigest : packet.schema === "tfsb.design-candidate" ? packet.candidateDigest : packet.reviewDigest;
  if (computeDesignEvidenceDigest(packet) !== field) invalid("Packet digest is invalid.");
  return deepFreeze(structuredClone(packet));
}

export function parseDesignEvidencePacket(input: string | Uint8Array): DesignEvidencePacketV1 {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (bytes.byteLength > DESIGN_EVIDENCE_LIMITS.packetBytes) invalid("Packet exceeds 16 MiB.");
  let source: string; try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return invalid("Packet is not strict UTF-8."); }
  if (source.startsWith("\uFEFF")) invalid("Packet must not contain a BOM.");
  let parsed: unknown; try { parsed = parseDuplicateFreeJson(source, { operation: "validate", domain: "brand" }); } catch { return invalid("Packet is not duplicate-free JSON."); }
  const packet = validateDesignEvidencePacket(parsed);
  if (canonicalDesignEvidenceJson(packet) !== source) invalid("Packet bytes are not canonical.");
  return packet;
}

export function validateDesignEvidenceReviewLinks(review: DesignReviewPacketV1, candidates: readonly DesignCandidatePacketV1[]): void {
  const byDigest = new Map(candidates.map((candidate) => [candidate.candidateDigest, candidate]));
  if (review.candidateDigests.length !== candidates.length || review.candidateDigests.some((digestValue) => !byDigest.has(digestValue))) invalid("Review candidate set does not match imported candidates.");
  for (const annotation of review.annotations) {
    const candidate = byDigest.get(annotation.candidateDigest); if (candidate === undefined) invalid("Annotation candidate is absent.");
    const evidence = candidate.visualEvidence.find((entry) => entry.evidenceDigest === annotation.visualEvidenceDigest); if (evidence === undefined) invalid("Annotation evidence is absent.");
    const artifact = evidence.artifacts.find((entry) => entry.role === annotation.artifactRole && entry.pngDigest === annotation.pngDigest); if (artifact === undefined) invalid("Annotation artifact is absent.");
  }
}

export type { CandidateProposalIntentV1, DesignEvidenceMaterialV1, DesignEvidenceRenderTupleV1, DesignEvidenceTargetV1, ReviewAnnotationV1 };
