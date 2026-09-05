import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** @typedef {typeof import("../src/design-evidence/index.js")} DesignEvidenceModule */
/** @typedef {import("../src/design-evidence/index.js").DesignEvidencePacketV1} DesignEvidencePacketV1 */

async function loadDesignEvidenceModule() {
  const moduleUrl = new URL("../dist/design-evidence/index.js", import.meta.url);
  try {
    /** @type {DesignEvidenceModule} */
    const module = await import(moduleUrl.href);
    return module;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load compiled product modules: ${details}. Run 'npm run build' first.`);
  }
}

const { computeDesignEvidenceDigest, serializeDesignEvidencePacket } = await loadDesignEvidenceModule();

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "protocol/tfsb-design-evidence-v1/examples");
const zero = `sha256:${"0".repeat(64)}`;
const protocolResults = JSON.parse(await readFile(resolve(root, "protocol/tfsb-studio-v1/examples/1.2/results.json"), "utf8"));
/** @type {Record<string, any>} */
const currentVisual = protocolResults["brand.visual.evidence.get"];
const check = process.argv.includes("--check");

/** @param {Uint8Array | string} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** @param {unknown} value @returns {unknown} */
const sortedJson = (value) => Array.isArray(value) ? value.map(sortedJson) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortedJson(child)])) : value;
/** @param {unknown} value */
const canonicalJson = (value) => JSON.stringify(sortedJson(value));

/**
 * @param {Record<string, any>} packet
 * @param {"briefDigest" | "candidateDigest" | "reviewDigest"} field
 * @returns {Record<string, any>}
 */
const withDigest = (packet, field) => {
  const candidate = { ...packet, [field]: zero };
  return {
    ...candidate,
    [field]: computeDesignEvidenceDigest(/** @type {DesignEvidencePacketV1} */ (/** @type {unknown} */ (candidate))),
  };
};

/** @param {Record<string, any>} visual @returns {Record<string, any>} */
const withVisualDigest = (visual) => {
  const { evidenceDigest: omittedDigest, ...withoutDigest } = visual; void omittedDigest;
  const projection = { ...withoutDigest, artifacts: visual.artifacts.map((/** @type {Record<string, any>} */ artifact) => {
    const { bytesBase64: omitted, ...withoutBytes } = artifact;
    void omitted;
    return withoutBytes;
  }) };
  return { ...withoutDigest, evidenceDigest: `sha256:${sha256(`tfsb.studio-visual-evidence-v1\n${canonicalJson(projection)}`)}` };
};

/** @param {string} role @returns {Record<string, any>} */
const roleArtifact = (role) => ({ ...currentVisual.artifacts[0], role });
const diffVisual = withVisualDigest({
  ...currentVisual, kind: "brand-diff", sourceDigest: zero, target: { ...currentVisual.target, assetId: "brand-wordmark" }, artifacts: [roleArtifact("before"), roleArtifact("after")], difference: { changedPixels: 0, maximumChannelDelta: 0, changedBounds: null, claim: "pixel-equal-for-this-renderer-and-case-only" },
});
const baselineVisual = withVisualDigest({
  ...currentVisual, kind: "qa-baseline", qaDigest: zero, target: { ...currentVisual.target, assetId: "brand-mark-baseline" }, artifacts: [roleArtifact("baseline"), roleArtifact("current")], difference: { changedPixels: 0, maximumChannelDelta: 0, changedBounds: null, claim: "pixel-equal-for-this-renderer-and-case-only" },
});

const brief = withDigest({
  schema: "tfsb.design-brief", schemaVersion: 1, briefId: "terminal-nova-mark", revision: 1,
  title: "Terminal Nova Café mark review", objective: "Compare profile: compact and align / center treatments while preserving the current brand system.",
  context: { corePackageVersion: "0.4.0", studioVersion: "0.1.0", studioProtocolVersion: "1.2", project: { label: "Terminal Nova demo", canonicalDigest: zero, brandSystemDigest: zero }, source: { packageId: "@knowledge-forge-ai/theme-forge-stellar-burst", brandVersion: "0.3.0", brandSystemDigest: zero } },
  targets: [
    { targetId: "brand-mark", selector: { kind: "asset", assetId: "brand-mark" }, canonicalAssetDigest: zero, svgDigest: zero, purpose: "mark" },
    { targetId: "brand-wordmark", selector: { kind: "binding", family: "terminal-nova", role: "wordmark", variant: "primary" }, canonicalAssetDigest: zero, svgDigest: zero, purpose: "wordmark" },
  ],
  constraints: { allowedProposalKinds: ["consumer-install", "derive", "evidence-only"], requiredTokenIds: ["color.canvas", "color.mark"], requiredRecipeIds: ["mark-small"], qaProfileIds: ["profile.compact"], renderTuples: [{ width: 16, height: 16, background: "transparent" }, { width: 256, height: 128, background: "token:canvas-dark" }], acceptanceCriteria: ["The mark remains legible at sixteen pixels.", "Unicode Café labels remain NFC."], prohibitedChanges: ["Do not change package, project, or plan authority."] },
  materials: [{ kind: "tfsb-rendered", identifier: "brand-mark-current", digest: currentVisual.evidenceDigest }], visualEvidence: [currentVisual],
}, "briefDigest");

const candidateA = withDigest({
  schema: "tfsb.design-candidate", schemaVersion: 1, briefDigest: brief.briefDigest, candidateId: "candidate-a", revision: 1,
  author: { kind: "agent", label: "External packet simulator", toolName: "public-api-fixture", toolVersion: "1.0.0" }, title: "Recipe-directed Café candidate", rationale: "Use profile: compact and align / center while keeping plan authority in TFSB.",
  proposal: { kind: "derive", selection: { kind: "recipes", recipeIds: ["mark-small"] } }, claims: [{ category: "small-size", severity: "note", message: "The supplied renders are intended for multi-artifact review." }], qaSummary: { status: "unavailable" },
  materials: [{ kind: "external-claim", identifier: "agent-rationale", digest: diffVisual.evidenceDigest }, { kind: "tfsb-rendered", identifier: "candidate-a-render", digest: currentVisual.evidenceDigest }], visualEvidence: [diffVisual, currentVisual],
}, "candidateDigest");

const candidateB = withDigest({
  schema: "tfsb.design-candidate", schemaVersion: 1, briefDigest: brief.briefDigest, candidateId: "candidate-b", revision: 2, revisionOf: candidateA.candidateDigest,
  author: { kind: "human", label: "Fixture designer" }, title: "Consumer profile candidate", rationale: "Compare a consumer intent with exact scoped source-package provenance.",
  proposal: { kind: "consumer-install", sourcePackages: [{ packageId: "@knowledge-forge-ai/tfsb-raster-resvg", brandVersion: "0.1.0", brandSystemDigest: zero }, { packageId: "@knowledge-forge-ai/theme-forge-stellar-burst", brandVersion: "0.3.0", brandSystemDigest: zero }].sort((left, right) => Buffer.compare(Buffer.from(left.packageId), Buffer.from(right.packageId))), profileIds: ["profile.compact"], parameters: [{ profileId: "profile.compact", values: [{ parameter: "alignment", value: "center" }] }] }, claims: [{ category: "brand-fit", severity: "minor", message: "Human review is required before disposition." }], qaSummary: { status: "skipped" },
  materials: [{ kind: "external-claim", identifier: "candidate-b-claim", digest: baselineVisual.evidenceDigest }], visualEvidence: [baselineVisual],
}, "candidateDigest");

const candidateDigests = [candidateA.candidateDigest, candidateB.candidateDigest].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
const annotations = [
  { annotationId: "artifact-note", candidateDigest: candidateA.candidateDigest, visualEvidenceDigest: diffVisual.evidenceDigest, artifactRole: "after", pngDigest: diffVisual.artifacts[1].pngDigest, scope: { kind: "artifact" }, category: "small-size", severity: "note", comment: "Review the complete after artifact at the target size." },
  { annotationId: "region-note", candidateDigest: candidateB.candidateDigest, visualEvidenceDigest: baselineVisual.evidenceDigest, artifactRole: "baseline", pngDigest: baselineVisual.artifacts[0].pngDigest, scope: { kind: "region", xMillionths: 100000, yMillionths: 100000, widthMillionths: 400000, heightMillionths: 400000 }, category: "alignment", severity: "minor", comment: "Inspect align / center in this normalized region." },
];
const review = withDigest({
  schema: "tfsb.design-review", schemaVersion: 1, briefDigest: brief.briefDigest, candidateDigests, annotations,
  dispositions: candidateDigests.map((candidateDigest) => ({ candidateDigest, disposition: candidateDigest === candidateA.candidateDigest ? "preferred" : "needs-revision" })), overallDisposition: { kind: "needs-revision", candidateDigest: candidateB.candidateDigest }, summary: "Candidate A is preferred; candidate B needs-revision for the profile: compact alignment.",
}, "reviewDigest");

/**
 * @param {Record<string, any>} packet
 * @param {"briefDigest" | "candidateDigest" | "reviewDigest"} field
 * @param {(packet: Record<string, any>) => void} change
 * @returns {Record<string, any>}
 */
const mutate = (packet, field, change) => {
  const changed = structuredClone(packet);
  change(changed);
  return withDigest(changed, field);
};
const negativeCorpus = {
  schema: "tfsb.design-evidence-negative-corpus",
  schemaVersion: 1,
  cases: [
    { id: "brief-non-nfc", packet: mutate(brief, "briefDigest", (packet) => { packet.objective = "Cafe\u0301"; }) },
    { id: "brief-unsorted-targets", packet: mutate(brief, "briefDigest", (packet) => { packet.targets.reverse(); }) },
    { id: "brief-invalid-scoped-package", packet: mutate(brief, "briefDigest", (packet) => { packet.context.source.packageId = "@Knowledge/theme"; }) },
    { id: "brief-invalid-token-background", packet: mutate(brief, "briefDigest", (packet) => { packet.constraints.renderTuples[1].background = "token:Canvas"; }) },
    { id: "candidate-source-package-cap", packet: mutate(candidateB, "candidateDigest", (packet) => { packet.proposal.sourcePackages = Array.from({ length: 9 }, (_, index) => ({ packageId: `package-${index}`, brandVersion: "1.0.0", brandSystemDigest: zero })); }) },
    { id: "candidate-parameter-value-bytes", packet: mutate(candidateB, "candidateDigest", (packet) => { packet.proposal.parameters[0].values[0].value = "x".repeat(513); }) },
    { id: "candidate-unsorted-materials", packet: mutate(candidateA, "candidateDigest", (packet) => { packet.materials.reverse(); }) },
    { id: "candidate-invalid-artifact-role", packet: mutate(candidateA, "candidateDigest", (packet) => { packet.visualEvidence[0].artifacts[0].role = "preview"; }) },
    { id: "review-unsorted-annotations", packet: mutate(review, "reviewDigest", (packet) => { packet.annotations.reverse(); }) },
    { id: "review-overall-mismatch", packet: mutate(review, "reviewDigest", (packet) => { packet.overallDisposition = { kind: "approved", candidateDigest: candidateA.candidateDigest }; }) },
    { id: "review-rejected-all-mismatch", packet: mutate(review, "reviewDigest", (packet) => { packet.overallDisposition = { kind: "rejected-all" }; }) },
    { id: "review-no-decision-with-preferred", packet: mutate(review, "reviewDigest", (packet) => { packet.overallDisposition = { kind: "no-decision" }; }) },
  ],
};

const examples = { "brief.json": brief, "candidate-a.json": candidateA, "candidate-b.json": candidateB, "review.json": review };
const outputs = new Map(Object.entries(examples).map(([name, packet]) => [name, serializeDesignEvidencePacket(/** @type {DesignEvidencePacketV1} */ (/** @type {unknown} */ (packet)))]));
const inventoryPath = resolve(root, "protocol/tfsb-design-evidence-v1/inventory.json");
const negativeCorpusPath = resolve(root, "protocol/tfsb-design-evidence-v1/negative-corpus.json");
const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
inventory.examples = [...outputs].map(([name, bytes]) => ({ name, sha256: sha256(bytes) }));
const negativeCorpusBytes = `${JSON.stringify(negativeCorpus, null, 2)}\n`;
inventory.negativeCorpus = { name: "negative-corpus.json", cases: negativeCorpus.cases.length, sha256: sha256(negativeCorpusBytes) };
const inventoryBytes = `${JSON.stringify(inventory, null, 2)}\n`;

if (check) {
  for (const [name, bytes] of outputs) if (await readFile(resolve(destination, name), "utf8") !== bytes) throw new Error(`design-evidence example drift: ${name}`);
  if (await readFile(negativeCorpusPath, "utf8") !== negativeCorpusBytes) throw new Error("design-evidence negative corpus drift");
  if (await readFile(inventoryPath, "utf8") !== inventoryBytes) throw new Error("design-evidence inventory drift");
} else {
  await mkdir(destination, { recursive: true });
  for (const [name, bytes] of outputs) await writeFile(resolve(destination, name), bytes, "utf8");
  await writeFile(negativeCorpusPath, negativeCorpusBytes, "utf8");
  await writeFile(inventoryPath, inventoryBytes, "utf8");
}
