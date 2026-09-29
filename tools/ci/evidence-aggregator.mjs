// @ts-check

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NATIVE_SNAPSHOT_TUPLES,
  NEBULAR_FUSION_PUBLIC_ARTIFACTS,
  NEBULAR_FUSION_PUBLIC_FAILURE_DIAGNOSTICS,
  NEBULAR_FUSION_PUBLIC_REQUIRED_JOBS,
  NEBULAR_FUSION_PUBLIC_SECURITY_REPORTS,
  RASTER_COMPANION_TUPLES,
  REQUIRED_JOBS,
  SECURITY_REPORT_ROLES,
  STELLAR_BURST_PUBLIC_ADVISORY_ARTIFACTS,
  STELLAR_BURST_PUBLIC_ADVISORY_JOBS,
  STELLAR_BURST_PUBLIC_ARTIFACTS,
  STELLAR_BURST_PUBLIC_REQUIRED_JOBS,
  STELLAR_BURST_PUBLIC_SECURITY_REPORTS,
  STELLAR_LOOM_PUBLIC_ARTIFACTS,
  STELLAR_LOOM_PUBLIC_REQUIRED_JOBS,
  STELLAR_LOOM_PUBLIC_SECURITY_REPORTS,
  STUDIO_ACL_TEN_COMMANDS,
  TERMINAL_NOVA_PUBLIC_ARTIFACTS,
  TERMINAL_NOVA_PUBLIC_REQUIRED_JOBS,
  TERMINAL_NOVA_PUBLIC_SECURITY_REPORTS,
  SOLAR_SAIL_PUBLIC_ARTIFACTS,
  SOLAR_SAIL_PUBLIC_REQUIRED_JOBS,
  SOLAR_SAIL_PUBLIC_SECURITY_REPORTS,
  securityReportArtifactName,
} from "./ci-contract.mjs";

/** @param {Uint8Array | Buffer | string} bytes */
function sha256Hex(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
/** @param {string} value */
function portable(value) { return value.replace(/\\/gu, "/"); }
/** @param {string} dir @returns {Promise<string[]>} */
async function regularFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await regularFiles(full));
    else if (entry.isFile()) files.push(full);
    else throw new Error(`Non-regular artifact entry is forbidden: ${entry.name}`);
  }
  return files;
}
/** @param {Record<string, unknown>} left @param {Record<string, unknown>} right */
function sameRecord(left, right) { return JSON.stringify(Object.entries(left ?? {}).sort()) === JSON.stringify(Object.entries(right ?? {}).sort()); }

/** @param {string} path @param {string} requirement */
function matchesRequirement(path, requirement) {
  if (requirement.startsWith("*")) return path.endsWith(requirement.slice(1));
  if (requirement.endsWith("*")) return path.startsWith(requirement.slice(0, -1));
  return path === requirement;
}

const PUBLIC_PRODUCTS = new Set(["stellar", "stellar-burst", "nebular", "nebular-fusion", "loom", "stellar-loom", "nova", "terminal-nova", "solar", "solar-sail"]);
const PUBLIC_EVENT_FIELDS = Object.freeze(["name", "action", "number", "repository", "baseRef", "baseSha", "headRef", "headSha"]);
const PUBLIC_REPOSITORY_FIELDS = Object.freeze(["repository", "baseRepository", "headRepository"]);
const PUBLIC_PULL_REQUEST_ACTIONS = new Set(["opened", "synchronize", "reopened"]);
const PUBLIC_SHA = /^[0-9a-f]{40}$/u;
const EXPECTED_PUBLIC_RECEIPT_SPECIFICATION = Object.freeze({
  directory: "expected-receipt",
  job: "evidence-aggregate",
  matrix: Object.freeze({}),
  required: Object.freeze([]),
  checkoutRole: "merge-candidate",
});

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

/** @param {unknown} value */
function isSha(value) { return typeof value === "string" && PUBLIC_SHA.test(value); }

/** @typedef {{directory: string, job: string, matrix: Readonly<Record<string, string>>, required: readonly string[], checkoutRole?: "staging-head" | "merge-candidate"}} ArtifactSpecification */
/** @type {Array<[string, string, string[]]>} */
const privateScalarArtifacts = [
  ["source-integrity-receipt", "source-integrity", ["receipt.json"]],
  ["root-package-artifacts", "root-package", ["receipt.json", "pack-manifest.json", "test-report.json", "audit-result.json", "root-package.tgz"]],
  ["visual-accessibility-artifacts", "visual-accessibility", ["receipt.json", "visual-summary.json"]],
  ["studio-frontend-artifacts", "studio-frontend", ["receipt.json", "studio-dist.tar.gz", "studio-test-report.json", "studio-audit.json"]],
  ["nebular-macos-arm64-artifacts", "nebular-macos-arm64", ["receipt.json", "node-authenticity/receipt.json", "node-runtime", "sidecar-payload.tar.gz", "sidecar-transcript.json", "nebular-fusion.app.tar.gz", "bundle-identity.json", "signing-facts.json"]],
  ["terminal-nova-integration-artifacts", "terminal-nova-integration", ["receipt.json", "operator-receipt.json", "tfsb48-r2-terminal-nova-migration.patch", "tfsb48-r2-terminal-nova-rollback.zip"]],
  ["supply-chain-artifacts", "supply-chain", ["receipt.json", "tfsb-complete.spdx.json", "THIRD_PARTY_NOTICES.md", "sbom-receipt.json", "root-audit.json", "studio-audit.json", "raster-audit.json", "cargo-audit.json", "cargo-metadata.json"]],
];

/** @type {readonly ArtifactSpecification[]} */
const privateArtifacts = Object.freeze([
  ...privateScalarArtifacts.map(([directory, job, required]) => Object.freeze({ directory, job, matrix: Object.freeze({}), required: Object.freeze(required) })),
  ...NATIVE_SNAPSHOT_TUPLES.map((tuple) => Object.freeze({ directory: `native-directory-snapshot-${tuple}`, job: "native-directory-snapshot", matrix: Object.freeze({ artifact: tuple }), required: Object.freeze(["receipt.json", "native-report.json", "native-addon-posix-openat-v1.node"]) })),
  ...RASTER_COMPANION_TUPLES.map((tuple) => Object.freeze({ directory: `raster-companion-${tuple}`, job: "raster-companion", matrix: Object.freeze({ tuple }), required: Object.freeze(["receipt.json", "raster-report.json", "root-package.tgz", "raster-companion.tgz"]) })),
]);

/**
 * Kept as the default export contract for the private combined workflow.
 * Public workflows select a product-specific inventory below.
 */
export const EXPECTED_DOWNLOADED_ARTIFACTS = privateArtifacts;

