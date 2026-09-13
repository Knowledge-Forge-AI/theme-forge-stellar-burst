// @ts-check

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Immutable bound predecessor merge SHA for Theme Forge Stellar Burst.
 * Only null or this predecessor commit triggers polling retry.
 * Release-bound to the single R14 staging push, following head
 * 1043a8f8cd75fd7708f246b6b688d96e59f8e092, tree
 * f94d24ca519e2b593d4425f4fb1c6f5d6050e697. Reauthorize this constant before
 * another staging push or PR; later predecessor merges deliberately fail closed.
 */
export const BOUND_PREDECESSOR_MERGE_SHA = "5f33d85ad2f7b6f62c8c2237faab2817df4a35c8";

/**
 * Validates PR observation for exact match against expected context on every observation.
 * Throws immediately on any drift.
 *
 * @param {any} pr
 * @param {{
 *   number: number,
 *   baseRef: string,
 *   baseSha: string,
 *   headRef: string,
 *   headSha: string,
 *   repo: string,
 * }} expected
 */
export function authenticateObservation(pr, expected) {
  if (!pr || typeof pr !== "object") {
    throw new Error("[BURST_MERGE_FAIL] Invalid pull request observation: not an object.");
  }

  const prNumber = pr.number;
  if (!Number.isSafeInteger(prNumber) || prNumber !== expected.number) {
    throw new Error(`[BURST_MERGE_FAIL] PR number mismatch: got ${pr.number}, expected ${expected.number}.`);
  }

  if (pr.state !== "open") {
    throw new Error(`[BURST_MERGE_FAIL] PR state is not open: got '${pr.state}'.`);
  }

  if (pr.merged !== false || pr.merged_at !== null) {
    throw new Error("[BURST_MERGE_FAIL] PR is already merged.");
  }

  const baseRef = pr.base?.ref;
  if (baseRef !== expected.baseRef) {
    throw new Error(`[BURST_MERGE_FAIL] PR base ref mismatch: got '${baseRef}', expected '${expected.baseRef}'.`);
  }

  const baseSha = pr.base?.sha;
  if (baseSha !== expected.baseSha) {
    throw new Error(`[BURST_MERGE_FAIL] PR base SHA mismatch: got '${baseSha}', expected '${expected.baseSha}'.`);
  }

  const headRef = pr.head?.ref;
  if (headRef !== expected.headRef) {
    throw new Error(`[BURST_MERGE_FAIL] PR head ref mismatch: got '${headRef}', expected '${expected.headRef}'.`);
  }

  const headSha = pr.head?.sha;
  if (headSha !== expected.headSha) {
    throw new Error(`[BURST_MERGE_FAIL] PR head SHA mismatch: got '${headSha}', expected '${expected.headSha}'.`);
  }

  const baseRepo = pr.base?.repo?.full_name;
  const headRepo = pr.head?.repo?.full_name;
  if (!baseRepo || !headRepo || baseRepo !== headRepo) {
    throw new Error(`[BURST_MERGE_FAIL] PR base repo '${baseRepo}' and head repo '${headRepo}' disagree (fork PRs forbidden).`);
  }

  if (expected.repo && (baseRepo !== expected.repo || headRepo !== expected.repo)) {
    throw new Error(`[BURST_MERGE_FAIL] PR repository '${baseRepo}' does not match expected '${expected.repo}'.`);
  }
}

/**
 * Validates candidate commit: must have exactly ordered [base, head] parents
 * and tree equal to the authenticated staging tree.
 *
 * @param {any} commit
 * @param {string} candidateSha
 * @param {{
 *   baseSha: string,
 *   headSha: string,
 *   tree?: string,
 * }} expected
 */
