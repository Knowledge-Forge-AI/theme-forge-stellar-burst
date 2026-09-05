#!/usr/bin/env node

import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(repositoryRoot, "native/directory-snapshot/src/directory_snapshot.c");
const knownArtifacts = new Set(["darwin-arm64", "darwin-x64", "linux-x64-gnu"]);

/** @param {string} message @returns {never} */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

/** @param {string} name @returns {string | undefined} */
function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const isCheckMode = process.argv.includes("--check");
const checkTracked = process.argv.includes("--check-tracked");

function hostArtifact() {
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
    return `darwin-${process.arch}`;
  }
  if (process.platform === "linux" && process.arch === "x64") {
    const report = /** @type {{ header?: { glibcVersionRuntime?: unknown } } | undefined} */ (process.report?.getReport());
    const glibc = report && typeof report === "object" && "header" in report
      ? report.header?.glibcVersionRuntime
      : undefined;
    if (typeof glibc === "string" && glibc.length > 0) return "linux-x64-gnu";
  }
  return undefined;
}

/**
 * @param {string} commandName
 * @param {string[]} args
 * @param {{ capture?: boolean }} [options]
 * @returns {string}
 */
function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) fail(`Unable to execute ${commandName}.`);
  if (result.status !== 0) fail(`${commandName} exited with status ${result.status ?? "unknown"}.`);
  return options.capture ? String(result.stdout).trim() : "";
}

/** @param {string} path @returns {string} */
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const artifact = argument("--artifact") ?? hostArtifact();
if (artifact === undefined || !knownArtifacts.has(artifact)) fail("The current host has no selected directory snapshot artifact.");
if (artifact !== hostArtifact()) fail("Native artifacts must be built on the exact executing platform and architecture.");

const nodePrefix = process.config.variables.node_prefix;
/** @type {string[]} */
const includeCandidates = [resolve(dirname(process.execPath), "../include/node")];
if (typeof nodePrefix === "string") includeCandidates.unshift(resolve(nodePrefix, "include/node"));
const uniqueIncludeCandidates = [...new Set(includeCandidates)];
const includePath = uniqueIncludeCandidates.find((candidate) => {
  try {
    accessSync(join(candidate, "node_api.h"), constants.R_OK);
    return true;
  } catch {
    return false;
  }
});
if (includePath === undefined) fail("Unable to locate node_api.h from the active Node installation.");

const defaultOutputDirectory = join(repositoryRoot, "native/directory-snapshot/prebuilds", artifact);
const customOutput = argument("--output");
const outputDirectory = customOutput !== undefined ? resolve(repositoryRoot, customOutput) : defaultOutputDirectory;
const outputPath = join(outputDirectory, "native-addon-posix-openat-v1.node");
const manifestPath = join(outputDirectory, "manifest.json");

const compiler = process.env.CC || "cc";
const common = ["-O2", "-Wall", "-Wextra", "-Werror", "-std=c11", `-I${includePath}`];
const platformFlags = process.platform === "darwin"
  ? ["-bundle", "-undefined", "dynamic_lookup", "-arch", process.arch === "arm64" ? "arm64" : "x86_64"]
  : ["-fPIC", "-shared"];

const buildToolPath = fileURLToPath(import.meta.url);

