// @ts-check
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { ensureToolWithProvenance, hostPlatformTuple } from "./run-syft-grype.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const TOOL_NAMES = ["actionlint", "zizmor", "betterleaks"];

/**
 * @param {string} root
 */
async function discoverWorkflowFiles(root) {
  const workflowRoot = join(root, ".github", "workflows");
  if (!existsSync(workflowRoot)) throw new Error("[WORKFLOW_CHECK_FAIL] .github/workflows is missing.");
  /** @type {string[]} */
  const files = [];
  /** @param {string} current */
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:yml|yaml)$/u.test(entry.name)) files.push(relative(root, path));
    }
  }
  await visit(workflowRoot);
  if (files.length === 0) throw new Error("[WORKFLOW_CHECK_FAIL] No workflow YAML files found.");
  return files;
}

/**
 * @param {string} value
 * @param {string} root
 */
function sanitizeOutput(value, root) {
  /** @type {string[]} */
  const roots = [resolve(root), process.cwd(), process.env.HOME].filter((candidate) => typeof candidate === "string");
  return roots.reduce((sanitized, candidate) => sanitized.split(candidate).join("."), value);
}

/**
 * Keep retained command records useful without preserving an output directory
 * path that may live outside the composed source tree. The actual args passed
 * to the subprocess remain unchanged.
 *
 * @param {string} tool
 * @param {string[]} args
 * @param {string} root
 */
function sanitizeRecordedArgs(tool, args, root) {
  return args.map((argument, index) => {
    if (tool === "betterleaks" && args[index - 1] === "--report-path") {
      return "<workflow-check-output>/betterleaks.report.json";
    }
    return sanitizeOutput(argument, root);
  });
}

/**
 * Keep selected checks independent of operator configuration, credentials,
 * and baseline/validation overrides. Tool binaries are absolute and do not
 * need the shell's inherited environment to execute.
 *
 * @param {string} tool
 * @param {string} isolatedHome
 */
function isolatedCheckEnvironment(tool, isolatedHome) {
  /** @type {NodeJS.ProcessEnv} */
  const environment = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "NO_COLOR", "CI"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.HOME = isolatedHome;
  environment.XDG_CONFIG_HOME = join(isolatedHome, "config");
  environment.XDG_CACHE_HOME = join(isolatedHome, "cache");
  environment.TMPDIR = join(isolatedHome, "tmp");
  if (tool === "zizmor") environment.ZIZMOR_OFFLINE = "1";
  return environment;
}

/**
 * Betterleaks emits `null` for a clean JSON report. Require parseable JSON and
 * retain the tool's null/object/array report shapes so a truncated or text
 * file cannot be accepted merely because it exists.
 *
 * @param {string} reportPath
 */
