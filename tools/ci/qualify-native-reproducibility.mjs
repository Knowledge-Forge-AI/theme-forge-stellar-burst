#!/usr/bin/env node
// @ts-check

import { appendFileSync, accessSync, constants, cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = join(repositoryRoot, "native/directory-snapshot/src/directory_snapshot.c");
const buildToolPath = join(repositoryRoot, "tools/build-directory-snapshot-native.mjs");
const loaderPath = join(repositoryRoot, "dist/directory-snapshot-native.js");
const knownArtifacts = new Set(["darwin-arm64", "darwin-x64", "linux-x64-gnu"]);
const nativeBackend = "native-addon-posix-openat-v1";
const nativeAbi = 1;
const nativeTests = [
  "test/directory-snapshot-native.test.ts",
  "test/directory-snapshot-native-primitives.test.ts",
  "test/directory-snapshot-native-cleanup.test.ts",
  "test/directory-snapshot-loader.test.ts",
  "test/directory-snapshot-race.test.ts",
];

/** @param {string} artifact */
function expectedDarwinDeploymentTarget(artifact) {
  if (artifact === "darwin-arm64") return "13.0";
  if (artifact === "darwin-x64") return "15.0";
  return null;
}

/** @param {string} path */
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** @param {string} value */
function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} path */
function regularFile(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`);
  return info;
}

/** @param {string} value */
function firstLine(value) {
  return value.trim().split(/\r?\n/u)[0] ?? "";
}

/** @param {string} path */
function portablePath(path) {
  const home = process.env.HOME ?? "";
  const portable = path.replaceAll(repositoryRoot, "<repo>");
  return home ? portable.replaceAll(home, "<home>") : portable;
}

/** @param {string} value */
function versionParts(value) {
  const parts = String(value).split(".").map((part) => Number(part));
  return parts.every(Number.isFinite) ? parts : [];
}

/** @param {string | null} value @param {string} maximum */
function exceedsVersion(value, maximum) {
  if (value === null) return true;
  const left = versionParts(value), right = versionParts(maximum);
  if (left.length === 0 || right.length === 0) return true;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index] ?? 0, rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) return leftPart > rightPart;
  }
  return false;
}

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, allowFailure?: boolean, inherit?: boolean }} [options]
 */
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env,
    encoding: options.inherit ? undefined : "utf8",
    stdio: options.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`Unable to execute ${executable}: ${result.error.message}`);
  const output = { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  if (!options.allowFailure && result.status !== 0) {
    const detail = firstLine(output.stderr) || firstLine(output.stdout) || `status ${result.status ?? "unknown"}`;
    throw new Error(`${executable} ${args.join(" ")} failed: ${detail}`);
  }
  return output;
}

/** @param {string} name */
function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

/** @param {string} path */
function gitBlobSha256(path) {
  const relativePath = relative(repositoryRoot, path);
  const listed = run("git", ["ls-files", "--error-unmatch", relativePath], { allowFailure: true });
  if (listed.status !== 0 || listed.stdout.trim() !== relativePath) throw new Error(`Required native file is not tracked in HEAD: ${relativePath}`);
  const shown = spawnSync("git", ["show", `HEAD:${relativePath}`], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
  if (shown.error || shown.status !== 0 || !Buffer.isBuffer(shown.stdout)) throw new Error(`Unable to read tracked native file from HEAD: ${relativePath}`);
  return createHash("sha256").update(shown.stdout).digest("hex");
}

/** @returns {string} */
function hostArtifact() {
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) return `darwin-${process.arch}`;
  if (process.platform === "linux" && process.arch === "x64") {
    /** @type {{header?: {glibcVersionRuntime?: unknown}} | undefined} */
    const report = process.report?.getReport();
    if (typeof report?.header?.glibcVersionRuntime === "string" && report.header.glibcVersionRuntime.length > 0) return "linux-x64-gnu";
  }
  return "none";
}

/** @returns {string} */
function findNodeInclude() {
  const nodePrefix = process.config.variables.node_prefix;
  const candidates = [resolve(dirname(process.execPath), "../include/node")];
  if (typeof nodePrefix === "string") candidates.unshift(resolve(nodePrefix, "include/node"));
  const includePath = [...new Set(candidates)].find((candidate) => {
    try {
      accessSync(join(candidate, "node_api.h"), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!includePath) throw new Error("Unable to locate node_api.h from the active Node installation.");
  return includePath;
}

/** @param {string} root */
function headerTreeIdentity(root) {
  /** @type {Array<{path: string, kind: string, bytes?: number, sha256?: string, target?: string}>} */
  const entries = [];
  /** @param {string} directory @param {string} prefix */
  function visit(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
      const fullPath = join(directory, entry.name);
      const entryPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const info = lstatSync(fullPath);
      if (info.isSymbolicLink()) entries.push({ path: entryPath, kind: "symlink", target: readlinkSync(fullPath) });
      else if (info.isDirectory()) visit(fullPath, entryPath);
      else if (info.isFile()) entries.push({ path: entryPath, kind: "file", bytes: info.size, sha256: sha256(fullPath) });
      else throw new Error(`Unsupported Node header entry: ${entryPath}`);
    }
  }
  visit(root, "");
  const digest = createHash("sha256");
  let bytes = 0;
  for (const entry of entries) {
    bytes += entry.bytes ?? 0;
    digest.update(`${entry.kind}\0${entry.path}\0${entry.bytes ?? ""}\0${entry.sha256 ?? entry.target ?? ""}\n`);
  }
  return { relativePath: "include/node", treeSha256: digest.digest("hex"), files: entries.length, bytes, nodeApiSha256: sha256(join(root, "node_api.h")) };
}

/** @param {string} artifact @param {string} compiler */
function nativeFlags(artifact, compiler) {
  const common = ["-O2", "-Wall", "-Wextra", "-Werror", "-std=c11"];
  const platformFlags = process.platform === "darwin"
    ? ["-bundle", "-undefined", "dynamic_lookup", "-arch", process.arch === "arm64" ? "arm64" : "x86_64"]
    : ["-fPIC", "-shared"];
  return { common, platform: platformFlags, normalized: [compiler, ...common, "-I<NODE_INCLUDE>", ...platformFlags, "-o", `<${artifact}>/native-addon-posix-openat-v1.node`, "native/directory-snapshot/src/directory_snapshot.c"] };
}

/** @param {string} path */
function machODetails(path) {
  if (process.platform !== "darwin") return { applicable: false, minos: null, sdk: null };
  const loadCommands = run("otool", ["-l", path]).stdout;
  const minos = loadCommands.match(/\bminos\s+([0-9]+(?:\.[0-9]+){1,2})/u)?.[1]
    ?? loadCommands.match(/LC_VERSION_MIN_MACOSX[\s\S]{0,240}?\bversion\s+([0-9]+(?:\.[0-9]+){1,2})/u)?.[1]
    ?? null;
  const sdk = loadCommands.match(/\bsdk\s+([0-9]+(?:\.[0-9]+){1,2})/u)?.[1] ?? null;
  if (!minos) throw new Error(`Unable to read the Darwin minimum deployment target from ${path}.`);
  return { applicable: true, minos, sdk };
}

/** @param {string} command @param {string[]} args */
function optional(command, args) {
  const result = run(command, args, { allowFailure: true });
  return firstLine(result.stdout || result.stderr) || null;
}

/** @param {string} includePath @param {string} artifact @param {NodeJS.ProcessEnv} buildEnvironment */
function toolchainInputs(includePath, artifact, buildEnvironment) {
  const compiler = buildEnvironment.CC || "cc";
  const compilerVersion = run(compiler, ["--version"], { env: buildEnvironment }).stdout.trim();
  const sdkPath = process.platform === "darwin" ? optional("xcrun", ["--show-sdk-path"]) : null;
  const sdkVersion = process.platform === "darwin" ? optional("xcrun", ["--show-sdk-version"]) : null;
  const linkerPath = process.platform === "darwin" ? optional("xcrun", ["--find", "ld"]) : optional("which", ["ld"]);
  const linkerVersion = linkerPath ? optional(linkerPath, ["-v"]) : null;
  const sdkSettings = sdkPath ? join(sdkPath, "SDKSettings.plist") : null;
  return {
    platform: process.platform,
    architecture: process.arch,
    artifact,
    compiler: { command: basename(compiler), version: compilerVersion, firstLine: firstLine(compilerVersion) },
    node: { executable: basename(process.execPath), version: process.version, apiVersion: process.versions.napi, prefix: typeof process.config.variables.node_prefix === "string" ? basename(process.config.variables.node_prefix) : null },
    nodeHeaders: headerTreeIdentity(includePath),
    sdk: { applicable: process.platform === "darwin", path: sdkPath ? portablePath(sdkPath) : null, version: sdkVersion, settingsSha256: sdkSettings && existsSync(sdkSettings) ? sha256(sdkSettings) : null },
    deploymentTarget: { applicable: process.platform === "darwin", declared: expectedDarwinDeploymentTarget(artifact), environment: buildEnvironment.MACOSX_DEPLOYMENT_TARGET || null },
    linker: { path: linkerPath ? portablePath(linkerPath) : null, version: linkerVersion },
  };
}

/** @param {string} packageRoot */
function probeFreshLoader(packageRoot) {
  const probe = run(process.execPath, ["--input-type=module", "-e", `
    const { loadDirectorySnapshotNative } = await import("./dist/directory-snapshot-native.js");
    const loaded = loadDirectorySnapshotNative();
    if (!loaded.ok) throw new Error(JSON.stringify(loaded));
    const root = loaded.addon.openFilesystemRoot();
    const entries = loaded.addon.readDirectory(root);
    loaded.addon.closeHandle(root);
    process.stdout.write(JSON.stringify({ ok: true, artifact: loaded.artifact, entries: entries.length }));
  `], { cwd: packageRoot });
  const result = JSON.parse(probe.stdout);
  if (result.ok !== true) throw new Error("Fresh native artifact loader probe did not pass.");
  return result;
}

/** @param {string} outputPath @param {any} report */
function writeReport(outputPath, report) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

/** @param {string} key @param {string} value */
function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

/** @param {string} packageRoot @param {string} freshArtifact @param {string} freshManifest @param {NodeJS.ProcessEnv} buildEnvironment @param {string} artifact */
function runFreshCompatibility(packageRoot, freshArtifact, freshManifest, buildEnvironment, artifact) {
  const archive = join(dirname(packageRoot), "tracked-head.tar");
  run("git", ["archive", "--format=tar", `--output=${archive}`, "HEAD"]);
  mkdirSync(packageRoot, { recursive: true });
  run("tar", ["-xf", archive, "-C", packageRoot]);
  rmSync(archive, { force: true });
  rmSync(join(packageRoot, "dist"), { recursive: true, force: true });
  cpSync(join(repositoryRoot, "dist"), join(packageRoot, "dist"), { recursive: true });
  rmSync(join(packageRoot, "node_modules"), { recursive: true, force: true });
  symlinkSync(join(repositoryRoot, "node_modules"), join(packageRoot, "node_modules"), "dir");
  const artifactDirectory = join(packageRoot, "native/directory-snapshot/prebuilds", artifact);
  mkdirSync(artifactDirectory, { recursive: true });
  copyFileSync(freshArtifact, join(artifactDirectory, "native-addon-posix-openat-v1.node"));
  copyFileSync(freshManifest, join(artifactDirectory, "manifest.json"));
  run("npx", ["--no-install", "vitest", "run", ...nativeTests], { cwd: packageRoot, env: buildEnvironment, inherit: true });
  run("npm", ["run", "qualify:package"], { cwd: packageRoot, env: buildEnvironment, inherit: true });
  return { status: "pass", testFiles: nativeTests, packageQualification: "pass" };
}

/** @param {string} outputPath @param {{artifactPath: string, manifestPath: string, artifactSha256: string, artifactBytes: number}} record */
function preserveProposal(outputPath, record) {
  const directory = join(dirname(outputPath), "native-replacement-proposal");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  copyFileSync(record.artifactPath, join(directory, "native-addon-posix-openat-v1.node"));
  copyFileSync(record.manifestPath, join(directory, "manifest.json"));
  return { directory: "native-replacement-proposal", artifactSha256: record.artifactSha256, artifactBytes: record.artifactBytes, files: ["native-addon-posix-openat-v1.node", "manifest.json"] };
}

function main() {
  const outputPath = argument("--output");
  /** @type {any} */
  const report = { schema: "tfsb.native-reproducibility-report", schemaVersion: 2, status: "fail", freshBuilds: [], freshLoaderProbes: [] };
  let scratch;
  try {
    if (!outputPath) throw new Error("--output is required.");
    const artifact = argument("--artifact") ?? hostArtifact();
    report.artifact = artifact;
    if (!knownArtifacts.has(artifact) || artifact !== hostArtifact()) throw new Error(`Native artifact ${artifact} is not valid for this exact host (${hostArtifact()}).`);
    const target = expectedDarwinDeploymentTarget(artifact);
    const retainedDirectory = join(repositoryRoot, "native/directory-snapshot/prebuilds", artifact);
    const retainedArtifact = join(retainedDirectory, "native-addon-posix-openat-v1.node");
    const retainedManifestPath = join(retainedDirectory, "manifest.json");
    regularFile(retainedArtifact);
    regularFile(retainedManifestPath);
    const retainedManifest = JSON.parse(readFileSync(retainedManifestPath, "utf8"));
    const buildEnvironment = { ...process.env };
    if (process.platform === "darwin") buildEnvironment.MACOSX_DEPLOYMENT_TARGET = target ?? "";
    const includePath = findNodeInclude();
    const inputs = toolchainInputs(includePath, artifact, buildEnvironment);
    const flags = nativeFlags(artifact, buildEnvironment.CC || "cc");
    const sourceSha256 = sha256(sourcePath);
    const buildToolSha256 = sha256(buildToolPath);
    const retainedArtifactSha256 = sha256(retainedArtifact);
    const retainedManifestSha256 = sha256(retainedManifestPath);
    const retainedArtifactStat = statSync(retainedArtifact);
    const trackedArtifactSha256 = gitBlobSha256(retainedArtifact);
    const trackedManifestSha256 = gitBlobSha256(retainedManifestPath);
    const retainedMachO = machODetails(retainedArtifact);
    /** @type {string[]} */
    const fatalIntegrityErrors = [];
    /** @type {string[]} */
    const historicalDifferences = [];
    /** @param {string} message */
    const fatal = (message) => fatalIntegrityErrors.push(message);
    /** @param {string} message */
    const historical = (message) => historicalDifferences.push(message);
    if (retainedManifest.artifact !== artifact) fatal("manifest artifact tuple");
    if (retainedManifest.backend !== nativeBackend) fatal("manifest backend");
    if (retainedManifest.abiVersion !== nativeAbi) fatal("manifest ABI version");
    if (retainedManifest.platform !== process.platform) fatal("manifest platform");
    if (retainedManifest.architecture !== process.arch) fatal("manifest architecture");
    if (process.platform === "linux" && retainedManifest.libc !== "glibc") fatal("manifest libc");
    if (process.platform === "darwin" && retainedManifest.libc !== null) fatal("manifest Darwin libc");
    if (retainedManifest.nativeSource !== relative(repositoryRoot, sourcePath)) fatal("manifest native source path");
    if (retainedManifest.buildTool !== relative(repositoryRoot, buildToolPath)) fatal("manifest build tool path");
    if (retainedManifest.nativeSourceSha256 !== sourceSha256) fatal("native source digest");
    if (retainedManifest.buildToolSha256 !== buildToolSha256) fatal("native build-script digest");
    if (retainedManifest.artifactSha256 !== retainedArtifactSha256) fatal("manifest artifact digest");
    if (retainedManifest.artifactBytes !== retainedArtifactStat.size) fatal("manifest artifact size");
    if (trackedArtifactSha256 !== retainedArtifactSha256) fatal("tracked artifact digest");
    if (trackedManifestSha256 !== retainedManifestSha256) fatal("tracked manifest digest");
    if (process.platform === "darwin" && exceedsVersion(retainedMachO.minos, target ?? "0.0")) fatal(`retained Darwin minimum deployment target exceeds ${target}`);
    if (retainedManifest.nodeVersion !== process.version) historical("Node version differs from retained manifest");
    if (String(retainedManifest.nodeApiVersion) !== String(process.versions.napi)) historical("Node-API version differs from retained manifest");
    if (retainedManifest.compiler !== inputs.compiler.firstLine) historical("compiler identity differs from retained manifest");
    if (JSON.stringify(retainedManifest.command) !== JSON.stringify(flags.normalized)) historical("normalized compiler flags differ from retained manifest");
    if (process.platform === "darwin" && retainedMachO.minos !== target) historical(`retained minimum deployment target is ${retainedMachO.minos}; current supported build target is ${target}`);
    if (process.platform === "darwin" && retainedMachO.sdk !== null && inputs.sdk.version !== null && retainedMachO.sdk !== inputs.sdk.version) historical("Darwin SDK load-command identity differs from current SDK");
    const retainedInputIdentity = retainedManifest.qualificationInputs ?? retainedManifest.toolchainInputs ?? null;
    const currentInputReceipt = { schema: "tfsb.native-toolchain-input-receipt", schemaVersion: 1, artifact, sourceSha256, buildToolSha256, inputs, flags };
    const currentInputReceiptSha256 = hashText(JSON.stringify(currentInputReceipt));
    const completeHistoricalInputMatch = Boolean(retainedInputIdentity && JSON.stringify(retainedInputIdentity) === JSON.stringify(currentInputReceipt));
    report.retained = { artifactSha256: retainedArtifactSha256, artifactBytes: retainedArtifactStat.size, manifestSha256: retainedManifestSha256, trackedArtifactSha256, trackedManifestSha256, machO: retainedMachO };
    report.currentInputReceipt = { ...currentInputReceipt, sha256: currentInputReceiptSha256 };
    report.inputs = inputs;
    report.flags = flags;
    report.inputComparison = {
      historicalIdentity: retainedInputIdentity ? (completeHistoricalInputMatch ? "complete-match" : "complete-different") : "incomplete",
      completeHistoricalInputMatch,
      historicalDifferences,
      unboundHistoricalFields: retainedInputIdentity ? [] : ["SDK identity", "Node header tree", "linker identity", "deployment environment"],
      checkNativeEligible: false,
    };
    report.integrity = { fatalErrors: fatalIntegrityErrors, status: fatalIntegrityErrors.length === 0 ? "pass" : "fail" };
    setOutput("input-match", "false");
    scratch = mkdtempSync(join(tmpdir(), "tfsb-native-reproducibility-"));
    if (!existsSync(loaderPath)) throw new Error("dist/directory-snapshot-native.js is missing; build the package before fresh-loader qualification.");
    const buildRecords = [];
    for (const [index, label] of ["build-a", "build-b"].entries()) {
      const packageRoot = join(scratch, label);
      const outputDirectory = join(packageRoot, "native/directory-snapshot/prebuilds", artifact);
      mkdirSync(outputDirectory, { recursive: true });
      run("npm", ["run", "build:native", "--", "--artifact", artifact, "--output", outputDirectory], { env: buildEnvironment });
      const freshArtifact = join(outputDirectory, "native-addon-posix-openat-v1.node");
      const freshManifestPath = join(outputDirectory, "manifest.json");
      regularFile(freshArtifact);
      regularFile(freshManifestPath);
      const freshMachO = machODetails(freshArtifact);
      if (process.platform === "darwin" && freshMachO.minos !== target) throw new Error(`Fresh ${artifact} build ${index + 1} has minimum deployment target ${freshMachO.minos}; expected ${target}.`);
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      copyFileSync(loaderPath, join(packageRoot, "dist/directory-snapshot-native.js"));
      writeFileSync(join(packageRoot, "package.json"), '{"name":"tfsb-native-loader-probe","type":"module"}\n');
      const freshManifest = JSON.parse(readFileSync(freshManifestPath, "utf8"));
      const record = { run: index + 1, packageRoot, artifactPath: freshArtifact, manifestPath: freshManifestPath, artifactSha256: sha256(freshArtifact), artifactBytes: statSync(freshArtifact).size, manifest: freshManifest, machO: freshMachO, inputReceiptSha256: currentInputReceiptSha256 };
      buildRecords.push(record);
      report.freshBuilds.push({ run: record.run, artifactSha256: record.artifactSha256, artifactBytes: record.artifactBytes, manifest: freshManifest, machO: freshMachO, inputReceiptSha256: currentInputReceiptSha256 });
      report.freshLoaderProbes.push({ run: record.run, result: probeFreshLoader(packageRoot) });
    }
    if (buildRecords.length !== 2) throw new Error("Native reproducibility requires exactly two fresh builds.");
    const first = buildRecords[0];
    const second = buildRecords[1];
    if (!first || !second) throw new Error("Native reproducibility did not retain both fresh build records.");
    const freshBuildsEqual = first.artifactSha256 === second.artifactSha256 && first.artifactBytes === second.artifactBytes;
    report.freshBuildsEqual = freshBuildsEqual;
    if (!freshBuildsEqual) throw new Error("Two builds under the same complete current input receipt differ in bytes.");
    report.freshCompatibility = runFreshCompatibility(join(scratch, "fresh-compatibility"), first.artifactPath, first.manifestPath, buildEnvironment, artifact);
    const retainedBytesMatch = first.artifactSha256 === retainedArtifactSha256;
    report.inputComparison.checkNativeEligible = fatalIntegrityErrors.length === 0 && retainedBytesMatch && freshBuildsEqual;
    if (report.inputComparison.checkNativeEligible) setOutput("input-match", "true");
    const genuineReplacement = fatalIntegrityErrors.length > 0 || (completeHistoricalInputMatch && !retainedBytesMatch);
    if (genuineReplacement) {
      report.status = "replacement-required";
      report.replacement = { required: true, reason: fatalIntegrityErrors.length > 0 ? "retained native identity/support-floor integrity failed" : "same complete declared inputs produced bytes different from retained artifact", retained: report.retained, proposed: preserveProposal(outputPath, first) };
      writeReport(outputPath, report);
      process.stderr.write(`Native replacement required for ${artifact}; the retained proposal is in native-replacement-proposal/.\n`);
      process.exitCode = 1;
      return;
    }
    report.status = "pass";
    report.replacement = { required: false, retainedBytesMatch, reason: retainedBytesMatch ? "retained bytes match current reproducible build" : "retained bytes are qualified under a different declared toolchain; no cross-toolchain byte equality required" };
    report.compatibility = { fresh: "pass", retained: "existing native suites run after this helper", packed: "fresh qualify:package pass" };
    writeReport(outputPath, report);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    if (outputPath) writeReport(outputPath, report);
    process.stderr.write(`${report.error}\n`);
    process.exitCode = 1;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

main();