export function validateCandidateCommit(commit, candidateSha, expected) {
  if (!candidateSha || !/^[0-9a-f]{40}$/iu.test(candidateSha)) {
    throw new Error(`[BURST_MERGE_FAIL] Candidate merge commit SHA '${candidateSha}' is invalid.`);
  }

  if (candidateSha === expected.headSha) {
    throw new Error(`[BURST_MERGE_FAIL] Candidate merge commit SHA '${candidateSha}' must differ from staging head '${expected.headSha}'.`);
  }

  if (!commit || typeof commit !== "object") {
    throw new Error(`[BURST_MERGE_FAIL] Commit read for '${candidateSha}' returned non-object.`);
  }

  if (commit.sha !== candidateSha) throw new Error("[BURST_MERGE_FAIL] Commit response SHA mismatch.");

  const rawParents = Array.isArray(commit.parents) ? commit.parents : [];
  const parents = rawParents.map((/** @type {any} */ p) => (typeof p === "string" ? p : p?.sha));

  if (parents.length !== 2) {
    throw new Error(`[BURST_MERGE_FAIL] Candidate merge commit '${candidateSha}' must have exactly 2 parents, got ${parents.length}: [${parents.join(", ")}].`);
  }

  if (parents[0] !== expected.baseSha || parents[1] !== expected.headSha) {
    throw new Error(`[BURST_MERGE_FAIL] Candidate merge commit '${candidateSha}' parents are not exactly ordered [base, head]: got [${parents.join(", ")}], expected [${expected.baseSha}, ${expected.headSha}].`);
  }

  const treeSha = typeof commit.tree === "string"
    ? commit.tree
    : commit.tree?.sha ?? commit.commit?.tree?.sha;

  if (!treeSha || !/^[0-9a-f]{40}$/iu.test(treeSha)) {
    throw new Error(`[BURST_MERGE_FAIL] Candidate merge commit '${candidateSha}' has invalid tree SHA: '${treeSha}'.`);
  }

  if (!expected.tree || treeSha !== expected.tree) {
    throw new Error(`[BURST_MERGE_FAIL] Candidate merge tree '${treeSha}' does not equal authenticated staging tree '${expected.tree}'.`);
  }
}

/**
 * Resolves current PR merge candidate with bounded GitHub GET polling.
 *
 * @param {object} [options]
 * @param {string | undefined} [options.receiptPath]
 * @param {any} [options.receipt]
 * @param {number | undefined} [options.expectedNumber]
 * @param {number | undefined} [options.pr]
 * @param {string | undefined} [options.expectedBaseRef]
 * @param {string | undefined} [options.expectedBaseSha]
 * @param {string | undefined} [options.expectedHeadRef]
 * @param {string | undefined} [options.expectedHeadSha]
 * @param {string | undefined} [options.expectedRepo]
 * @param {string | undefined} [options.repo]
 * @param {string | undefined} [options.expectedTree]
 * @param {string | undefined} [options.predecessorMergeSha]
 * @param {string | undefined} [options.token]
 * @param {string | undefined} [options.apiUrl]
 * @param {number | undefined} [options.requestTimeoutMs]
 * @param {number | undefined} [options.overallBudgetMs]
 * @param {number | undefined} [options.pollIntervalMs]
 * @param {typeof globalThis.fetch} [options.fetchFn]
 * @param {() => number} [options.nowFn]
 * @param {(ms: number) => Promise<void>} [options.sleepFn]
 * @param {(options: { repo: string, number: number, signal: AbortSignal }) => Promise<any>} [options.readPullRequest]
 * @param {(options: { repo: string, sha: string, signal: AbortSignal }) => Promise<any>} [options.readCommit]
 */