const stellarBurstContract = Object.freeze({
  canonicalProduct: "stellar-burst",
  requiredJobs: STELLAR_BURST_PUBLIC_REQUIRED_JOBS,
  advisoryJobs: STELLAR_BURST_PUBLIC_ADVISORY_JOBS,
  artifacts: STELLAR_BURST_PUBLIC_ARTIFACTS,
  advisoryArtifacts: STELLAR_BURST_PUBLIC_ADVISORY_ARTIFACTS,
  securityReports: STELLAR_BURST_PUBLIC_SECURITY_REPORTS,
});
const nebularFusionContract = Object.freeze({ canonicalProduct: "nebular-fusion", requiredJobs: NEBULAR_FUSION_PUBLIC_REQUIRED_JOBS, artifacts: NEBULAR_FUSION_PUBLIC_ARTIFACTS, securityReports: NEBULAR_FUSION_PUBLIC_SECURITY_REPORTS, failureDiagnostics: NEBULAR_FUSION_PUBLIC_FAILURE_DIAGNOSTICS });
const stellarLoomContract = Object.freeze({ canonicalProduct: "stellar-loom", requiredJobs: STELLAR_LOOM_PUBLIC_REQUIRED_JOBS, artifacts: STELLAR_LOOM_PUBLIC_ARTIFACTS, securityReports: STELLAR_LOOM_PUBLIC_SECURITY_REPORTS });
const terminalNovaContract = Object.freeze({ canonicalProduct: "terminal-nova", requiredJobs: TERMINAL_NOVA_PUBLIC_REQUIRED_JOBS, artifacts: TERMINAL_NOVA_PUBLIC_ARTIFACTS, securityReports: TERMINAL_NOVA_PUBLIC_SECURITY_REPORTS });
const solarSailContract = Object.freeze({ canonicalProduct: "solar-sail", requiredJobs: SOLAR_SAIL_PUBLIC_REQUIRED_JOBS, artifacts: SOLAR_SAIL_PUBLIC_ARTIFACTS, securityReports: SOLAR_SAIL_PUBLIC_SECURITY_REPORTS });

const PRODUCT_CONTRACTS = Object.freeze({
  private: Object.freeze({ requiredJobs: REQUIRED_JOBS, artifacts: privateArtifacts }),
  stellar: stellarBurstContract,
  "stellar-burst": stellarBurstContract,
  nebular: nebularFusionContract,
  "nebular-fusion": nebularFusionContract,
  loom: stellarLoomContract,
  "stellar-loom": stellarLoomContract,
  nova: terminalNovaContract,
  "terminal-nova": terminalNovaContract,
  solar: solarSailContract,
  "solar-sail": solarSailContract,
});

const SECURITY_ARTIFACT_PATTERN = /^security-((?:codeql|grype)-.+)-(raw|normalized)-(\d+)$/u;
const ATTEMPT_PATTERN = /^[1-9][0-9]*$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * Classify a downloaded directory that is neither a release artifact set nor
 * a current-attempt supplemental report.  Prior attempts of a recognized
 * population are returned as superseded (retained, never validated or used);
 * every other case keeps its own specific error.
 *
 * @param {string} directory @param {string} product @param {readonly any[]} securityReports
 * @param {readonly any[]} failureDiagnostics @param {string | null} attempt
 * @returns {{superseded: {category: string, role: string | null, attempt: string}} | {error: string}}
 */
function classifyUnrecognizedDirectory(directory, product, securityReports, failureDiagnostics, attempt) {
  const security = SECURITY_ARTIFACT_PATTERN.exec(directory);
  if (security) {
    const category = security[1] ?? "", role = security[2] ?? "", suffix = security[3] ?? "";
    if (!securityReports.some((report) => report.category === category)) return { error: `Supplemental security report category '${category}' is not permitted for product '${product}': '${directory}'.` };
    if (attempt && ATTEMPT_PATTERN.test(suffix) && Number(suffix) < Number(attempt)) return { superseded: { category, role, attempt: suffix } };
    return { error: `Supplemental security report attempt mismatch: '${directory}' is attempt '${suffix}', expected '${attempt ?? "unknown"}'.` };
  }
  const diagnostic = /^(.+)-(\d+)$/u.exec(directory);
  const diagnosticName = diagnostic?.[1] ?? "", diagnosticAttempt = diagnostic?.[2] ?? "";
  if (diagnostic && failureDiagnostics.some((item) => item.name === diagnosticName)) {
    if (attempt && ATTEMPT_PATTERN.test(diagnosticAttempt) && Number(diagnosticAttempt) < Number(attempt)) return { superseded: { category: diagnosticName, role: null, attempt: diagnosticAttempt } };
    return { error: `Failure diagnostic attempt mismatch: '${directory}' is attempt '${diagnosticAttempt}', expected '${attempt ?? "unknown"}'.` };
  }
  return { error: `Unexpected artifact set: '${directory}'.` };
}

/** @param {string} directory @returns {Promise<Array<{path: string, size: number, sha256: string, bytes: Buffer}>>} */
async function inventory(directory) {
  const files = [];
  for (const file of (await regularFiles(directory)).sort()) {
    const bytes = await readFile(file);
    files.push({ path: portable(relative(directory, file)), size: bytes.byteLength, sha256: sha256Hex(bytes), bytes });
  }
  return files;
}

/** @param {Array<{path: string, size: number, sha256: string}>} files */
function listing(files) { return files.map(({ path, size, sha256 }) => ({ path, size, sha256 })); }

/**
 * Validate one recognized raw/normalized security report pair produced by
 * security-report.mjs in this exact run.  The normalized binding must name
 * this repository, product, run, attempt, PR head and this run's merge
 * candidate (the commit every job of the run checked out); its declared raw
 * report bytes must equal the downloaded raw artifact exactly.
 *
 * @param {{artifactsDir: string, report: any, attempt: string, product: string, expectedReceipt: any, expectedRunId: string | null, referenceHeadSha: string | null, jobResult: string}} input
 * @param {string[]} errors
 */
