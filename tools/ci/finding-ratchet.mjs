// @ts-check
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RATCHET_SCHEMA = "tfsb.finding-ratchet-baseline-v1";
export const RATCHET_SCHEMA_VERSION = 1;

export const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/gu;

/**
 * Strips ANSI escape codes from string.
 * @param {string} [text]
 * @returns {string}
 */
export function stripAnsi(text) {
  return String(text || "").replace(ANSI_REGEX, "");
}

/**
 * @typedef {Object} Finding
 * @property {string} product
 * @property {string} tool
 * @property {string} ruleId
 * @property {string} path
 * @property {string} severity
 * @property {string} message
 * @property {number} [line]
 * @property {number} [column]
 * @property {string} [enclosingSymbol]
 * @property {string} [snippetHash]
 * @property {string} [partialFingerprint]
 * @property {number} [occurrenceIndex]
 * @property {string} [status]
 * @property {string} [rationale]
 * @property {string} [reviewedBy]
 * @property {string} [reviewedAt]
 * @property {string} [tracking]
 * @property {string} [fingerprint]
 */

/**
 * @typedef {Object} RatchetBaseline
 * @property {string} schema
 * @property {number} schemaVersion
 * @property {string} updatedAt
 * @property {string} description
 * @property {Finding[]} findings
 */

/**
 * @typedef {Object} RatchetResult
 * @property {boolean} passed
 * @property {number} baselineCount
 * @property {number} currentCount
 * @property {number} newCount
 * @property {number} resolvedCount
 * @property {Finding[]} newFindings
 * @property {Finding[]} resolvedFindings
 */

/**
 * Computes deterministic SHA-256 fingerprint for a finding.
 * Format: sha256("${product}\0${tool}\0${ruleId}\0${normalizedPath}\0${locationContext}\0${severity}\0${normalizedMessage}")
 *
 * Location context incorporates symbol, snippet hash, partial fingerprint, or occurrence index
 * to prevent accidental collapse when a finding is substituted at a different location.
 *
 * @param {Finding} finding
 * @returns {string}
 */