async function validateBetterleaksReport(reportPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    throw new Error(`Betterleaks JSON report is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed !== null && (typeof parsed !== "object" || parsed === undefined)) {
    throw new Error("Betterleaks JSON report has an unexpected shape.");
  }
}

/**
 * @param {string} tool
 * @param {{path: string, version: string, versionArgs: string[], binarySha256: string, authenticatedBinarySha256: string, source: string, platform: string, archive: object}} provenance
 * @param {string[]} args
 * @param {string} root
 * @param {string} outputDir
 */
async function executeCheck(tool, provenance, args, root, outputDir) {
  const stdoutPath = join(outputDir, `${tool}.stdout.log`);
  const stderrPath = join(outputDir, `${tool}.stderr.log`);
  const resultPath = join(outputDir, `${tool}.result.json`);
  const isolatedHome = join(tmpdir(), "tfsb-workflow-check-home", hostPlatformTuple());
  const configHome = join(isolatedHome, "config");
  const cacheHome = join(isolatedHome, "cache");
  const tempHome = join(isolatedHome, "tmp");
  await mkdir(isolatedHome, { recursive: true });
  const env = isolatedCheckEnvironment(tool, isolatedHome);
  await mkdir(configHome, { recursive: true });
  await mkdir(cacheHome, { recursive: true });
  await mkdir(tempHome, { recursive: true });
  const startedAt = new Date().toISOString();
  const result = spawnSync(provenance.path, args, {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  const stdout = sanitizeOutput(String(result.stdout ?? ""), root);
  const stderr = sanitizeOutput(String(result.stderr ?? ""), root);
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  const status = result.error || result.status !== 0 ? "fail" : "pass";
  const record = {
    schema: "tfsb.workflow-check-result-v1",
    schemaVersion: 1,
    tool,
    version: provenance.version,
    versionArgs: provenance.versionArgs,
    platform: provenance.platform,
    binarySha256: provenance.binarySha256,
    authenticatedBinarySha256: provenance.authenticatedBinarySha256,
    source: provenance.source,
    archive: provenance.archive,
    command: [tool, ...sanitizeRecordedArgs(tool, args, root)],
    cwd: ".",
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    exitCode: result.status,
    signal: result.signal,
    error: result.error ? sanitizeOutput(String(result.error.message ?? result.error), root) : null,
    stdout: basename(stdoutPath),
    stderr: basename(stderrPath)
  };
  await writeFile(resultPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  return { ...record, stdoutPath, stderrPath, resultPath };
}

/**
 * Runs the selected local workflow checks with authenticated pinned binaries.
 * Actionlint, offline Zizmor, and Betterleaks are intentionally independent;
 * all are attempted and any acquisition, execution, or finding status fails
 * the aggregate command.
 *
 * @param {{root: string, outputDir: string, toolsDir?: string}} options
 */
export async function runWorkflowChecks(options) {
  const root = resolve(options.root);
  const outputDir = resolve(options.outputDir);
  if (!existsSync(root)) throw new Error(`[WORKFLOW_CHECK_FAIL] Root not found: ${basename(root)}`);
  await mkdir(outputDir, { recursive: true });
  const workflowFiles = await discoverWorkflowFiles(root);
  const toolsDir = resolve(options.toolsDir ?? process.env.TFSB_TOOL_CACHE ?? join(tmpdir(), "tfsb-workflow-tools", hostPlatformTuple()));
  /** @type {any[]} */
  const results = [];

  /** @param {string} tool */
  async function acquireAndRun(tool) {
    let provenance;
    try {
      provenance = await ensureToolWithProvenance(tool, toolsDir);
    } catch (error) {
      const record = {
        schema: "tfsb.workflow-check-result-v1",
        schemaVersion: 1,
        tool,
        status: "fail",
        error: sanitizeOutput(error instanceof Error ? error.message : String(error), root)
      };
      await writeFile(join(outputDir, `${tool}.result.json`), JSON.stringify(record, null, 2) + "\n", "utf8");
      results.push(record);
      return;
    }

    let args;
    if (tool === "actionlint") {
      args = ["-no-color", ...workflowFiles];
    } else if (tool === "zizmor") {
      args = ["--offline", ...workflowFiles];
    } else {
      const reportPath = join(outputDir, "betterleaks.report.json");
      await rm(reportPath, { force: true });
      const reportArg = relative(root, reportPath) || basename(reportPath);
      args = ["dir", ".", "--report-path", reportArg, "--report-format", "json"];
    }
    results.push(await executeCheck(tool, provenance, args, root, outputDir));
    if (tool === "betterleaks" && !existsSync(join(outputDir, "betterleaks.report.json"))) {
      const recordPath = join(outputDir, "betterleaks.result.json");
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      record.status = "fail";
      record.error = "Betterleaks did not produce its required JSON report.";
      await writeFile(recordPath, JSON.stringify(record, null, 2) + "\n", "utf8");
      results[results.length - 1] = { ...record };
    } else if (tool === "betterleaks") {
      try {
        await validateBetterleaksReport(join(outputDir, "betterleaks.report.json"));
      } catch (error) {
        const recordPath = join(outputDir, "betterleaks.result.json");
        const record = JSON.parse(await readFile(recordPath, "utf8"));
        record.status = "fail";
        record.error = sanitizeOutput(error instanceof Error ? error.message : String(error), root);
        await writeFile(recordPath, JSON.stringify(record, null, 2) + "\n", "utf8");
        results[results.length - 1] = { ...record };
      }
    }
  }

  for (const tool of TOOL_NAMES) await acquireAndRun(tool);
  const status = results.every((result) => result.status === "pass") ? "pass" : "fail";
  const receipt = {
    schema: "tfsb.workflow-checks-receipt-v1",
    schemaVersion: 1,
    status,
    root: ".",
    workflowFiles,
    checks: results.map((result) => ({
      tool: result.tool,
      status: result.status,
      version: result.version ?? null,
      result: basename(result.resultPath ?? join(outputDir, `${result.tool}.result.json`)),
      stdout: result.stdout ? basename(result.stdout) : null,
      stderr: result.stderr ? basename(result.stderr) : null,
      report: result.tool === "betterleaks" && existsSync(join(outputDir, "betterleaks.report.json")) ? "betterleaks.report.json" : null,
      error: result.error ?? null
    }))
  };
  await writeFile(join(outputDir, "workflow-checks.receipt.json"), JSON.stringify(receipt, null, 2) + "\n", "utf8");
  if (status !== "pass") throw new Error("[WORKFLOW_CHECK_FAIL] One or more selected workflow checks failed.");
  return receipt;
}

/**
 * @param {string[]} args
 */
export async function main(args = process.argv.slice(2)) {
  let root = ".";
  let outputDir = ".test-reports/workflow-checks";
  /** @type {string | undefined} */
  let toolsDir;
  for (let i = 0; i < args.length; i++) {
    const current = args[i];
    const next = args[i + 1];
    if (current === "--root" && next !== undefined) { root = next; i++; }
    else if (current === "--output-dir" && next !== undefined) { outputDir = next; i++; }
    else if (current === "--tools-dir" && next !== undefined) { toolsDir = next; i++; }
    else throw new Error(`Unknown or incomplete argument: ${current}`);
  }
  /** @type {{root: string, outputDir: string, toolsDir?: string}} */
  const options = { root, outputDir };
  if (toolsDir !== undefined) options.toolsDir = toolsDir;
  const receipt = await runWorkflowChecks(options);
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