if (isCheckMode) {
  try {
    accessSync(outputPath, constants.R_OK);
    accessSync(manifestPath, constants.R_OK);
  } catch {
    fail(`Committed artifact or manifest missing for ${artifact}.`);
  }
  const existingManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const currentSourceSha256 = sha256(sourcePath);
  const currentBuildToolSha256 = sha256(buildToolPath);
  if (existingManifest.nativeSourceSha256 !== currentSourceSha256) {
    fail(`Committed manifest nativeSourceSha256 (${existingManifest.nativeSourceSha256}) does not match current source (${currentSourceSha256}).`);
  }
  if (existingManifest.buildToolSha256 !== currentBuildToolSha256) {
    fail(`Committed manifest buildToolSha256 (${existingManifest.buildToolSha256}) does not match current build tool (${currentBuildToolSha256}).`);
  }

  const relativeOutputPath = relative(repositoryRoot, outputPath);
  let trackedBlobSha256 = undefined;
  if (checkTracked) {
    try {
      const gitShow = spawnSync("git", ["show", `HEAD:${relativeOutputPath}`], {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (gitShow.status !== 0 || gitShow.stdout.length === 0) {
        fail(`Committed artifact ${relativeOutputPath} is not tracked in git HEAD.`);
      }
      trackedBlobSha256 = createHash("sha256").update(gitShow.stdout).digest("hex");
    } catch {
      fail(`Unable to inspect git HEAD for ${relativeOutputPath}.`);
    }
  }

  const checkTempDir = mkdtempSync(join(tmpdir(), "tfsb-build-check-"));
  const tempOutputPath = join(checkTempDir, "native-addon-posix-openat-v1.node");
  try {
    const checkArgs = [...common, ...platformFlags, "-o", tempOutputPath, sourcePath];
    command(compiler, checkArgs);
    const freshSha256 = sha256(tempOutputPath);
    const committedSha256 = sha256(outputPath);
    if (freshSha256 !== committedSha256) {
      fail(`Fresh build SHA-256 (${freshSha256}) does not match committed artifact SHA-256 (${committedSha256}).`);
    }
    if (committedSha256 !== existingManifest.artifactSha256) {
      fail(`Committed artifact SHA-256 (${committedSha256}) does not match manifest artifactSha256 (${existingManifest.artifactSha256}).`);
    }
    if (checkTracked && trackedBlobSha256 !== undefined) {
      if (trackedBlobSha256 !== committedSha256) {
        fail(`Git-tracked artifact SHA-256 (${trackedBlobSha256}) does not match committed working file (${committedSha256}).`);
      }
      if (trackedBlobSha256 !== freshSha256) {
        fail(`Git-tracked artifact SHA-256 (${trackedBlobSha256}) does not match fresh rebuild (${freshSha256}).`);
      }
    }
    process.stdout.write(`${JSON.stringify({
      check: "passed",
      artifact,
      artifactSha256: committedSha256,
      nativeSourceSha256: currentSourceSha256,
      buildToolSha256: currentBuildToolSha256,
      trackedInGit: trackedBlobSha256 !== undefined,
    }, null, 2)}\n`);
  } finally {
    rmSync(checkTempDir, { recursive: true, force: true });
  }
} else {
  mkdirSync(outputDirectory, { recursive: true });
  const args = [...common, ...platformFlags, "-o", outputPath, sourcePath];
  command(compiler, args);

  const compilerVersion = command(compiler, ["--version"], { capture: true }).split("\n")[0] ?? "unknown";
  const repositoryCommit = command("git", ["rev-parse", "HEAD"], { capture: true });
  const repositoryTree = command("git", ["rev-parse", "HEAD^{tree}"], { capture: true });
  const stat = statSync(outputPath);
  const normalizedCommand = [
    compiler,
    ...common.map((value) => value.startsWith("-I") ? "-I<NODE_INCLUDE>" : value),
    ...platformFlags,
    "-o",
    `<${artifact}>/native-addon-posix-openat-v1.node`,
    relative(repositoryRoot, sourcePath),
  ];
  const manifest = {
    schemaVersion: 1,
    backend: "native-addon-posix-openat-v1",
    abiVersion: 1,
    artifact,
    platform: process.platform,
    architecture: process.arch,
    libc: process.platform === "linux" ? "glibc" : null,
    nodeVersion: process.version,
    nodeApiVersion: process.versions.napi,
    compiler: compilerVersion,
    command: normalizedCommand,
    qualificationSourceCommit: repositoryCommit,
    qualificationSourceTree: repositoryTree,
    nativeSource: relative(repositoryRoot, sourcePath),
    nativeSourceSha256: sha256(sourcePath),
    buildTool: relative(repositoryRoot, buildToolPath),
    buildToolSha256: sha256(buildToolPath),
    artifactSha256: sha256(outputPath),
    artifactBytes: stat.size,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`${JSON.stringify({ artifact, output: relative(repositoryRoot, outputPath), manifest }, null, 2)}\n`);
}