export async function resolveBurstMergeCandidate(options = {}) {
  let receipt = options.receipt;
  if (!receipt && options.receiptPath) {
    const raw = await readFile(resolve(options.receiptPath), "utf8");
    receipt = JSON.parse(raw);
  }

  const expectedNumber = Number(
    options.expectedNumber ?? options.pr ?? receipt?.event?.number ?? receipt?.identities?.event?.number
  );
  const expectedBaseRef = options.expectedBaseRef ?? receipt?.identities?.base?.ref ?? receipt?.event?.baseRef ?? "main";
  const expectedBaseSha = options.expectedBaseSha ?? receipt?.identities?.base?.commit ?? receipt?.event?.baseSha;
  const expectedHeadRef = options.expectedHeadRef ?? receipt?.identities?.stagingHead?.ref ?? receipt?.event?.headRef ?? "staging";
  const expectedHeadSha = options.expectedHeadSha ?? receipt?.identities?.stagingHead?.commit ?? receipt?.event?.headSha ?? receipt?.checkout?.commit;
  const expectedRepo = options.expectedRepo ?? options.repo ?? receipt?.event?.repository ?? receipt?.identities?.base?.repository ?? receipt?.identities?.stagingHead?.repository ?? process.env.GITHUB_REPOSITORY;
  const expectedTree = options.expectedTree ?? receipt?.identities?.stagingHead?.tree ?? receipt?.checkout?.tree;
  const predecessorMergeSha = BOUND_PREDECESSOR_MERGE_SHA;

  if (!Number.isSafeInteger(expectedNumber) || expectedNumber < 1) {
    throw new Error(`[BURST_MERGE_FAIL] Invalid or missing PR number: ${expectedNumber}.`);
  }
  if (!expectedBaseSha || !/^[0-9a-f]{40}$/iu.test(expectedBaseSha)) {
    throw new Error(`[BURST_MERGE_FAIL] Invalid or missing expected base SHA: '${expectedBaseSha}'.`);
  }
  if (!expectedHeadSha || !/^[0-9a-f]{40}$/iu.test(expectedHeadSha)) {
    throw new Error(`[BURST_MERGE_FAIL] Invalid or missing expected head SHA: '${expectedHeadSha}'.`);
  }
  if (!expectedRepo || typeof expectedRepo !== "string" || !expectedRepo.includes("/")) {
    throw new Error(`[BURST_MERGE_FAIL] Invalid or missing expected repository: '${expectedRepo}'.`);
  }
  if (!expectedTree || !/^[0-9a-f]{40}$/u.test(expectedTree)) {
    throw new Error(`[BURST_MERGE_FAIL] Invalid expected tree SHA: '${expectedTree}'.`);
  }
  if (!predecessorMergeSha || !/^[0-9a-f]{40}$/iu.test(predecessorMergeSha)) {
    throw new Error(`[BURST_MERGE_FAIL] Invalid predecessor merge SHA: '${predecessorMergeSha}'.`);
  }

  if (expectedBaseRef !== "main" || expectedHeadRef !== "staging") throw new Error("[BURST_MERGE_FAIL] Fixed main/staging refs required.");
  if (options.predecessorMergeSha && options.predecessorMergeSha !== BOUND_PREDECESSOR_MERGE_SHA) throw new Error("[BURST_MERGE_FAIL] Unbound predecessor override.");
  if (receipt && (receipt.schema !== "tfsb.ci-exact-head-receipt" || receipt.schemaVersion !== 1 || receipt.status !== "pass" || receipt.checkout?.role !== "staging-head" || receipt.checkout.commit !== expectedHeadSha || receipt.checkout.tree !== expectedTree || receipt.event?.headSha !== expectedHeadSha || receipt.event?.baseSha !== expectedBaseSha)) throw new Error("[BURST_MERGE_FAIL] Unauthenticated source-policy receipt.");

  const expected = {
    number: expectedNumber,
    baseRef: expectedBaseRef,
    baseSha: expectedBaseSha,
    headRef: expectedHeadRef,
    headSha: expectedHeadSha,
    repo: expectedRepo,
    tree: expectedTree,
  };

  const nowFn = options.nowFn ?? Date.now;
  const sleepFn = options.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const requestTimeoutMs = Number(options.requestTimeoutMs ?? 10_000);
  const overallBudgetMs = Number(options.overallBudgetMs ?? 180_000);
  const pollIntervalMs = Number(options.pollIntervalMs ?? 2_000);
  if (![requestTimeoutMs, overallBudgetMs, pollIntervalMs].every(v => Number.isSafeInteger(v) && v > 0) || overallBudgetMs > 180_000 || requestTimeoutMs > 10_000) throw new Error("[BURST_MERGE_FAIL] Invalid polling bounds.");
  const apiUrl = options.apiUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com";
  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const readPullRequest = options.readPullRequest ?? (async ({ repo, number, signal }) => {
    const url = `${apiUrl}/repos/${repo}/pulls/${number}`;
    /** @type {Record<string, string>} */
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "tfsb-burst-merge-candidate",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchFn(url, { headers, signal });
    if (!res.ok) {
      throw new Error(`[BURST_MERGE_FAIL] GitHub API GET '${url}' failed with status ${res.status}: ${await res.text().catch(() => "")}`);
    }
    return await res.json();
  });

  const readCommit = options.readCommit ?? (async ({ repo, sha, signal }) => {
    const url = `${apiUrl}/repos/${repo}/git/commits/${sha}`;
    /** @type {Record<string, string>} */
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "tfsb-burst-merge-candidate",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchFn(url, { headers, signal });
    if (res.ok) {
      return await res.json();
    }
    throw new Error(`[BURST_MERGE_FAIL] GitHub commit GET failed: ${res.status}`);
  });

  const startTime = nowFn();
  let attempt = 0;

  while (true) {
    const elapsed = nowFn() - startTime;
    if (elapsed >= overallBudgetMs) {
      throw new Error(`[BURST_MERGE_FAIL] Timed out waiting for merge candidate after ${elapsed}ms (budget: ${overallBudgetMs}ms, attempts: ${attempt}).`);
    }

    attempt++;

    const prSignal = AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, overallBudgetMs - (nowFn() - startTime))));
    const pr = await readPullRequest({ repo: expectedRepo, number: expectedNumber, signal: prSignal });

    if (nowFn() - startTime >= overallBudgetMs) throw new Error("[BURST_MERGE_FAIL] Polling budget exceeded.");
    authenticateObservation(pr, expected);

    const mergeSha = pr.merge_commit_sha;

    const isNullCurrent = mergeSha === null;
    const isPredecessor = mergeSha === predecessorMergeSha;

    if (isNullCurrent || isPredecessor) {
      const currentElapsed = nowFn() - startTime;
      if (currentElapsed + pollIntervalMs > overallBudgetMs) {
        throw new Error(`[BURST_MERGE_FAIL] Polling budget exceeded while waiting for current merge candidate (attempts: ${attempt}, elapsed: ${currentElapsed}ms).`);
      }
      await sleepFn(pollIntervalMs);
      continue;
    }

    if (typeof mergeSha !== "string" || !/^[0-9a-f]{40}$/u.test(mergeSha)) throw new Error("[BURST_MERGE_FAIL] Malformed merge SHA.");
    const commitSignal = AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, overallBudgetMs - (nowFn() - startTime))));
    const commit = await readCommit({ repo: expectedRepo, sha: mergeSha, signal: commitSignal });

    if (nowFn() - startTime >= overallBudgetMs) throw new Error("[BURST_MERGE_FAIL] Polling budget exceeded.");
    validateCandidateCommit(commit, mergeSha, expected);

    const treeSha = typeof commit.tree === "string" ? commit.tree : commit.tree?.sha ?? commit.commit?.tree?.sha;
    const parents = (Array.isArray(commit.parents) ? commit.parents : []).map((/** @type {any} */ p) => (typeof p === "string" ? p : p?.sha));

    return {
      mergeCommitSha: mergeSha,
      mergeTreeSha: treeSha,
      parents,
      attempts: attempt,
      elapsedMs: nowFn() - startTime,
      receipt: {
        schema: "tfsb.burst-merge-candidate-receipt-v1",
        status: "pass",
        resolvedAt: new Date().toISOString(),
        pr: {
          number: expectedNumber,
          repo: expectedRepo,
          baseSha: expectedBaseSha,
          headSha: expectedHeadSha,
        },
        mergeCandidate: {
          commit: mergeSha,
          tree: treeSha,
          parents,
        },
        attempts: attempt,
      },
    };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  /** @type {string | undefined} */
  let receiptPath;
  /** @type {number | undefined} */
  let expectedNumber;
  /** @type {string | undefined} */
  let expectedBaseSha;
  /** @type {string | undefined} */
  let expectedBaseRef;
  /** @type {string | undefined} */
  let expectedHeadSha;
  /** @type {string | undefined} */
  let expectedHeadRef;
  /** @type {string | undefined} */
  let expectedRepo;
  /** @type {string | undefined} */
  let expectedTree;
  /** @type {string | undefined} */
  let predecessorMergeSha;
  /** @type {string | undefined} */
  let githubOutput;
  /** @type {string | undefined} */
  let outputPath;
  /** @type {number | undefined} */
  let timeoutMs;
  /** @type {number | undefined} */
  let budgetMs;
  /** @type {number | undefined} */
  let pollIntervalMs;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const val = args[i + 1];
    if (flag === "--receipt" && val) { receiptPath = val; i++; }
    else if ((flag === "--expected-number" || flag === "--pr") && val) { expectedNumber = Number(val); i++; }
    else if ((flag === "--expected-base" || flag === "--expected-base-sha") && val) { expectedBaseSha = val; i++; }
    else if (flag === "--expected-base-ref" && val) { expectedBaseRef = val; i++; }
    else if ((flag === "--expected-head" || flag === "--expected-head-sha") && val) { expectedHeadSha = val; i++; }
    else if (flag === "--expected-head-ref" && val) { expectedHeadRef = val; i++; }
    else if (flag === "--expected-tree" && val) { expectedTree = val; i++; }
    else if ((flag === "--expected-repo" || flag === "--repo") && val) { expectedRepo = val; i++; }
    else if (flag === "--predecessor-merge" && val) { predecessorMergeSha = val; i++; }
    else if (flag === "--github-output" && val) { githubOutput = val; i++; }
    else if (flag === "--output" && val) { outputPath = val; i++; }
    else if (flag === "--timeout-ms" && val) { timeoutMs = Number(val); i++; }
    else if (flag === "--budget-ms" && val) { budgetMs = Number(val); i++; }
    else if (flag === "--poll-interval-ms" && val) { pollIntervalMs = Number(val); i++; }
    else {
      throw new Error(`[BURST_MERGE_FAIL] Unknown or incomplete argument: ${flag}`);
    }
  }

  if (!receiptPath && existsSync(resolve(".test-reports/source-policy/receipt.json"))) {
    receiptPath = ".test-reports/source-policy/receipt.json";
  }

  resolveBurstMergeCandidate({
    receiptPath,
    expectedNumber,
    expectedBaseSha,
    expectedBaseRef,
    expectedHeadSha,
    expectedHeadRef,
    expectedRepo,
    expectedTree,
    predecessorMergeSha,
    requestTimeoutMs: timeoutMs,
    overallBudgetMs: budgetMs,
    pollIntervalMs,
  })
    .then(async (result) => {
      process.stdout.write(`[BURST_MERGE] Resolved merge candidate commit: ${result.mergeCommitSha} (tree: ${result.mergeTreeSha}, attempts: ${result.attempts})\n`);

      const targetGithubOutput = githubOutput || process.env.GITHUB_OUTPUT;
      if (targetGithubOutput) {
        await appendFile(resolve(targetGithubOutput), `merge-commit-sha=${result.mergeCommitSha}\nmerge-tree-sha=${result.mergeTreeSha}\n`, "utf8");
      }

      if (outputPath) {
        await mkdir(dirname(resolve(outputPath)), { recursive: true });
        await writeFile(resolve(outputPath), JSON.stringify(result.receipt, null, 2) + "\n", "utf8");
      }
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