async function validateSecurityReportPair(input, errors) {
  const { report, attempt } = input;
  const rawSet = securityReportArtifactName(report.category, "raw", attempt), normalizedSet = securityReportArtifactName(report.category, "normalized", attempt);
  const before = errors.length;
  const record = /** @type {any} */ ({ category: report.category, tool: report.tool, job: report.job, matrix: report.matrix, attempt, jobResult: input.jobResult, state: "validated", raw: { artifactSet: rawSet, files: [] }, normalized: { artifactSet: normalizedSet } });
  /** @param {string} message */
  const fail = (message) => errors.push(`Supplemental security report '${report.category}' attempt ${attempt}: ${message}`);
  /** @type {Awaited<ReturnType<typeof inventory>> | null} */ let rawFiles = null, normalizedFiles = null;
  try { rawFiles = await inventory(join(input.artifactsDir, rawSet)); } catch (error) { fail(`raw artifact '${rawSet}' is unreadable: ${error instanceof Error ? error.message : String(error)}`); }
  try { normalizedFiles = await inventory(join(input.artifactsDir, normalizedSet)); } catch (error) { fail(`normalized artifact '${normalizedSet}' is unreadable: ${error instanceof Error ? error.message : String(error)}`); }
  record.raw.files = listing(rawFiles ?? []);
  /** @type {any} */ let normalized = null;
  if (!normalizedFiles) { /* already reported as unreadable */ }
  else if (normalizedFiles.length !== 1 || normalizedFiles[0]?.path !== report.normalizedFile) fail(`normalized artifact '${normalizedSet}' must contain exactly '${report.normalizedFile}'.`);
  else {
    const file = /** @type {NonNullable<(typeof normalizedFiles)[number]>} */ (normalizedFiles[0]);
    record.normalized = { artifactSet: normalizedSet, path: file.path, size: file.size, sha256: file.sha256 };
    try { normalized = JSON.parse(file.bytes.toString("utf8")); } catch { fail(`normalized report '${normalizedSet}/${file.path}' is malformed JSON.`); }
  }
  if (normalized !== null && !isRecord(normalized)) { fail(`normalized report '${normalizedSet}' is not a JSON object.`); normalized = null; }
  if (normalized) {
    record.normalized.status = normalized.status;
    if (normalized.schema !== "tfsb.security-report-v1") fail(`normalized report schema '${normalized.schema ?? "missing"}' is not tfsb.security-report-v1.`);
    if (normalized.status !== "complete") fail(`normalized report status is '${normalized.status ?? "missing"}', expected 'complete'.`);
    const binding = isRecord(normalized.binding) ? normalized.binding : {};
    const merge = input.expectedReceipt?.identities?.mergeCandidate;
    record.binding = { repository: binding.repository ?? null, product: binding.product ?? null, tool: binding.tool ?? null, category: binding.category ?? null, runId: binding.runId ?? null, attempt: binding.attempt ?? null, pr: binding.pr ?? null, prHead: binding.prHead ?? null, analyzedCommit: binding.analyzedCommit ?? null, workflowSha256: binding.workflowSha256 ?? null, linkage: "same-run-merge-candidate" };
    record.sourceReceipt = { artifactSet: EXPECTED_PUBLIC_RECEIPT_SPECIFICATION.directory, job: EXPECTED_PUBLIC_RECEIPT_SPECIFICATION.job, runId: input.expectedReceipt?.workflow?.runId ?? null, runAttempt: input.expectedReceipt?.workflow?.runAttempt ?? null, mergeCandidate: { commit: merge?.commit ?? null, tree: merge?.tree ?? null } };
    /** @type {Array<[string, unknown, unknown]>} */
    const expectations = [
      ["tool", binding.tool, report.tool],
      ["category", binding.category, report.reportCategory],
      ["product", binding.product, input.product],
      ["repository", binding.repository, input.expectedReceipt?.event?.repository],
      ["runId", binding.runId, input.expectedRunId ?? input.expectedReceipt?.workflow?.runId],
      ["attempt", binding.attempt, attempt],
      ["pr", binding.pr, input.expectedReceipt?.event?.number],
      ["prHead", binding.prHead, input.referenceHeadSha],
    ];
    for (const [field, actual, expected] of expectations) {
      if (expected === undefined || expected === null || actual !== expected) fail(`binding ${field} '${String(actual ?? "missing")}' does not match '${String(expected ?? "missing")}'.`);
    }
    if (!isSha(binding.analyzedCommit) || !isSha(merge?.commit) || binding.analyzedCommit !== merge.commit) {
      fail(`analyzed commit '${String(binding.analyzedCommit ?? "missing")}' is not this run's merge candidate '${String(merge?.commit ?? "missing")}'.`);
    }
    if (typeof binding.workflowSha256 !== "string" || !SHA256_HEX.test(binding.workflowSha256)) fail("binding workflowSha256 is missing or invalid.");
    const declared = Array.isArray(normalized.reports) ? normalized.reports : null;
    if (!declared || declared.length === 0) fail("normalized report declares no raw reports.");
    else {
      /** @type {Map<string, any>} */ const byName = new Map();
      for (const item of declared) {
        const name = isRecord(item) && typeof item.path === "string" ? item.path.split("/").pop() : undefined;
        if (!name || !Number.isSafeInteger(item.bytes) || typeof item.sha256 !== "string" || !SHA256_HEX.test(item.sha256)) { fail("normalized report has a malformed raw report entry."); continue; }
        if (byName.has(name)) fail(`normalized report declares raw report '${name}' twice.`);
        byName.set(name, item);
      }
      const rawNames = (rawFiles ?? []).map((file) => file.path).sort(), declaredNames = [...byName.keys()].sort();
      if (rawFiles && JSON.stringify(rawNames) !== JSON.stringify(declaredNames)) fail(`raw artifact '${rawSet}' inventory [${rawNames.join(", ")}] differs from the normalized declaration [${declaredNames.join(", ")}].`);
      for (const file of rawFiles ?? []) {
        const item = byName.get(file.path);
        if (item && (item.bytes !== file.size || item.sha256 !== file.sha256)) fail(`raw digest mismatch for '${rawSet}/${file.path}': declared ${item.bytes} bytes ${item.sha256}, downloaded ${file.size} bytes ${file.sha256}.`);
        if (!file.path.endsWith(".sarif")) { fail(`raw report '${rawSet}/${file.path}' is not SARIF.`); continue; }
        /** @type {any} */ let sarif;
        try { sarif = JSON.parse(file.bytes.toString("utf8")); } catch { fail(`raw report '${rawSet}/${file.path}' is malformed JSON.`); continue; }
        if (!isRecord(sarif) || !Array.isArray(sarif.runs) || sarif.runs.length === 0 || sarif.runs.some((/** @type {any} */ run) => !Array.isArray(run?.results))) fail(`raw report '${rawSet}/${file.path}' is malformed or incomplete SARIF.`);
      }
    }
    const findings = Array.isArray(normalized.findings) ? normalized.findings : null;
    if (!findings) fail("normalized report findings are missing.");
    else {
      // Findings bind to the declared raw digests; a raw-byte change is reported once, as a raw digest mismatch.
      const declaredDigests = new Set((Array.isArray(normalized.reports) ? normalized.reports : []).map((/** @type {any} */ item) => item?.sha256));
      if (findings.some((/** @type {any} */ finding) => !isRecord(finding) || typeof finding.fingerprint !== "string" || !SHA256_HEX.test(finding.fingerprint))) fail("normalized report has a finding without a complete fingerprint.");
      if (findings.some((/** @type {any} */ finding) => finding?.evidence?.rawSha256 !== undefined && !declaredDigests.has(finding.evidence.rawSha256))) fail("normalized report has a finding bound to a raw report outside this pair.");
      record.normalized.findingCount = findings.length;
    }
  }
  if (errors.length !== before) record.state = "invalid";
  return record;
}

