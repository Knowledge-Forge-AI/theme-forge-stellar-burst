// @ts-check

import { createHash } from "node:crypto";

export const CORE_MATRIX_SCHEMA = "tfsb.terminal-nova-core-matrix";
export const CORE_MATRIX_SCHEMA_VERSION = 1;
export const CORE_CASE_STATUSES = Object.freeze(["pass", "fail", "unavailable"]);

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
/** @type {Readonly<Record<string, readonly string[]>>} */
const REQUIRED_STATE_ARTIFACTS = Object.freeze({
  "recipe-rejection-source-ownership": ["recipe-rejection-source-ownership-before", "recipe-rejection-source-ownership-plan", "recipe-rejection-source-ownership-after"],
  "consumer-install-clean-sync": ["consumer-install-before", "consumer-install-plan", "consumer-clean-sync-plan", "consumer-clean-sync-after"],
  "offline-local-bundle-consumer": ["local-bundle-before", "local-bundle-plan", "local-bundle-after"],
  "unowned-collision": ["unowned-collision-before", "unowned-collision-plan", "unowned-collision-after"],
  "source-drift": ["source-drift-before", "source-drift-plan", "source-drift-after"],
  "stale-plan": ["stale-plan-before", "stale-plan-plan", "stale-plan-after"],
  "destination-drift": ["destination-drift-before", "destination-drift-plan", "destination-drift-after"],
  "stale-lock": ["stale-lock-before", "stale-lock-plan", "stale-lock-after"],
  "successful-apply": ["successful-apply-before", "successful-apply-plan", "successful-apply-after"],
  "failed-apply-exact-rollback": ["failed-apply-before", "failed-apply-plan", "failed-apply-rollback"],
});

/**
 * @param {Uint8Array | string} bytes
 * @returns {string}
 */
export function sha256Digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }
  return value;
}

/**
 * Encode a result using stable object-key ordering. Arrays retain their
 * semantic order because case and artifact order are part of the record.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {asserts value is string}
 */
function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`CORE_RESULT_INVALID_${field.toUpperCase()}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {asserts value is number}
 */
function requireNonNegativeInteger(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`CORE_RESULT_INVALID_${field.toUpperCase()}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {asserts value is string}
 */
function requireDigest(value, field) {
  requireString(value, field);
  if (!DIGEST_PATTERN.test(value)) throw new Error(`CORE_RESULT_INVALID_${field.toUpperCase()}`);
}

/**
 * Ensure durable records cannot accidentally expose a local absolute path.
 * Artifact identities are deliberately limited to relative semantic labels.
 * @param {unknown} value
 * @param {string} field
 */