export function computeFindingFingerprint(finding) {
  const normalizedPath = (finding.path || "").replace(/\\/gu, "/").replace(/^\.\//u, "");
  const cleanMessage = stripAnsi(finding.message || "").trim().replace(/\s+/gu, " ");
  let locationContext = "";
  if (finding.enclosingSymbol) {
    locationContext = `symbol:${finding.enclosingSymbol}`;
  } else if (finding.snippetHash) {
    locationContext = `snippet:${finding.snippetHash}`;
  } else if (finding.partialFingerprint) {
    locationContext = `pfp:${finding.partialFingerprint}`;
  } else if (typeof finding.occurrenceIndex === "number" && finding.occurrenceIndex > 0) {
    locationContext = `occ:${finding.occurrenceIndex}`;
  }
  const raw = `${finding.product || ""}\0${finding.tool || ""}\0${finding.ruleId || ""}\0${normalizedPath}\0${locationContext}\0${(finding.severity || "warning").toLowerCase()}\0${cleanMessage}`;
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Normalizes a finding object and computes its fingerprint, preserving review metadata.
 * @param {Partial<Finding>} raw
 * @returns {Finding}
 */
export function normalizeFinding(raw) {
  const finding = {
    product: String(raw.product || "general"),
    tool: String(raw.tool || "linter"),
    ruleId: String(raw.ruleId || "unknown-rule"),
    path: String(raw.path || "").replace(/\\/gu, "/").replace(/^\.\//u, ""),
    severity: String(raw.severity || "warning").toLowerCase(),
    message: stripAnsi(raw.message || "").trim().replace(/\s+/gu, " "),
    line: typeof raw.line === "number" ? raw.line : undefined,
    column: typeof raw.column === "number" ? raw.column : undefined,
    enclosingSymbol: raw.enclosingSymbol ? String(raw.enclosingSymbol) : undefined,
    snippetHash: raw.snippetHash ? String(raw.snippetHash) : undefined,
    partialFingerprint: raw.partialFingerprint ? String(raw.partialFingerprint) : undefined,
    occurrenceIndex: typeof raw.occurrenceIndex === "number" ? raw.occurrenceIndex : undefined,
    status: raw.status ? String(raw.status) : undefined,
    rationale: raw.rationale ? String(raw.rationale) : undefined,
    reviewedBy: raw.reviewedBy ? String(raw.reviewedBy) : undefined,
    reviewedAt: raw.reviewedAt ? String(raw.reviewedAt) : undefined,
    tracking: raw.tracking ? String(raw.tracking) : undefined,
  };
  finding.fingerprint = computeFindingFingerprint(finding);
  return finding;
}

/**
 * Normalizes an entire collection of raw findings, assigning occurrence indexes
 * to disambiguate multiple identical findings lacking distinct location context.
 *
 * @param {Array<Partial<Finding>>} rawList
 * @returns {Finding[]}
 */
export function normalizeFindingsCollection(rawList) {
  const sorted = [...rawList].sort((a, b) => {
    const pComp = (a.path || "").localeCompare(b.path || "");
    if (pComp !== 0) return pComp;
    const rComp = (a.ruleId || "").localeCompare(b.ruleId || "");
    if (rComp !== 0) return rComp;
    const sComp = (a.severity || "").localeCompare(b.severity || "");
    if (sComp !== 0) return sComp;
    const mComp = (a.message || "").localeCompare(b.message || "");
    if (mComp !== 0) return mComp;
    return (a.line ?? 0) - (b.line ?? 0);
  });

  const occCounts = new Map();
  const normalized = [];
  for (const raw of sorted) {
    let locContext = raw.enclosingSymbol
      ? `sym:${raw.enclosingSymbol}`
      : raw.snippetHash
      ? `snip:${raw.snippetHash}`
      : raw.partialFingerprint
      ? `pfp:${raw.partialFingerprint}`
      : "";
    const baseKey = `${raw.product || ""}\0${raw.tool || ""}\0${raw.ruleId || ""}\0${(raw.path || "").replace(/\\/gu, "/").replace(/^\.\//u, "")}\0${locContext}\0${(raw.severity || "warning").toLowerCase()}\0${stripAnsi(raw.message || "").trim().replace(/\s+/gu, " ")}`;
    const curOcc = occCounts.get(baseKey) || 0;
    occCounts.set(baseKey, curOcc + 1);

    const f = normalizeFinding({
      ...raw,
      occurrenceIndex: curOcc,
    });
    normalized.push(f);
  }
  return normalized;
}

/**
 * Parses a SARIF log format into standard Finding objects.
 * Validates runs structure and fails closed on malformed SARIF.
 *
 * @param {any} sarif
 * @param {string} product
 * @param {string} [toolOverride]
 * @returns {Finding[]}
 */
export function parseSarifFindings(sarif, product, toolOverride) {
  if (!sarif || typeof sarif !== "object" || !Array.isArray(sarif.runs)) {
    throw new Error("[RATCHET_FAIL] Invalid SARIF format: missing runs array");
  }
  if (sarif.version && sarif.version !== "2.1.0") {
    throw new Error(`[RATCHET_FAIL] Unsupported SARIF version: ${sarif.version}, expected 2.1.0`);
  }
  if (sarif.$schema && typeof sarif.$schema === "string" && !sarif.$schema.includes("2.1.0")) {
    throw new Error(`[RATCHET_FAIL] Unsupported SARIF schema: ${sarif.$schema}, expected SARIF 2.1.0 schema`);
  }

  /** @type {Array<Partial<Finding>>} */
  const rawFindings = [];
  for (const run of sarif.runs) {
    const toolName = toolOverride || run.tool?.driver?.name || "sarif";
    if (!Array.isArray(run.results)) continue;

    for (const res of run.results) {
      const ruleId = res.ruleId || res.ruleIndex?.toString() || "unknown";
      const level = res.level || "warning";
      const severity = level === "error" ? "error" : level === "note" ? "info" : "warning";
      const message = res.message?.text || "";
      const location = res.locations?.[0];
      const physLoc = location?.physicalLocation;
      const path = physLoc?.artifactLocation?.uri || "";
      const line = physLoc?.region?.startLine;
      const column = physLoc?.region?.startColumn;

      const logicalLoc = location?.logicalLocations?.[0]?.fullyQualifiedName || location?.logicalLocations?.[0]?.name;
      let snippetHash = undefined;
      const snippetText = physLoc?.region?.snippet?.text;
      if (snippetText) {
        snippetHash = createHash("sha256").update(snippetText.trim().replace(/\s+/gu, " ")).digest("hex").slice(0, 16);
      }
      let partialFingerprint = undefined;
      if (res.partialFingerprints && typeof res.partialFingerprints === "object") {
        const pfpVals = Object.values(res.partialFingerprints).filter((v) => typeof v === "string");
        if (pfpVals.length > 0) {
          partialFingerprint = pfpVals[0];
        }
      }

      rawFindings.push({
        product,
        tool: toolName,
        ruleId,
        path,
        severity,
        message,
        line,
        column,
        enclosingSymbol: logicalLoc,
        snippetHash,
        partialFingerprint,
      });
    }
  }

  return normalizeFindingsCollection(rawFindings);
}

/**
 * Evaluates incoming findings against a ratchet baseline.
 * Any new finding not present in baseline (or present but with status "unreviewed")
 * causes the ratchet to fail.
 *
 * @param {Finding[]} currentFindings
 * @param {RatchetBaseline} baseline
 * @returns {RatchetResult}
 */
export function evaluateRatchet(currentFindings, baseline) {
  if (!baseline || baseline.schema !== RATCHET_SCHEMA) {
    throw new Error(`[RATCHET_FAIL] Invalid baseline: schema must be ${RATCHET_SCHEMA}`);
  }
  const normalizedCurrent = currentFindings.map(normalizeFinding);
  /** @type {Map<string, Finding>} */
  const baselineMap = new Map();
  for (const item of baseline.findings || []) {
    const finding = normalizeFinding(item);
    baselineMap.set(finding.fingerprint, finding);
  }

  /** @type {Map<string, Finding>} */
  const currentMap = new Map();
  for (const finding of normalizedCurrent) {
    currentMap.set(finding.fingerprint, finding);
  }

  /** @type {Finding[]} */
  const newFindings = [];
  for (const [fp, finding] of currentMap) {
    const matched = baselineMap.get(fp);
    if (!matched) {
      newFindings.push(finding);
    } else if (matched.status === "unreviewed") {
      newFindings.push({ ...finding, status: "unreviewed" });
    }
  }

  /** @type {Finding[]} */
  const resolvedFindings = [];
  for (const [fp, finding] of baselineMap) {
    if (!currentMap.has(fp)) {
      resolvedFindings.push(finding);
    }
  }

  return {
    passed: newFindings.length === 0,
    baselineCount: baselineMap.size,
    currentCount: currentMap.size,
    newCount: newFindings.length,
    resolvedCount: resolvedFindings.length,
    newFindings,
    resolvedFindings,
  };
}

/**
 * Creates or updates a baseline record from findings while preserving human review metadata.
 * Unreviewed additions are assigned status "unreviewed".
 *
 * @param {Finding[]} findings
 * @param {RatchetBaseline} [existingBaseline]
 * @param {string} [description]
 * @returns {{ baseline: RatchetBaseline, unreviewedCount: number }}
 */
export function createBaseline(findings, existingBaseline, description) {
  const existingMap = new Map();
  if (existingBaseline && Array.isArray(existingBaseline.findings)) {
    for (const item of existingBaseline.findings) {
      const f = normalizeFinding(item);
      existingMap.set(f.fingerprint, f);
    }
  }

  let unreviewedCount = 0;
  const merged = [];
  for (const raw of findings) {
    const f = normalizeFinding(raw);
    const existing = existingMap.get(f.fingerprint);
    if (existing && existing.status && existing.status !== "unreviewed") {
      merged.push({
        ...f,
        status: existing.status,
        rationale: existing.rationale,
        reviewedBy: existing.reviewedBy,
        reviewedAt: existing.reviewedAt,
        tracking: existing.tracking,
      });
    } else {
      unreviewedCount++;
      merged.push({
        ...f,
        status: f.status || "unreviewed",
        rationale: f.rationale || "Unreviewed finding; human review required.",
        reviewedBy: f.reviewedBy,
        reviewedAt: f.reviewedAt || new Date().toISOString(),
        tracking: f.tracking,
      });
    }
  }

  const map = new Map();
  for (const item of merged) {
    map.set(item.fingerprint, item);
  }
  const sorted = [...map.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));

  return {
    baseline: {
      schema: RATCHET_SCHEMA,
      schemaVersion: RATCHET_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      description: description || "Monotonic finding ratchet baseline. New findings not present in baseline cause CI failure.",
      findings: sorted,
    },
    unreviewedCount,
  };
}

/**
 * Loads baseline from JSON file and validates schema and version.
 * @param {string} baselinePath
 * @returns {Promise<RatchetBaseline>}
 */
export async function loadBaseline(baselinePath) {
  let content;
  try {
    content = await readFile(baselinePath, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      throw new Error(`[RATCHET_FAIL] Baseline file does not exist: ${baselinePath}`);
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(`[RATCHET_FAIL] Malformed baseline JSON in ${baselinePath}: ${e.message}`);
  }
  if (parsed.schema !== RATCHET_SCHEMA) {
    throw new Error(`[RATCHET_FAIL] Invalid baseline schema: ${parsed.schema}, expected ${RATCHET_SCHEMA}`);
  }
  if (parsed.schemaVersion !== RATCHET_SCHEMA_VERSION) {
    throw new Error(`[RATCHET_FAIL] Unsupported baseline schema version: ${parsed.schemaVersion}, expected ${RATCHET_SCHEMA_VERSION}`);
  }
  return parsed;
}

/**
 * Loads findings from a file or directory path, parsing SARIF or JSON deterministically.
 * Fails closed if the path does not exist, if a directory has no findings files, or if data is malformed.
 *
 * @param {string} findingsPath
 * @param {string} product
 * @param {string} [tool]
 * @param {boolean} [isSarif]
 * @returns {Promise<Finding[]>}
 */
export async function loadFindingsFromPath(findingsPath, product, tool, isSarif) {
  if (!findingsPath || typeof findingsPath !== "string" || findingsPath.trim() === "") {
    throw new Error("[RATCHET_FAIL] Missing or empty findings path (--findings or --input)");
  }
  let targetPath = findingsPath;
  /** @type {import("node:fs").Stats | undefined} */
  let st;
  try {
    st = await stat(targetPath);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") throw err;
    const parent = dirname(targetPath);
    try {
      const parentSt = await stat(parent);
      if (parentSt.isDirectory()) {
        const entries = await readdir(parent);
        const sarifs = entries.filter((name) => name.endsWith(".sarif"));
        if (sarifs.length > 0) {
          targetPath = parent;
          st = parentSt;
        }
      }
    } catch {
      // ignore
    }
  }
  if (!st) {
    throw new Error(`[RATCHET_FAIL] Findings path does not exist: ${findingsPath}`);
  }
  /** @type {string[]} */
  const filesToProcess = [];
  if (st.isDirectory()) {
    const dirEntries = await readdir(targetPath);
    const matched = dirEntries.filter((name) => name.endsWith(".sarif") || name.endsWith(".json")).sort();
    if (matched.length === 0) {
      throw new Error(`[RATCHET_FAIL] No .sarif or .json files found in directory: ${targetPath}`);
    }
    for (const name of matched) {
      filesToProcess.push(join(targetPath, name));
    }
  } else {
    filesToProcess.push(targetPath);
  }

  /** @type {Array<Partial<Finding>>} */
  const allRawFindings = [];
  for (const filePath of filesToProcess) {
    const content = await readFile(filePath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error(`[RATCHET_FAIL] Malformed JSON in findings file ${filePath}: ${e.message}`);
    }
    const fileIsSarif = Boolean(isSarif || filePath.endsWith(".sarif") || (parsed && Array.isArray(parsed.runs)));
    if (fileIsSarif) {
      const sarifFindings = parseSarifFindings(parsed, product, tool || undefined);
      allRawFindings.push(...sarifFindings);
    } else if (Array.isArray(parsed)) {
      allRawFindings.push(...parsed);
    } else if (parsed && Array.isArray(parsed.findings)) {
      allRawFindings.push(...parsed.findings);
    } else {
      throw new Error(`[RATCHET_FAIL] Unrecognized findings structure in ${filePath}`);
    }
  }
  return normalizeFindingsCollection(allRawFindings);
}

/**
 * CLI main entry
 * @param {string[]} args
 */
export async function main(args) {
  let baselinePath = "";
  let findingsPath = "";
  let product = "general";
  let mode = "check"; // 'check' | 'update'
  let isSarif = false;
  let tool = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--baseline" && args[i + 1]) {
      baselinePath = resolve(args[++i]);
    } else if ((arg === "--findings" || arg === "--input") && args[i + 1]) {
      findingsPath = resolve(args[++i]);
    } else if (arg === "--product" && args[i + 1]) {
      product = args[++i];
    } else if (arg === "--tool" && args[i + 1]) {
      tool = args[++i];
    } else if (arg === "--check") {
      mode = "check";
    } else if (arg === "--update") {
      mode = "update";
    } else if (arg === "--sarif") {
      isSarif = true;
    }
  }

  if (!baselinePath) {
    throw new Error("Usage: finding-ratchet.mjs --baseline <path> [--findings <path>] [--check|--update] [--product <name>] [--sarif] [--tool <name>]");
  }
  if (mode === "check" && (!findingsPath || findingsPath.trim() === "")) {
    throw new Error("[RATCHET_FAIL] Missing required findings path (--findings or --input) for --check");
  }

  const currentFindings = await loadFindingsFromPath(findingsPath, product, tool, isSarif);

  if (mode === "update") {
    let existingBaseline = undefined;
    try {
      existingBaseline = await loadBaseline(baselinePath);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("[RATCHET_FAIL] Baseline file does not exist")) {
        existingBaseline = undefined;
      } else {
        throw err;
      }
    }
    const { baseline, unreviewedCount } = createBaseline(
      currentFindings,
      existingBaseline,
      `Ratchet baseline updated with ${currentFindings.length} findings.`
    );
    await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + "\n", "utf8");
    console.log(`[RATCHET] Baseline updated: ${baseline.findings.length} findings recorded at ${baselinePath}`);
    if (unreviewedCount > 0) {
      console.error(`[RATCHET_WARNING] ${unreviewedCount} new finding(s) added with status 'unreviewed'. Human review required.`);
      process.exitCode = 1;
    }
    return;
  }

  const baseline = await loadBaseline(baselinePath);
  const result = evaluateRatchet(currentFindings, baseline);

  console.log(`=== Finding Ratchet Evaluation ===`);
  console.log(`Baseline findings: ${result.baselineCount}`);
  console.log(`Current findings:  ${result.currentCount}`);
  console.log(`Resolved findings: ${result.resolvedCount}`);
  console.log(`New findings:      ${result.newCount}`);

  if (!result.passed) {
    console.error(`\n[RATCHET_VIOLATION] Found ${result.newCount} new or unreviewed finding(s) not in baseline:`);
    for (const f of result.newFindings) {
      console.error(`  - [${f.product}] ${f.tool} (${f.ruleId}) in ${f.path}:${f.line ?? 0} - ${f.message} (fp: ${f.fingerprint.slice(0, 12)})`);
    }
    process.exitCode = 1;
  } else {
    console.log(`\n[RATCHET_PASS] All current findings are accounted for in the baseline.`);
    if (result.resolvedCount > 0) {
      console.log(`[RATCHET_IMPROVEMENT] ${result.resolvedCount} findings have been resolved! Run with --update to lower the ratchet.`);
    }
  }
}

const isCliEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCliEntry) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[RATCHET_ERROR] ${err.message}`);
    process.exit(1);
  });
}