/** @param {unknown} value @returns {Record<string, string>} */
function normalizeNeeds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Needs result JSON must be an object.");
  return Object.fromEntries(Object.entries(value).map(([job, record]) => [job, typeof record === "string" ? record : record && typeof record === "object" && "result" in record ? String(record.result) : "missing"]));
}

/** @param {any} receipt @returns {string | null} */
function receiptHeadSha(receipt) {
  return receipt.identities?.stagingHead?.commit ?? receipt.event?.headSha ?? receipt.checkout?.commit ?? null;
}

/** @param {any} receipt @returns {string | null} */
function receiptHeadTree(receipt) {
  return receipt.identities?.stagingHead?.tree ?? receipt.checkout?.tree ?? null;
}

/** @param {any} receipt @param {ArtifactSpecification} specification @param {string[]} errors */
function validateCompletePublicReceipt(receipt, specification, errors) {
  const label = specification.directory;
  const event = receipt.event;
  const eventIdentity = receipt.identities?.event;
  const base = receipt.identities?.base;
  const stagingHead = receipt.identities?.stagingHead;
  const checkout = receipt.checkout;
  const workflow = receipt.workflow;
  if (!isRecord(event) || !isRecord(eventIdentity) || !isRecord(base) || !isRecord(stagingHead) || !isRecord(workflow)) {
    errors.push(`Complete public pull_request, workflow, base, and staging-head identities are required for '${label}'.`);
    return;
  }
  if (event.name !== "pull_request" || !PUBLIC_PULL_REQUEST_ACTIONS.has(event.action)) errors.push(`Public pull_request event name or action is invalid for '${label}'.`);
  if (!Number.isSafeInteger(event.number) || event.number < 1) errors.push(`Public pull_request number is invalid for '${label}'.`);
  if (event.baseRef !== "main" || event.headRef !== "staging") errors.push(`Public pull_request base/head refs are invalid for '${label}'.`);
  if (!isSha(event.baseSha) || !isSha(event.headSha)) errors.push(`Public pull_request base/head commit identities are invalid for '${label}'.`);
  if (PUBLIC_REPOSITORY_FIELDS.some((field) => typeof event[field] !== "string" || event[field].trim() === "")) errors.push(`Public pull_request repository identities are incomplete for '${label}'.`);
  else if (new Set(PUBLIC_REPOSITORY_FIELDS.map((field) => event[field])).size !== 1) errors.push(`Public pull_request repositories disagree for '${label}'.`);
  for (const field of PUBLIC_EVENT_FIELDS) {
    if (eventIdentity[field] !== event[field]) errors.push(`Public event identity mismatch for '${label}': ${field}.`);
  }
  if (base.ref !== "main" || base.commit !== event.baseSha || base.repository !== event.repository) errors.push(`Public base identity mismatch for '${label}'.`);
  if (stagingHead.ref !== "staging" || stagingHead.commit !== event.headSha || stagingHead.repository !== event.repository || !isSha(stagingHead.tree)) errors.push(`Public staging-head identity is incomplete or mismatched for '${label}'.`);
  const runId = typeof workflow.runId === "string" ? workflow.runId.trim() : "";
  const runAttempt = typeof workflow.runAttempt === "string" ? workflow.runAttempt.trim() : "";
  if (!runId || !runAttempt) errors.push(`Public workflow run identity and attempt are required for '${label}'.`);
  if (!isRecord(checkout) || checkout.clean !== true || !isSha(checkout.commit) || !isSha(checkout.tree)) errors.push(`Public checkout identity is incomplete for '${label}'.`);
  if (specification.checkoutRole === "staging-head") {
    if (!isRecord(checkout) || checkout.role !== "staging-head" || checkout.commit !== event.headSha || checkout.tree !== stagingHead.tree) errors.push(`Public staging-head checkout identity is invalid for '${label}'.`);
  } else if (specification.checkoutRole === "merge-candidate") {
    const merge = receipt.identities?.mergeCandidate;
    const parents = isRecord(merge) && Array.isArray(merge.parents) ? merge.parents : [];
    if (!isRecord(merge) || !isSha(merge.commit) || !isSha(merge.tree) || parents.length !== 2 || parents[0] !== event.baseSha || parents[1] !== event.headSha || merge.commit === event.headSha) {
      errors.push(`Public merge-candidate identity is incomplete or mismatched for '${label}'.`);
    }
    if (!isRecord(checkout) || checkout.role !== "merge-candidate" || checkout.commit !== merge?.commit || checkout.tree !== merge?.tree || JSON.stringify(checkout.parents ?? []) !== JSON.stringify(parents)) {
      errors.push(`Public merge-candidate checkout identity is invalid for '${label}'.`);
    }
  }
}

/** @param {any} actual @param {any} expected @param {ArtifactSpecification} specification @param {string[]} errors */
function compareWithExpectedReceipt(actual, expected, specification, errors) {
  const label = specification.directory;
  const actualEvent = actual.event, expectedEvent = expected.event;
  for (const field of [...PUBLIC_EVENT_FIELDS, ...PUBLIC_REPOSITORY_FIELDS]) {
    if (actualEvent?.[field] !== expectedEvent?.[field]) errors.push(`Receipt event.${field} does not match the independent expected receipt for '${label}'.`);
  }
  /** @type {Array<{name: "base" | "stagingHead", fields: string[]}>} */
  const identityGroups = [
    { name: "base", fields: ["ref", "commit", "tree", "repository"] },
    { name: "stagingHead", fields: ["ref", "commit", "tree", "repository"] },
  ];
  for (const { name, fields } of identityGroups) {
    for (const field of fields) {
      if (actual.identities?.[name]?.[field] !== expected.identities?.[name]?.[field]) errors.push(`Receipt identities.${name}.${field} does not match the independent expected receipt for '${label}'.`);
    }
  }
  for (const field of ["runId", "runAttempt"]) {
    if (actual.workflow?.[field] !== expected.workflow?.[field]) errors.push(`Receipt workflow.${field} does not match the independent expected receipt for '${label}'.`);
  }
  if (specification.checkoutRole === "merge-candidate") {
    for (const field of ["commit", "tree"]) {
      if (actual.identities?.mergeCandidate?.[field] !== expected.identities?.mergeCandidate?.[field]) errors.push(`Receipt identities.mergeCandidate.${field} does not match the independent expected receipt for '${label}'.`);
      if (actual.checkout?.[field] !== expected.checkout?.[field]) errors.push(`Receipt checkout.${field} does not match the independent expected receipt for '${label}'.`);
    }
    if (JSON.stringify(actual.identities?.mergeCandidate?.parents ?? []) !== JSON.stringify(expected.identities?.mergeCandidate?.parents ?? [])) errors.push(`Receipt identities.mergeCandidate.parents do not match the independent expected receipt for '${label}'.`);
    if (JSON.stringify(actual.checkout?.parents ?? []) !== JSON.stringify(expected.checkout?.parents ?? [])) errors.push(`Receipt checkout.parents do not match the independent expected receipt for '${label}'.`);
  }
}