function rejectPrivatePath(value, field) {
  if (typeof value === "string") {
    if (/\/(?:Users|private|var|tmp|Volumes)\//u.test(value) || /^[A-Za-z]:[\\/]/u.test(value)) {
      throw new Error(`CORE_RESULT_PRIVATE_PATH_${field.toUpperCase()}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectPrivatePath(child, `${field}_${index}`));
    return;
  }
  if (value !== null && typeof value === "object") {
    Object.entries(value).forEach(([key, child]) => rejectPrivatePath(child, `${field}_${key}`));
  }
}

/**
 * @typedef {{ kind: string; id: string; digest: string; size: number }} CoreArtifactIdentity
 */

/**
 * Create a bounded artifact identity. The bytes themselves remain in the
 * direct-run packet, while this record binds only their digest and size.
 * @param {string} kind
 * @param {string} id
 * @param {Uint8Array | string} bytes
 * @returns {CoreArtifactIdentity}
 */
export function artifactIdentity(kind, id, bytes) {
  requireString(kind, "artifact_kind");
  requireString(id, "artifact_id");
  if (id.startsWith("/") || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error("CORE_RESULT_INVALID_ARTIFACT_ID");
  }
  const size = typeof bytes === "string" ? Buffer.byteLength(bytes, "utf8") : bytes.byteLength;
  const digest = sha256Digest(bytes);
  return Object.freeze({ kind, id, digest, size });
}

/**
 * @typedef {{ id: string; status: "pass" | "fail" | "unavailable"; reasonCode: string; observations: Record<string, unknown>; artifacts: readonly CoreArtifactIdentity[] }} CoreCaseRow
 */

/**
 * @param {{ id: string; status: "pass" | "fail" | "unavailable"; reasonCode: string; observations?: Record<string, unknown>; artifacts?: readonly CoreArtifactIdentity[] }} input
 * @returns {CoreCaseRow}
 */
export function createCaseRow(input) {
  requireString(input.id, "case_id");
  if (!ID_PATTERN.test(input.id)) throw new Error("CORE_RESULT_INVALID_CASE_ID");
  if (!CORE_CASE_STATUSES.includes(input.status)) throw new Error("CORE_RESULT_INVALID_CASE_STATUS");
  requireString(input.reasonCode, "reason_code");
  const observations = input.observations === undefined ? {} : input.observations;
  if (observations === null || typeof observations !== "object" || Array.isArray(observations)) {
    throw new Error("CORE_RESULT_INVALID_OBSERVATIONS");
  }
  const artifacts = input.artifacts === undefined ? [] : input.artifacts;
  if (!Array.isArray(artifacts)) throw new Error("CORE_RESULT_INVALID_ARTIFACTS");
  artifacts.forEach((artifact, index) => {
    if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error(`CORE_RESULT_INVALID_ARTIFACT_${index}`);
    requireString(artifact.kind, "artifact_kind");
    requireString(artifact.id, "artifact_id");
    requireDigest(artifact.digest, "artifact_digest");
    requireNonNegativeInteger(artifact.size, "artifact_size");
  });
  const row = Object.freeze({
    id: input.id,
    status: input.status,
    reasonCode: input.reasonCode,
    observations: Object.freeze({ ...observations }),
    artifacts: Object.freeze([...artifacts]),
  });
  rejectPrivatePath(row, "case");
  return row;
}

/**
 * @param {{ schema?: unknown; schemaVersion?: unknown; corpus?: unknown; planRegistry?: unknown; cases?: unknown; summary?: unknown }} value
 * @returns {Record<string, unknown>}
 */
export function validateCoreMatrixResult(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("CORE_RESULT_INVALID_ROOT");
  const root = /** @type {Record<string, unknown>} */ (value);
  if (root.schema !== CORE_MATRIX_SCHEMA || root.schemaVersion !== CORE_MATRIX_SCHEMA_VERSION) throw new Error("CORE_RESULT_INVALID_SCHEMA");
  if (root.corpus === null || typeof root.corpus !== "object" || Array.isArray(root.corpus)) throw new Error("CORE_RESULT_INVALID_CORPUS");
  const corpus = /** @type {Record<string, unknown>} */ (root.corpus);
  requireDigest(corpus.readmeDigest, "readme_digest");
  requireString(corpus.commit, "corpus_commit");
  requireString(corpus.tree, "corpus_tree");
  if (!/^[0-9a-f]{40}$/u.test(/** @type {string} */ (corpus.commit)) || !/^[0-9a-f]{40}$/u.test(/** @type {string} */ (corpus.tree))) throw new Error("CORE_RESULT_INVALID_CORPUS_GIT");
  if (corpus.clean !== true) throw new Error("CORE_RESULT_CORPUS_NOT_CLEAN");
  if (!Array.isArray(root.cases)) throw new Error("CORE_RESULT_INVALID_CASES");
  const rows = root.cases.map((row) => createCaseRow(row));
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error("CORE_RESULT_DUPLICATE_CASE");
    seen.add(row.id);
    const requiredArtifactIds = REQUIRED_STATE_ARTIFACTS[row.id];
    if (row.status === "pass" && requiredArtifactIds !== undefined) {
      const actualArtifactIds = new Set(row.artifacts.map(({ id }) => id));
      const missingArtifactIds = requiredArtifactIds.filter((/** @type {string} */ id) => !actualArtifactIds.has(id));
      if (missingArtifactIds.length > 0) throw new Error(`CORE_RESULT_MISSING_STATE_ARTIFACT_${row.id.toUpperCase().replaceAll("-", "_")}`);
    }
  }
  if (root.planRegistry === null || typeof root.planRegistry !== "object" || Array.isArray(root.planRegistry)) throw new Error("CORE_RESULT_INVALID_PLAN_REGISTRY");
  const planRegistry = /** @type {Record<string, unknown>} */ (root.planRegistry);
  if (planRegistry.source !== "production-owner-derived:BRAND_PLAN_METHODS") throw new Error("CORE_RESULT_INVALID_PLAN_REGISTRY_SOURCE");
  if (!Array.isArray(planRegistry.methods) || planRegistry.methods.length === 0) throw new Error("CORE_RESULT_INVALID_PLAN_REGISTRY_METHODS");
  for (const method of planRegistry.methods) {
    if (typeof method !== "string" || method.length === 0 || !method.endsWith(".plan")) throw new Error("CORE_RESULT_INVALID_PLAN_METHOD");
  }
  if (!Array.isArray(planRegistry.exercisedMethods) || planRegistry.exercisedMethods.length === 0) throw new Error("CORE_RESULT_INVALID_EXERCISED_PLAN_METHODS");
  for (const method of planRegistry.exercisedMethods) {
    if (!planRegistry.methods.includes(method)) throw new Error("CORE_RESULT_EXERCISED_PLAN_METHOD_NOT_OWNED");
  }
  if (planRegistry.completionRole !== "owner-fact-not-complete-protocol-gate") throw new Error("CORE_RESULT_INVALID_PLAN_REGISTRY_ROLE");
  if (root.summary === null || typeof root.summary !== "object" || Array.isArray(root.summary)) throw new Error("CORE_RESULT_INVALID_SUMMARY");
  const summary = /** @type {Record<string, unknown>} */ (root.summary);
  const expected = {
    pass: rows.filter((row) => row.status === "pass").length,
    fail: rows.filter((row) => row.status === "fail").length,
    unavailable: rows.filter((row) => row.status === "unavailable").length,
  };
  if (summary.pass !== expected.pass || summary.fail !== expected.fail || summary.unavailable !== expected.unavailable) throw new Error("CORE_RESULT_SUMMARY_MISMATCH");
  if (summary.status !== (expected.fail > 0 ? "fail" : expected.unavailable > 0 ? "unavailable" : "pass")) throw new Error("CORE_RESULT_STATUS_MISMATCH");
  const normalized = Object.freeze({
    schema: CORE_MATRIX_SCHEMA,
    schemaVersion: CORE_MATRIX_SCHEMA_VERSION,
    corpus: Object.freeze({ ...corpus }),
    planRegistry: Object.freeze({ source: "production-owner-derived:BRAND_PLAN_METHODS", methods: Object.freeze([...planRegistry.methods]), exercisedMethods: Object.freeze([...planRegistry.exercisedMethods]), completionRole: "owner-fact-not-complete-protocol-gate" }),
    cases: Object.freeze(rows),
    summary: Object.freeze({ ...expected, status: summary.status }),
  });
  rejectPrivatePath(normalized, "result");
  return normalized;
}

/**
 * @param {{ commit: string; tree: string; clean: boolean; readmeDigest: string; assetCount: number }} corpus
 * @param {readonly CoreCaseRow[]} cases
 * @param {readonly string[]} methods
 * @param {readonly string[]} exercisedMethods
 * @returns {Record<string, unknown>}
 */
export function finalizeCoreMatrix(corpus, cases, methods, exercisedMethods) {
  const counts = {
    pass: cases.filter((row) => row.status === "pass").length,
    fail: cases.filter((row) => row.status === "fail").length,
    unavailable: cases.filter((row) => row.status === "unavailable").length,
  };
  const result = {
    schema: CORE_MATRIX_SCHEMA,
    schemaVersion: CORE_MATRIX_SCHEMA_VERSION,
    corpus: {
      commit: corpus.commit,
      tree: corpus.tree,
      clean: corpus.clean,
      readmeDigest: corpus.readmeDigest,
      assetCount: corpus.assetCount,
    },
    planRegistry: { source: "production-owner-derived:BRAND_PLAN_METHODS", methods: [...methods], exercisedMethods: [...exercisedMethods], completionRole: "owner-fact-not-complete-protocol-gate" },
    cases: [...cases],
    summary: { ...counts, status: counts.fail > 0 ? "fail" : counts.unavailable > 0 ? "unavailable" : "pass" },
  };
  return validateCoreMatrixResult(result);
}
