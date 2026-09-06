// @ts-check

import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Validates pull request context and exact HEAD checkout.
 * @param {object} [options]
 * @param {string} [options.eventPath]
 * @param {object} [options.eventPayload]
 * @param {string} [options.expectedBranch]
 * @param {string} [options.expectedBase]
 * @param {string} [options.repoRoot]
 * @param {string} [options.eventName]
 * @param {string} [options.repository]
 * @param {string} [options.jobName]
 * @param {Record<string, string>} [options.matrix]
 * @param {boolean} [options.skipGit]
 * @param {string} [options.mockCommit]
 * @param {string} [options.mockTree]
 * @param {string[]} [options.mockParents]
 * @param {string} [options.mockBaseTree]
 * @param {string} [options.mockHeadTree]
 * @param {boolean} [options.mockClean]
 * @param {"auto" | "staging-head" | "merge-candidate"} [options.checkoutRole]
 */
export async function validateExactHead(options = {}) {
  const eventPath = options.eventPath ?? process.env.GITHUB_EVENT_PATH;
  /** @type {any} */
  let payload = options.eventPayload;
  if (!payload && eventPath) {
    const raw = await readFile(resolve(eventPath), "utf8");
    payload = JSON.parse(raw);
  }

  if (!payload || !payload.pull_request) {
    throw new Error("[EXACT_HEAD_FAIL] Missing or invalid pull_request event payload.");
  }

  const eventName = options.eventName ?? process.env.GITHUB_EVENT_NAME;
  if (eventName !== "pull_request") {
    throw new Error(`[EXACT_HEAD_FAIL] Event name '${eventName}' is not pull_request.`);
  }

  const pr = payload.pull_request;
  const action = payload.action;
  const validActions = new Set(["opened", "synchronize", "reopened"]);
  if (!validActions.has(action)) {
    throw new Error(`[EXACT_HEAD_FAIL] Disallowed pull_request action '${action}'; only opened, synchronize, reopened allowed.`);
  }

  const expectedBase = options.expectedBase ?? "main";
  const expectedHeadBranch = options.expectedBranch ?? "staging";

  const baseRef = pr.base?.ref;
  const headRef = pr.head?.ref;
  const baseSha = pr.base?.sha;
  const headSha = pr.head?.sha;
  const baseRepo = pr.base?.repo?.full_name ?? pr.base?.repo?.name;
  const headRepo = pr.head?.repo?.full_name ?? pr.head?.repo?.name;
  const eventRepo = payload.repository?.full_name;
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY;

  if (baseRef !== expectedBase) {
    throw new Error(`[EXACT_HEAD_FAIL] Base ref mismatch: got '${baseRef}', expected '${expectedBase}'.`);
  }
  if (headRef !== expectedHeadBranch) {
    throw new Error(`[EXACT_HEAD_FAIL] Head ref mismatch: got '${headRef}', expected '${expectedHeadBranch}'.`);
  }
  if (!baseRepo || !headRepo || baseRepo !== headRepo) {
    throw new Error(`[EXACT_HEAD_FAIL] Head repository '${headRepo}' is not identical to base repository '${baseRepo}' (fork PRs forbidden).`);
  }
  if (!repository || !eventRepo || repository !== eventRepo || repository !== baseRepo) {
    throw new Error(`[EXACT_HEAD_FAIL] Workflow repository '${repository}' does not match event repository '${eventRepo}' and PR base repository '${baseRepo}'.`);
  }
  if (!headSha || !/^[0-9a-f]{40}$/u.test(headSha)) {
    throw new Error(`[EXACT_HEAD_FAIL] Invalid or missing pull_request.head.sha: '${headSha}'.`);
  }
  if (!baseSha || !/^[0-9a-f]{40}$/u.test(baseSha) || !Number.isSafeInteger(payload.number) || payload.number < 1) {
    throw new Error("[EXACT_HEAD_FAIL] PR number or base SHA is invalid.");
  }

  const repoRoot = options.repoRoot ?? process.cwd();
  let checkedOutCommit;
  let checkedOutTree;
  let isClean = false;
  /** @type {string[]} */
  let checkedOutParents = [];

  if (options.skipGit) {
    checkedOutCommit = options.mockCommit ?? headSha;
    checkedOutTree = options.mockTree ?? "mock-tree";
    checkedOutParents = options.mockParents ?? [];
    isClean = options.mockClean ?? true;
  } else {
    try {
      checkedOutCommit = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      checkedOutTree = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
      checkedOutParents = execFileSync("git", ["-C", repoRoot, "rev-list", "--parents", "-n", "1", "HEAD"], { encoding: "utf8" }).trim().split(/\s+/u).slice(1);
      const porcelain = execFileSync("git", ["-C", repoRoot, "status", "--porcelain=v1"], { encoding: "utf8" }).trim();
      isClean = porcelain === "";
    } catch (err) {
      throw new Error(`[EXACT_HEAD_FAIL] Failed to inspect git checkout: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!isClean) {
    throw new Error("[EXACT_HEAD_FAIL] Git worktree or index is dirty; exact-head qualification requires clean checkout.");
  }

  const requestedRole = options.checkoutRole ?? "auto";
  /** @type {"staging-head" | "merge-candidate"} */
  let checkoutRole;
  if (checkedOutCommit === headSha) {
    checkoutRole = "staging-head";
  } else if (checkedOutParents.length === 2 && checkedOutParents[0] === baseSha && checkedOutParents[1] === headSha) {
    checkoutRole = "merge-candidate";
  } else {
    throw new Error(`[EXACT_HEAD_FAIL] Checked-out commit '${checkedOutCommit}' is neither the staging head '${headSha}' nor a merge candidate with parents '${baseSha}', '${headSha}' (actual parents: ${checkedOutParents.join(", ") || "none"}).`);
  }
  if (requestedRole !== "auto" && requestedRole !== checkoutRole) {
    throw new Error(`[EXACT_HEAD_FAIL] Checkout role '${checkoutRole}' does not match expected role '${requestedRole}'.`);
  }

  /** @type {string | null} */
  let stagingHeadTree = options.mockHeadTree ?? null;
  if (!options.skipGit) {
    try {
      stagingHeadTree = execFileSync("git", ["-C", repoRoot, "rev-parse", `${headSha}^{tree}`], { encoding: "utf8" }).trim();
    } catch (err) {
      throw new Error(`[EXACT_HEAD_FAIL] Failed to resolve staging head tree '${headSha}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const baseTree = options.mockBaseTree ?? null;

  const matrix = options.matrix ?? (() => {
    if (!process.env.TFSB_MATRIX_JSON) return {};
    const parsed = JSON.parse(process.env.TFSB_MATRIX_JSON);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("[EXACT_HEAD_FAIL] Matrix identity is invalid.");
    return parsed;
  })();
  const npmVersion = options.skipGit
    ? "test"
    : process.env.npm_execpath
      ? execFileSync(process.execPath, [process.env.npm_execpath, "--version"], { encoding: "utf8" }).trim()
      : execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], { encoding: "utf8" }).trim();

  const receipt = {
    schema: "tfsb.ci-exact-head-receipt",
    schemaVersion: 1,
    status: "pass",
    validatedAt: new Date().toISOString(),
    event: {
      name: eventName,
      action,
      number: payload.number,
      baseRef,
      baseSha,
      headRef,
      headSha,
      repository: headRepo,
      baseRepository: baseRepo,
      headRepository: headRepo,
    },
    workflow: {
      name: process.env.GITHUB_WORKFLOW ?? "local-test",
      job: options.jobName ?? process.env.GITHUB_JOB ?? "local-test",
      matrix,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    },
    checkout: {
      role: checkoutRole,
      commit: checkedOutCommit,
      tree: checkedOutTree,
      parents: checkedOutParents,
      clean: true,
    },
    identities: {
      event: {
        name: eventName,
        action,
        number: payload.number,
        repository: eventRepo,
        baseRef,
        baseSha,
        headRef,
        headSha,
      },
      base: {
        ref: baseRef,
        commit: baseSha,
        tree: baseTree,
        repository: baseRepo,
      },
      stagingHead: {
        ref: headRef,
        commit: headSha,
        tree: stagingHeadTree,
        repository: headRepo,
      },
      mergeCandidate: checkoutRole === "merge-candidate"
        ? { commit: checkedOutCommit, tree: checkedOutTree, parents: checkedOutParents }
        : null,
    },
    runner: {
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      npmVersion,
      imageOS: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
    },
  };

  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  /** @type {string | undefined} */
  let outputPath;
  /** @type {string | undefined} */
  let expectedBranch;
  /** @type {string | undefined} */
  let expectedBase;
  /** @type {string | undefined} */
  let repository;
  /** @type {string | undefined} */
  let eventName;
  /** @type {string | undefined} */
  let jobName;
  /** @type {Record<string, string> | undefined} */
  let matrix;
  /** @type {"auto" | "staging-head" | "merge-candidate" | undefined} */
  let checkoutRole;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--output" && value) { outputPath = resolve(value); i++; }
    else if (flag === "--expected-branch" && value) { expectedBranch = value; i++; }
    else if (flag === "--expected-base" && value) { expectedBase = value; i++; }
    else if (flag === "--repository" && value) { repository = value; i++; }
    else if (flag === "--event-name" && value) { eventName = value; i++; }
    else if (flag === "--job" && value) { jobName = value; i++; }
    else if (flag === "--checkout-role" && value && ["auto", "staging-head", "merge-candidate"].includes(value)) { checkoutRole = /** @type {"auto" | "staging-head" | "merge-candidate"} */ (value); i++; }
    else if (flag === "--matrix-json" && value) {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--matrix-json must contain an object.");
      matrix = Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]));
      i++;
    } else throw new Error(`Unsupported or incomplete exact-head argument: ${flag}`);
  }

  /** @type {any} */
  const cliOptions = {};
  if (expectedBranch !== undefined) cliOptions.expectedBranch = expectedBranch;
  if (expectedBase !== undefined) cliOptions.expectedBase = expectedBase;
  if (repository !== undefined) cliOptions.repository = repository;
  if (eventName !== undefined) cliOptions.eventName = eventName;
  if (jobName !== undefined) cliOptions.jobName = jobName;
  if (matrix !== undefined) cliOptions.matrix = matrix;
  if (checkoutRole !== undefined) cliOptions.checkoutRole = checkoutRole;

  validateExactHead(cliOptions)
    .then(async (receipt) => {
      const formatted = JSON.stringify(receipt, null, 2);
      if (outputPath) {
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, `${formatted}\n`, "utf8");
      }
      process.stdout.write(`${formatted}\n`);
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