/** @param {any} receipt @param {ArtifactSpecification} specification @param {string[]} errors */
function validateReceiptIdentity(receipt, specification, errors, strictPublic = false) {
  if (!isRecord(receipt)) {
    errors.push(`Exact-head receipt is not a JSON object for '${specification.directory}'.`);
    return;
  }
  if (receipt.schema !== "tfsb.ci-exact-head-receipt" || receipt.status !== "pass" || receipt.workflow?.job !== specification.job || !sameRecord(receipt.workflow?.matrix ?? {}, specification.matrix)) {
    errors.push(`Exact-head receipt identity mismatch for '${specification.directory}'.`);
  }
  const event = receipt.event;
  const eventIdentity = receipt.identities?.event;
  const base = receipt.identities?.base;
  const stagingHead = receipt.identities?.stagingHead;
  const checkout = receipt.checkout;
  if (specification.checkoutRole && (!event || typeof event !== "object" || !eventIdentity || typeof eventIdentity !== "object" || !base || typeof base !== "object" || !stagingHead || typeof stagingHead !== "object")) {
    errors.push(`Complete event, base, and staging-head identities are required for '${specification.directory}'.`);
  }
  if (!checkout || typeof checkout !== "object" || checkout.clean !== true || !/^[0-9a-f]{40}$/u.test(String(checkout.commit ?? "")) || !/^[0-9a-f]{40}$/u.test(String(checkout.tree ?? ""))) {
    errors.push(`Checkout identity is missing, dirty, or invalid for '${specification.directory}'.`);
  }
  /** @param {string} label @param {unknown} left @param {unknown} right */
  const compareIfPopulated = (label, left, right) => {
    if (left !== undefined && left !== null && right !== undefined && right !== null && left !== right) errors.push(`Receipt ${label} mismatch for '${specification.directory}'.`);
  };
  if (event && typeof event === "object" && eventIdentity && typeof eventIdentity === "object") {
    for (const field of ["name", "action", "number", "repository", "baseRef", "baseSha", "headRef", "headSha"]) compareIfPopulated(`event.${field}`, event[field], eventIdentity[field]);
    const repositories = [event.repository, event.baseRepository, event.headRepository].filter((value) => value !== undefined && value !== null);
    if (new Set(repositories).size > 1) errors.push(`Receipt event repositories disagree for '${specification.directory}'.`);
  }
  if (event && typeof event === "object" && base && typeof base === "object") {
    compareIfPopulated("base ref", event.baseRef, base.ref);
    compareIfPopulated("base commit", event.baseSha, base.commit);
    compareIfPopulated("base repository", event.baseRepository, base.repository);
  }
  if (event && typeof event === "object" && stagingHead && typeof stagingHead === "object") {
    compareIfPopulated("staging ref", event.headRef, stagingHead.ref);
    compareIfPopulated("staging commit", event.headSha, stagingHead.commit);
    compareIfPopulated("staging repository", event.headRepository, stagingHead.repository);
  }
  const role = specification.checkoutRole ?? checkout?.role;
  if (role === "staging-head" && stagingHead && typeof stagingHead === "object") compareIfPopulated("staging checkout commit", checkout?.commit, stagingHead.commit);
  if (role === "merge-candidate" && receipt.identities?.mergeCandidate && typeof receipt.identities.mergeCandidate === "object") {
    const merge = receipt.identities.mergeCandidate;
    compareIfPopulated("merge checkout commit", checkout?.commit, merge.commit);
    compareIfPopulated("merge checkout tree", checkout?.tree, merge.tree);
    if (Array.isArray(checkout?.parents) && Array.isArray(merge.parents) && JSON.stringify(checkout.parents) !== JSON.stringify(merge.parents)) errors.push(`Receipt merge parents mismatch for '${specification.directory}'.`);
  }
  const headSha = receiptHeadSha(receipt), headTree = receiptHeadTree(receipt);
  if (!headSha || !/^[0-9a-f]{40}$/u.test(headSha)) errors.push(`Staging head identity is missing or invalid for '${specification.directory}'.`);
  if (!headTree || !/^[0-9a-f]{40}$/u.test(headTree)) errors.push(`Staging head tree identity is missing or invalid for '${specification.directory}'.`);
  if (specification.checkoutRole && checkout?.role !== specification.checkoutRole) errors.push(`Checkout role mismatch for '${specification.directory}': got '${checkout?.role ?? "missing"}', expected '${specification.checkoutRole}'.`);
  if (specification.checkoutRole && event?.baseRef !== "main") errors.push(`Public base ref is not main for '${specification.directory}'.`);
  if (specification.checkoutRole && event?.headRef !== "staging") errors.push(`Public staging head ref is not staging for '${specification.directory}'.`);
  if (role === "staging-head" && checkout?.commit !== headSha) errors.push(`Staging-head checkout does not equal the recorded head for '${specification.directory}'.`);
  if (specification.checkoutRole === "merge-candidate") {
    const baseSha = receipt.identities?.base?.commit ?? receipt.event?.baseSha;
    const merge = receipt.identities?.mergeCandidate;
    const parents = Array.isArray(merge?.parents) ? merge.parents : [];
    if (!merge || !baseSha || !/^[0-9a-f]{40}$/u.test(baseSha) || parents.length !== 2 || parents[0] !== baseSha || parents[1] !== headSha) {
      errors.push(`Merge candidate parent identity mismatch for '${specification.directory}'.`);
    }
    if (!merge?.commit || merge.commit !== checkout?.commit || merge.commit === headSha) errors.push(`Merge candidate checkout identity is invalid for '${specification.directory}'.`);
  }
  if (strictPublic) validateCompletePublicReceipt(receipt, specification, errors);
}

