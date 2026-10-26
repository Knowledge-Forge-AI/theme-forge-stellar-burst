// @ts-check
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { readFile, readdir, mkdir, writeFile, stat, lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseSarifFindings, normalizeFindingsCollection } from "./finding-ratchet.mjs";
const [input, output, product, tool, category, receiptPathArg] = process.argv.slice(2);
const receiptPath = receiptPathArg || process.env.TFSB_EXACT_HEAD_RECEIPT;
if (!input || !output || !product || !tool || !category || !receiptPath) throw new Error("input output product tool category exact-head-receipt required");
const digest = (/** @type {Buffer} */ b) => createHash("sha256").update(b).digest("hex");
const SHA1 = /^[0-9a-f]{40}$/u;
const MAX_RECEIPT_BYTES = 64 * 1024;

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read the private exact-head receipt without following links or parsing an
 * unbounded input. The receipt is generated in the job workspace and is not
 * a public artifact; failures deliberately avoid echoing its path or bytes.
 * @param {unknown} path
 * @returns {Promise<any>}
 */
async function readExactHeadReceipt(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("[SECURITY_REPORT_BINDING] Exact-head receipt is missing or unauthenticated.");
  }
  /** @type {import("node:fs/promises").FileHandle | undefined} */
  let handle;
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("[SECURITY_REPORT_BINDING] Exact-head receipt is missing or unauthenticated.");
    }
    const noFollow = constants.O_NOFOLLOW ?? 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const info = await handle.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size > MAX_RECEIPT_BYTES) {
      throw new Error("[SECURITY_REPORT_BINDING] Exact-head receipt is missing or unauthenticated.");
    }
    const buffer = Buffer.allocUnsafe(MAX_RECEIPT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_RECEIPT_BYTES) {
      throw new Error("[SECURITY_REPORT_BINDING] Exact-head receipt is missing or unauthenticated.");
    }
    const raw = buffer.subarray(0, bytesRead).toString("utf8");
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("[SECURITY_REPORT_BINDING] Exact-head receipt is missing or unauthenticated.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[SECURITY_REPORT_BINDING]")) throw error;
    throw new Error("[SECURITY_REPORT_BINDING] Exact-head receipt is missing or unauthenticated.");
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Bind a report to the exact merge-candidate checkout established by exact-head.mjs.
 * GITHUB_SHA is intentionally not used: pull_request events expose a mutable
 * merge ref there, which can lag the source-policy merge candidate.
 *
 * @param {any} receipt
 * @param {any} event
 * @returns {string}
 */
function validateMergeCandidateReceipt(receipt, event) {
  const runId = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  const workflow = process.env.GITHUB_WORKFLOW;
  const workflowRef = process.env.GITHUB_WORKFLOW_REF;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!runId || !attempt || !workflow || !workflowRef || !repository) {
    throw new Error("[SECURITY_REPORT_BINDING] Missing GitHub run, workflow, or repository identity.");
  }
  if (!isRecord(receipt) || receipt.schema !== "tfsb.ci-exact-head-receipt" || receipt.schemaVersion !== 1 || receipt.status !== "pass") {
    throw new Error("[SECURITY_REPORT_BINDING] Exact-head receipt is missing or unauthenticated.");
  }

  const pullRequest = isRecord(event) && isRecord(event.pull_request) ? event.pull_request : null;
  const eventRepository = isRecord(event) && isRecord(event.repository) ? event.repository.full_name : undefined;
  const headSha = isRecord(pullRequest?.head) ? pullRequest.head.sha : undefined;
  const baseSha = isRecord(pullRequest?.base) ? pullRequest.base.sha : undefined;
  const prNumber = event?.number;
  if (!SHA1.test(String(headSha ?? "")) || !SHA1.test(String(baseSha ?? "")) || !Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new Error("[SECURITY_REPORT_BINDING] Pull-request event identity is invalid.");
  }

  const checkout = receipt.checkout;
  const merge = isRecord(receipt.identities) ? receipt.identities.mergeCandidate : null;
  const receiptEvent = receipt.event;
  const receiptWorkflow = receipt.workflow;
  const receiptStaging = isRecord(receipt.identities) ? receipt.identities.stagingHead : null;
  if (!isRecord(checkout) || checkout.role !== "merge-candidate" || checkout.clean !== true || !SHA1.test(String(checkout.commit ?? "")) || !SHA1.test(String(checkout.tree ?? ""))) {
    throw new Error("[SECURITY_REPORT_BINDING] Exact-head receipt does not attest to a clean merge-candidate checkout.");
  }
  if (!isRecord(merge) || merge.commit !== checkout.commit || merge.tree !== checkout.tree || !Array.isArray(merge.parents) || merge.parents.length !== 2 || merge.parents[0] !== baseSha || merge.parents[1] !== headSha) {
    throw new Error("[SECURITY_REPORT_BINDING] Exact-head merge-candidate identity does not match the pull-request event.");
  }
  if (!isRecord(receiptEvent) || receiptEvent.name !== "pull_request" || receiptEvent.action !== event.action || receiptEvent.repository !== repository || receiptEvent.baseRepository !== repository || receiptEvent.headRepository !== repository || receiptEvent.baseRef !== pullRequest.base?.ref || receiptEvent.headRef !== pullRequest.head?.ref || receiptEvent.baseSha !== baseSha || receiptEvent.headSha !== headSha || receiptEvent.number !== prNumber) {
    throw new Error("[SECURITY_REPORT_BINDING] Exact-head receipt event identity does not match this pull request.");
  }
  if (!isRecord(receiptStaging) || receiptStaging.repository !== repository || receiptStaging.commit !== headSha || !SHA1.test(String(receiptStaging.tree ?? ""))) {
    throw new Error("[SECURITY_REPORT_BINDING] Exact-head receipt staging-head identity does not match this pull request.");
  }
  if (!isRecord(receiptWorkflow) || receiptWorkflow.runId !== runId || receiptWorkflow.runAttempt !== attempt || receiptWorkflow.name !== workflow) {
    throw new Error("[SECURITY_REPORT_BINDING] Exact-head receipt workflow identity does not match this run.");
  }
  if (eventRepository !== repository) {
    throw new Error("[SECURITY_REPORT_BINDING] Pull-request event repository does not match this workflow repository.");
  }
  return merge.commit;
}

/** @type {any} */
const report = { schema: "tfsb.security-report-v1", status: "unavailable", binding: {
  repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT, analyzedCommit: null,
  workflowRef: process.env.GITHUB_WORKFLOW_REF, category, product, tool,
}, reports: [], findings: [] };
try {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH || "", "utf8"));
  report.binding.analyzedCommit = validateMergeCandidateReceipt(await readExactHeadReceipt(receiptPath), event);
  report.binding.prHead = event.pull_request?.head?.sha;
  report.binding.pr = event.pull_request?.number ?? null;
  report.binding.workflowSha256 = digest(await readFile(".github/workflows/ci.yml"));
  const st = await stat(input);
  const files = st.isDirectory() ? (await readdir(input)).filter(n => n.endsWith(".sarif")).sort().map(n => join(input,n)) : [input];
  if (!files.length) throw new Error("SARIF unavailable: no report files");
  for (const file of files) {
    const raw = await readFile(file);
    const rawSha256 = digest(raw);
    report.reports.push({ path: file, bytes: raw.length, sha256: rawSha256 });
    const sarif = JSON.parse(raw.toString("utf8"));
    if (!Array.isArray(sarif.runs) || !sarif.runs.length || sarif.runs.some((/** @type {any} */ r) => !Array.isArray(r.results))) throw new Error("Malformed or incomplete SARIF runs/results");
    const findings = parseSarifFindings(sarif, product, tool);
    report.findings.push(...findings.map(f => ({...f, evidence: {...f.evidence, rawSha256}})));
  }
  report.findings = normalizeFindingsCollection(report.findings);
  report.status = "complete";
} catch (error) {
  report.status = "unavailable";
  report.error = error instanceof Error ? error.message : "report generation failed";
  process.exitCode = 1;
} finally {
  await mkdir(resolve(output, ".."), {recursive:true});
  await writeFile(output, JSON.stringify(report,null,2)+"\n");
}