/**
 * Aggregate one private or product-specific artifact population.  The
 * product controls both required jobs and artifact directories so a public
 * product never inherits private-monorepo outputs by accident.
 *
 * @param {{artifactsDir: string, outputDir: string, product?: string, expectedHeadSha?: string, expectedHeadTree?: string, expectedRunId?: string, expectedRunAttempt?: string, expectedReceiptPath?: string, needsResults?: Record<string, string | {result?: string}>}} options
 */
export async function aggregateEvidence(options) {
  const artifactsDir = resolve(options.artifactsDir), outDir = resolve(options.outputDir);
  const product = options.product ?? "private";
  const isPublicProduct = PUBLIC_PRODUCTS.has(product);
  const contracts = /** @type {Record<string, any>} */ (PRODUCT_CONTRACTS);
  const contract = contracts[product];
  if (!contract) throw new Error(`Unknown evidence aggregation product '${product}'.`);
  /** @type {readonly ArtifactSpecification[]} */
  const specifications = contract.artifacts;
  /** @type {readonly ArtifactSpecification[]} */
  const advisorySpecifications = contract.advisoryArtifacts ?? [];
  /** @type {readonly string[]} */
  const requiredJobs = contract.requiredJobs;
  /** @type {readonly string[]} */
  const advisoryJobs = contract.advisoryJobs ?? [];
  await mkdir(outDir, { recursive: true });
  /** @type {string[]} */ const errors = [];
  /** @type {Array<{path: string, size: number, sha256: string}>} */ const artifactsObserved = [];
  /** @type {Array<{job: string, matrix: Readonly<Record<string, string>>, artifactSet: string | null, result: string}>} */ const jobsObserved = [];
  /** @type {string | null} */ let referenceHeadSha = options.expectedHeadSha ?? null;
  /** @type {string | null} */ let referenceHeadTree = options.expectedHeadTree ?? null;
  /** @type {string | null} */ let observedRunId = null;
  /** @type {string | null} */ let observedRunAttempt = null;
  /** @type {boolean} */ let missingRunId = false;
  /** @type {boolean} */ let missingRunAttempt = false;
  const expectedRunId = options.expectedRunId ?? process.env.GITHUB_RUN_ID ?? null;
  const expectedRunAttempt = options.expectedRunAttempt ?? process.env.GITHUB_RUN_ATTEMPT ?? null;
  /** @type {any | null} */ let expectedReceipt = null;
  /** @type {string[]} */ let entries = [];
  try { entries = (await readdir(artifactsDir)).sort(); }
  catch (error) { errors.push(`Artifacts directory is unreadable: ${error instanceof Error ? error.message : String(error)}`); }

  if (isPublicProduct) {
    if (!options.expectedReceiptPath) {
      errors.push(`Public evidence aggregation for '${product}' requires an independent --expected-receipt path.`);
    } else {
      try { expectedReceipt = JSON.parse(await readFile(resolve(options.expectedReceiptPath), "utf8")); }
      catch (error) { errors.push(`Independent expected receipt is unreadable: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (expectedReceipt && !isRecord(expectedReceipt)) {
      errors.push("Independent expected receipt is not a JSON object.");
      expectedReceipt = null;
    }
    if (expectedReceipt) {
      validateReceiptIdentity(expectedReceipt, EXPECTED_PUBLIC_RECEIPT_SPECIFICATION, errors, true);
      const expectedReceiptRunId = typeof expectedReceipt.workflow?.runId === "string" && expectedReceipt.workflow.runId.trim() !== "" ? expectedReceipt.workflow.runId : null;
      const expectedReceiptRunAttempt = typeof expectedReceipt.workflow?.runAttempt === "string" && expectedReceipt.workflow.runAttempt.trim() !== "" ? expectedReceipt.workflow.runAttempt : null;
      if (!expectedReceiptRunId) errors.push("Independent expected receipt lacks a workflow run identity.");
      if (!expectedReceiptRunAttempt) errors.push("Independent expected receipt lacks a workflow run attempt.");
      if (expectedRunId && expectedReceiptRunId !== expectedRunId) errors.push(`Independent expected receipt run identity '${expectedReceiptRunId ?? "missing"}' does not match '${expectedRunId}'.`);
      if (expectedRunAttempt && expectedReceiptRunAttempt !== expectedRunAttempt) errors.push(`Independent expected receipt run attempt '${expectedReceiptRunAttempt ?? "missing"}' does not match '${expectedRunAttempt}'.`);
      if (process.env.GITHUB_REPOSITORY && expectedReceipt.event?.repository !== process.env.GITHUB_REPOSITORY) errors.push("Independent expected receipt repository does not match GITHUB_REPOSITORY.");
      const expectedHead = receiptHeadSha(expectedReceipt), expectedTree = receiptHeadTree(expectedReceipt);
      if (expectedHead) referenceHeadSha = expectedHead;
      if (expectedTree) referenceHeadTree = expectedTree;
    }
  }

  const expectedDirectories = specifications.map((item) => item.directory).sort();
  const advisoryDirectories = advisorySpecifications.map((item) => item.directory);
  const allowedDirectories = new Set([...expectedDirectories, ...advisoryDirectories]);
  /** @type {readonly any[]} */ const securityReports = contract.securityReports ?? [];
  /** @type {readonly any[]} */ const failureDiagnostics = contract.failureDiagnostics ?? [];
  // Supplemental populations are named per run attempt; the attempt comes from this run, never from the directories.
  const receiptAttempt = typeof expectedReceipt?.workflow?.runAttempt === "string" ? expectedReceipt.workflow.runAttempt : null;
  const reportAttempt = [expectedRunAttempt, receiptAttempt].find((value) => typeof value === "string" && ATTEMPT_PATTERN.test(value)) ?? null;
  if ((securityReports.length || failureDiagnostics.length) && !reportAttempt) errors.push("Supplemental report populations require a valid workflow run attempt.");
  /** @type {Map<string, any>} */ const securityDirectories = new Map();
  /** @type {Map<string, any>} */ const diagnosticDirectories = new Map();
  if (reportAttempt) {
    for (const report of securityReports) for (const role of SECURITY_REPORT_ROLES) securityDirectories.set(securityReportArtifactName(report.category, /** @type {"raw" | "normalized"} */ (role), reportAttempt), report);
    for (const diagnostic of failureDiagnostics) diagnosticDirectories.set(`${diagnostic.name}-${reportAttempt}`, diagnostic);
  }
  /** @type {any[]} */ const supersededReports = [];
  for (const directory of expectedDirectories) if (!entries.includes(directory)) errors.push(`Missing required artifact set: '${directory}'.`);
  for (const directory of entries) {
    if (allowedDirectories.has(directory) || securityDirectories.has(directory) || diagnosticDirectories.has(directory)) continue;
    const classified = classifyUnrecognizedDirectory(directory, contract.canonicalProduct ?? product, securityReports, failureDiagnostics, reportAttempt);
    if ("error" in classified) { errors.push(classified.error); continue; }
    try { supersededReports.push({ artifactSet: directory, ...classified.superseded, state: "superseded-attempt", files: listing(await inventory(join(artifactsDir, directory))) }); }
    catch (error) { errors.push(`Superseded report set '${directory}' is unreadable: ${error instanceof Error ? error.message : String(error)}`); }
  }

  const expectedNeeds = requiredJobs.filter((job) => job !== "evidence-aggregate");
  const allowedNeeds = new Set([...expectedNeeds, ...advisoryJobs]);
  const needsResults = normalizeNeeds(options.needsResults ?? {});
  for (const job of expectedNeeds) {
    const result = needsResults[job];
    if (result !== "success") errors.push(`Dependency '${job}' result is '${result ?? "missing"}', expected 'success'.`);
  }
  for (const job of Object.keys(needsResults)) if (!allowedNeeds.has(job) && job !== "evidence-aggregate") errors.push(`Unexpected dependency result '${job}'.`);

  // Recognized reports are retained and bound; they never stand in for a job result.
  /** @type {any[]} */ const supplementalSecurityReports = [];
  if (reportAttempt) {
    for (const report of securityReports) {
      const jobResult = needsResults[report.job] ?? "missing";
      const present = SECURITY_REPORT_ROLES.filter((role) => entries.includes(securityReportArtifactName(report.category, /** @type {"raw" | "normalized"} */ (role), reportAttempt)));
      if (present.length === 0) {
        // A job that did not succeed already fails the gate above; a successful job must have retained its reports.
        if (jobResult === "success") errors.push(`Supplemental security report '${report.category}' attempt ${reportAttempt} is missing although job '${report.job}' succeeded.`);
        supplementalSecurityReports.push({ category: report.category, tool: report.tool, job: report.job, matrix: report.matrix, attempt: reportAttempt, jobResult, state: "absent" });
        continue;
      }
      supplementalSecurityReports.push(await validateSecurityReportPair({ artifactsDir, report, attempt: reportAttempt, product: contract.canonicalProduct, expectedReceipt, expectedRunId, referenceHeadSha, jobResult }, errors));
    }
  }
  /** @type {any[]} */ const failureDiagnosticsObserved = [];
  for (const [directory, diagnostic] of diagnosticDirectories) {
    if (!entries.includes(directory)) continue;
    const jobResult = needsResults[diagnostic.job] ?? "missing";
    if (jobResult === "success") errors.push(`Failure diagnostic '${directory}' is present although job '${diagnostic.job}' succeeded.`);
    /** @type {Awaited<ReturnType<typeof inventory>>} */ let files = [];
    try { files = await inventory(join(artifactsDir, directory)); }
    catch (error) { errors.push(`Failure diagnostic '${directory}' is unreadable: ${error instanceof Error ? error.message : String(error)}`); }
    for (const file of files) {
      if (!diagnostic.files.includes(file.path)) { errors.push(`Failure diagnostic '${directory}' contains undeclared file '${file.path}'.`); continue; }
      try { JSON.parse(file.bytes.toString("utf8")); } catch { errors.push(`Failure diagnostic '${directory}/${file.path}' is malformed JSON.`); }
    }
    failureDiagnosticsObserved.push({ artifactSet: directory, job: diagnostic.job, jobResult, files: listing(files) });
  }

  const activeAdvisories = advisorySpecifications.filter((item) => entries.includes(item.directory));
  const specificationsToValidate = [...specifications, ...activeAdvisories];
  for (const specification of specificationsToValidate) {
    if (!entries.includes(specification.directory)) continue;
    const directory = join(artifactsDir, specification.directory);
    let files = [];
    try { files = (await regularFiles(directory)).sort(); }
    catch (error) { errors.push(`Artifact set '${specification.directory}' is unreadable: ${error instanceof Error ? error.message : String(error)}`); continue; }
    for (const file of files) {
      const bytes = await readFile(file), path = `${specification.directory}/${portable(relative(directory, file))}`;
      artifactsObserved.push({ path, size: bytes.byteLength, sha256: sha256Hex(bytes) });
      if (bytes.byteLength === 0) errors.push(`Artifact '${path}' is empty.`);
    }

    /** @type {any} */ let jobManifest;
    try { jobManifest = JSON.parse(await readFile(join(directory, "artifact-manifest.json"), "utf8")); }
    catch (error) { errors.push(`Artifact set '${specification.directory}' lacks a valid artifact-manifest.json: ${error instanceof Error ? error.message : String(error)}`); continue; }
    if (jobManifest.schema !== "tfsb.ci-job-artifact-manifest" || jobManifest.status !== "pass" || jobManifest.job !== specification.job || !sameRecord(jobManifest.matrix ?? {}, specification.matrix)) errors.push(`Artifact manifest identity mismatch for '${specification.directory}'.`);
    const actualRelative = files.map((file) => portable(relative(directory, file))).filter((path) => path !== "artifact-manifest.json").sort();
    /** @type {Array<{path?: unknown, size?: unknown, sha256?: unknown}>} */
    const declared = Array.isArray(jobManifest.artifacts) ? jobManifest.artifacts : [];
    const declaredPaths = declared.map((item) => item?.path).filter((path) => typeof path === "string").sort();
    if (new Set(declaredPaths).size !== declaredPaths.length || JSON.stringify(actualRelative) !== JSON.stringify(declaredPaths)) errors.push(`Artifact manifest inventory mismatch for '${specification.directory}'.`);
    for (const required of specification.required) if (!actualRelative.some((path) => matchesRequirement(path, required))) errors.push(`Required artifact '${specification.directory}/${required}' is missing.`);
    for (const item of declared) {
      if (!item || typeof item.path !== "string") { errors.push(`Malformed artifact entry in '${specification.directory}'.`); continue; }
      try {
        const full = join(directory, item.path), bytes = await readFile(full), info = await stat(full);
        if (item.size !== info.size || item.sha256 !== sha256Hex(bytes)) errors.push(`Artifact size or SHA-256 mismatch: '${specification.directory}/${item.path}'.`);
      } catch { errors.push(`Declared artifact is missing: '${specification.directory}/${item.path}'.`); }
    }

    /** @type {any} */ let receipt;
    try { receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8")); }
    catch (error) { errors.push(`Exact-head receipt is invalid for '${specification.directory}': ${error instanceof Error ? error.message : String(error)}`); continue; }
    validateReceiptIdentity(receipt, specification, errors, isPublicProduct);
    if (!isRecord(receipt)) continue;
    if (isPublicProduct && expectedReceipt) compareWithExpectedReceipt(receipt, expectedReceipt, specification, errors);
    const headSha = receiptHeadSha(receipt), headTree = receiptHeadTree(receipt);
    if (!referenceHeadSha) referenceHeadSha = headSha; else if (headSha !== referenceHeadSha) errors.push(`Head SHA mismatch in '${specification.directory}'.`);
    if (!referenceHeadTree) referenceHeadTree = headTree; else if (headTree !== referenceHeadTree) errors.push(`Head tree mismatch in '${specification.directory}'.`);

    const rawRunId = receipt.workflow?.runId ?? null, rawRunAttempt = receipt.workflow?.runAttempt ?? null;
    const runId = typeof rawRunId === "string" && rawRunId.trim() !== "" ? rawRunId : null;
    const runAttempt = typeof rawRunAttempt === "string" && rawRunAttempt.trim() !== "" ? rawRunAttempt : null;
    if (rawRunId !== null && runId === null) errors.push(`Workflow run identity is empty or invalid in '${specification.directory}'.`);
    if (rawRunAttempt !== null && runAttempt === null) errors.push(`Workflow run attempt is empty or invalid in '${specification.directory}'.`);
    if (expectedRunId && runId !== expectedRunId) errors.push(`Run identity mismatch in '${specification.directory}': got '${runId ?? "missing"}', expected '${expectedRunId}'.`);
    if (expectedRunAttempt && runAttempt !== expectedRunAttempt) errors.push(`Run attempt mismatch in '${specification.directory}': got '${runAttempt ?? "missing"}', expected '${expectedRunAttempt}'.`);
    if (runId !== null) {
      if (observedRunId === null) observedRunId = runId;
      else if (observedRunId !== runId) errors.push(`Stale or mixed workflow run identity in '${specification.directory}'.`);
    } else missingRunId = true;
    if (runAttempt !== null) {
      if (observedRunAttempt === null) observedRunAttempt = runAttempt;
      else if (observedRunAttempt !== runAttempt) errors.push(`Stale or mixed workflow run attempt in '${specification.directory}'.`);
    } else missingRunAttempt = true;
    jobsObserved.push({ job: specification.job, matrix: specification.matrix, artifactSet: specification.directory, result: needsResults[specification.job] ?? "missing" });
  }
  if (observedRunId === null) errors.push("Workflow run identity is missing from all artifact receipts.");
  else if (missingRunId) errors.push("Workflow run identity is missing from one or more artifact receipts.");
  if (observedRunAttempt === null) errors.push("Workflow run attempt is missing from all artifact receipts.");
  else if (missingRunAttempt) errors.push("Workflow run attempt is missing from one or more artifact receipts.");

  const representedJobs = new Set(jobsObserved.map((item) => item.job));
  for (const job of expectedNeeds) if (!representedJobs.has(job)) jobsObserved.push({ job, matrix: Object.freeze({}), artifactSet: null, result: needsResults[job] ?? "missing" });

  if (!referenceHeadSha || !/^[0-9a-f]{40}$/u.test(referenceHeadSha)) errors.push("Reference PR head SHA is missing or invalid.");
  if (!referenceHeadTree || !/^[0-9a-f]{40}$/u.test(referenceHeadTree)) errors.push("Reference PR head tree is missing or invalid.");
  const passed = errors.length === 0;
  const manifest = {
    schema: "tfsb.ci-aggregate-evidence-manifest",
    schemaVersion: 3,
    status: passed ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    product,
    headSha: referenceHeadSha,
    headTree: referenceHeadTree,
    dependencyResults: needsResults,
    jobs: jobsObserved,
    requiredJobsTotal: requiredJobs.length,
    artifactSetsTotal: specificationsToValidate.length,
    nativeTuples: NATIVE_SNAPSHOT_TUPLES,
    rasterTuples: RASTER_COMPANION_TUPLES,
    aclCommandsCount: STUDIO_ACL_TEN_COMMANDS.length,
    artifactsTotal: artifactsObserved.length,
    artifacts: artifactsObserved.sort((left, right) => left.path.localeCompare(right.path)),
    supplementalSecurityReports,
    supersededReports,
    failureDiagnostics: failureDiagnosticsObserved,
    errors,
  };
  const manifestPath = join(outDir, "ci-evidence-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const summaryPath = join(outDir, "ci-evidence-summary.md");
  const summary = `# TFSB49 PR CI Evidence Aggregation Summary\n\n- **Product**: ${product}\n- **Status**: ${passed ? "PASS" : "FAIL"}\n- **PR Head SHA**: \`${referenceHeadSha ?? "unresolved"}\`\n- **Head Git Tree**: \`${referenceHeadTree ?? "unresolved"}\`\n- **Validated artifact files**: ${artifactsObserved.length}\n- **Exact ACL commands**: ${STUDIO_ACL_TEN_COMMANDS.length}\n\n## Dependency results\n${expectedNeeds.map((job) => `- ${job}: ${needsResults[job] ?? "missing"}`).join("\n")}\n\n## Findings\n${errors.length === 0 ? "- None." : errors.map((error) => `- ${error}`).join("\n")}\n`;
  await writeFile(summaryPath, summary, "utf8");
  return { passed, manifestPath, summaryPath, manifest };
}

const invokedDirectly = process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let artifactsDir = ".test-reports", outputDir = ".test-reports/aggregate", product = "private";
  /** @type {string | undefined} */ let expectedReceiptPath;
  /** @type {Record<string, string | {result?: string}>} */ let needsResults = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index], value = args[index + 1];
    if ((flag === "--artifacts" || flag === "--download-dir") && value) { artifactsDir = value; index += 1; }
    else if ((flag === "--output" || flag === "--output-dir") && value) { outputDir = value; index += 1; }
    else if (flag === "--product" && value) { product = value; index += 1; }
    else if (flag === "--expected-receipt" && value) { expectedReceiptPath = value; index += 1; }
    else if (flag === "--needs-json" && value) { needsResults = normalizeNeeds(JSON.parse(value)); index += 1; }
    else throw new Error(`Unsupported or incomplete evidence-aggregator argument: ${flag}`);
  }
  /** @type {Parameters<typeof aggregateEvidence>[0]} */
  const cliOptions = { artifactsDir, outputDir, product, needsResults };
  if (expectedReceiptPath !== undefined) cliOptions.expectedReceiptPath = expectedReceiptPath;
  aggregateEvidence(cliOptions)
    .then((result) => { process.stdout.write(`Evidence aggregated: product=${product} status=${result.passed ? "pass" : "fail"}\n`); if (!result.passed) process.exitCode = 1; })
    .catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
