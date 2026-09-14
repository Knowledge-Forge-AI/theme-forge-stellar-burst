#!/usr/bin/env node
// @ts-check

import { appendFileSync, accessSync, constants, cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, openSync, fstatSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractReleaseArchive } from "./artifact-manifest.mjs";

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
const selectedSourceExcludedDirectories = Object.freeze([".git", "node_modules", "dist"]);
const selectedSourceExcludedDirectorySet = new Set(selectedSourceExcludedDirectories);

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

/** @param {string} path */
function archiveRegularFile(path) {
  const absolute = resolve(path);
  const info = regularFile(absolute);
  let parent = dirname(absolute);
  while (true) {
    const parentInfo = lstatSync(parent);
    if (parentInfo.isSymbolicLink()) {
      const canonical = realpathSync(parent);
      const trustedAlias = (parent === "/var" && canonical === "/private/var") ||
        (parent === "/tmp" && canonical === "/private/tmp");
      if (!trustedAlias) throw new Error(`Selected source archive has a symlinked ancestor: ${absolute}`);
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return info;
}

/** @param {string | number | undefined} value */
function exactByteSize(value) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9][0-9]*)$/u.test(text)) throw new Error("Selected source archive byte-size must be a non-negative integer.");
  const bytes = Number(text);
  if (!Number.isSafeInteger(bytes)) throw new Error("Selected source archive byte-size is outside the safe integer range.");
  return bytes;
}

/**
 * Authenticate the archive identity before it is extracted. The archive path
 * and every ancestor must be non-symlinked (apart from Darwin's canonical
 * /var and /tmp aliases), and both the producer-declared digest and byte size
 * are required. Extraction performs a second descriptor-authenticated read.
 *
 * @param {{archivePath: string, sha256: string, bytes: string | number, manifestPath?: string, stripComponents?: number}} options
 */
function authenticateSelectedSourceArchive(options) {
  const archivePath = resolve(options.archivePath);
  const archiveInfo = archiveRegularFile(archivePath);
  const archiveBytes = exactByteSize(options.bytes);
  if (archiveInfo.size !== archiveBytes) throw new Error(`Selected source archive byte-size mismatch: expected ${archiveBytes}, observed ${archiveInfo.size}.`);
  if (!/^[a-f0-9]{64}$/u.test(options.sha256)) throw new Error("Selected source archive SHA-256 must be a lowercase 64-character hexadecimal digest.");
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
    throw new Error("Secure selected archive access is unavailable.");
  }
  const descriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let observedSha256;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== archiveBytes) throw new Error("Selected archive descriptor identity mismatch.");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("Selected archive changed while reading.");
    }
    observedSha256 = createHash("sha256").update(bytes).digest("hex");
  } finally {
    closeSync(descriptor);
  }
  if (observedSha256 !== options.sha256) throw new Error(`Selected source archive SHA-256 mismatch: expected ${options.sha256}, observed ${observedSha256}.`);
  if (options.manifestPath !== undefined) archiveRegularFile(resolve(options.manifestPath));
  const stripComponents = options.stripComponents ?? 0;
  if (![0, 1].includes(stripComponents)) throw new Error("Selected source archive supports only zero or one stripped prefix.");
  return { archivePath, archiveSha256: observedSha256, archiveBytes, stripComponents, manifestPath: options.manifestPath ? resolve(options.manifestPath) : null };
}

/**
 * Inventory a materialized source root without following source-member
 * symlinks. Generated checkout directories are listed explicitly and omitted
 * from the member inventory; no other source path is ignored.
 *
 * @param {string} root
 * @param {boolean} [allowGenerated]
 */
function sourceInventory(root, allowGenerated = true) {
  const absoluteRoot = resolve(root);
  const rootInfo = lstatSync(absoluteRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`Selected source root must be a regular directory: ${absoluteRoot}`);
  /** @type {Array<{path: string, bytes: number, mode: number, sha256: string}>} */
  const files = [];
  /** @type {string[]} */
  const excluded = [];
  /** @param {string} directory @param {string} prefix */
  function visit(directory, prefix) {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      if ((prefix === "" && selectedSourceExcludedDirectorySet.has(entry.name)) || entry.name === "node_modules") {
        if (!allowGenerated) throw new Error(`Selected archive contains generated checkout content: ${entry.name}`);
        excluded.push(prefix === "" ? entry.name : `${prefix}/${entry.name}`);
        continue;
      }
      const fullPath = join(directory, entry.name);
      const entryPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const info = lstatSync(fullPath);
      if (info.isSymbolicLink()) throw new Error(`Selected source contains a symlink member: ${entryPath}`);
      if (info.isDirectory()) visit(fullPath, entryPath);
      else if (info.isFile()) files.push({ path: entryPath, bytes: info.size, mode: info.mode & 0o777, sha256: sha256(fullPath) });
      else throw new Error(`Selected source contains a non-regular member: ${entryPath}`);
    }
  }
  visit(absoluteRoot, "");
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const digest = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    bytes += file.bytes;
    digest.update(`${file.path}\0${file.bytes}\0${file.mode.toString(8)}\0${file.sha256}\n`);
  }
  return { files, bytes, treeSha256: digest.digest("hex"), excluded };
}

/**
 * Compare every selected archive member with the current source root. Current
 * checkout-only files are reported but are not treated as selected inputs;
 * missing or changed selected members always fail closed.
 *
 * @param {string} selectedRoot
 * @param {string} currentRoot
 */
function compareSelectedSourceInventory(selectedRoot, currentRoot) {
  const selected = sourceInventory(selectedRoot, false);
  const current = sourceInventory(currentRoot);
  const currentByPath = new Map(current.files.map((file) => [file.path, file]));
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const changed = [];
  for (const file of selected.files) {
    const observed = currentByPath.get(file.path);
    if (!observed) missing.push(file.path);
    else if (observed.bytes !== file.bytes || observed.mode !== file.mode || observed.sha256 !== file.sha256) changed.push(file.path);
  }
  if (missing.length > 0 || changed.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing=${missing.slice(0, 8).join(",")}`);
    if (changed.length > 0) details.push(`changed=${changed.slice(0, 8).join(",")}`);
    throw new Error(`Selected source inventory mismatch: ${details.join(" ")}.`);
  }
  const selectedPaths = new Set(selected.files.map((file) => file.path));
  const currentOnly = current.files.filter((file) => !selectedPaths.has(file.path)).map((file) => file.path);
  return {
    selected: { files: selected.files, bytes: selected.bytes, treeSha256: selected.treeSha256, excluded: selected.excluded },
    current: { files: current.files, bytes: current.bytes, treeSha256: current.treeSha256, excluded: current.excluded },
    currentOnly,
  };
}

/** @param {string} root */
function compatibilityInputIdentity(root) {
  return nativeTests.map((testPath) => {
    const path = join(root, testPath);
    regularFile(path);
    const info = statSync(path);
    return { path: testPath, bytes: info.size, sha256: sha256(path) };
  });
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

/** @param {{root: string, archivePath: string, archiveSha256: string, archiveBytes: number, stripComponents: number, manifestPath: string | null}} context @param {string} destination */
async function extractSelectedSource(context, destination) {
  const identity = authenticateSelectedSourceArchive({
    archivePath: context.archivePath,
    sha256: context.archiveSha256,
    bytes: context.archiveBytes,
    ...(context.manifestPath ? { manifestPath: context.manifestPath } : {}),
    stripComponents: context.stripComponents,
  });
  await extractReleaseArchive({
    archivePath: identity.archivePath,
    destination,
    stripComponents: identity.stripComponents,
    expectedSha256: identity.archiveSha256,
    ...(identity.manifestPath ? { manifestPath: identity.manifestPath } : {}),
  });
  return identity;
}

/**
 * Build from an authenticated source archive without creating a Git checkout
 * or inventing commit/tree metadata. The selected build tool is authenticated
 * as an input and the compiler command remains the same contract as the
 * committed-HEAD build path.
 *
 * @param {string} packageRoot
 * @param {string} outputDirectory
 * @param {string} artifact
 * @param {NodeJS.ProcessEnv} buildEnvironment
 * @param {string} includePath
 * @param {{common: string[], platform: string[], normalized: string[]}} flags
 * @param {{sourcePath: string, buildToolPath: string, sourceRelative: string, buildToolRelative: string, archiveSha256: string, archiveBytes: number, stripComponents: number}} context
 */
function buildSelectedNative(packageRoot, outputDirectory, artifact, buildEnvironment, includePath, flags, context) {
  const compiler = buildEnvironment.CC || "cc";
  const sourceInPackage = join(packageRoot, context.sourceRelative);
  const outputPath = join(outputDirectory, "native-addon-posix-openat-v1.node");
  const args = [...flags.common, `-I${includePath}`, ...flags.platform, "-o", outputPath, sourceInPackage];
  run(compiler, args, { cwd: packageRoot, env: buildEnvironment });
  const compilerVersion = firstLine(run(compiler, ["--version"], { cwd: packageRoot, env: buildEnvironment }).stdout);
  const outputInfo = statSync(outputPath);
  const manifest = {
    schemaVersion: 1,
    backend: nativeBackend,
    abiVersion: nativeAbi,
    artifact,
    platform: process.platform,
    architecture: process.arch,
    libc: process.platform === "linux" ? "glibc" : null,
    nodeVersion: process.version,
    nodeApiVersion: process.versions.napi,
    compiler: compilerVersion,
    command: flags.normalized,
    qualificationSourceCommit: null,
    qualificationSourceTree: null,
    qualificationSourceArchive: { sha256: context.archiveSha256, bytes: context.archiveBytes, stripComponents: context.stripComponents },
    nativeSource: context.sourceRelative,
    nativeSourceSha256: sha256(context.sourcePath),
    buildTool: context.buildToolRelative,
    buildToolSha256: sha256(context.buildToolPath),
    artifactSha256: sha256(outputPath),
    artifactBytes: outputInfo.size,
  };
  writeFileSync(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  // Re-run the selected build tool's committed check against the generated
  // bytes. Check mode performs no Git lookup, so the selected archive remains
  // the sole source authority while the existing compiler contract is retained.
  run(process.execPath, [context.buildToolPath, "--check", "--artifact", artifact, "--output", outputDirectory], { cwd: packageRoot, env: buildEnvironment });
  return manifest;
}

/** @param {string} packageRoot @param {NodeJS.ProcessEnv} buildEnvironment */
function buildSelectedPackage(packageRoot, buildEnvironment) {
  const nodeModulesPath = join(packageRoot, "node_modules");
  rmSync(nodeModulesPath, { recursive: true, force: true });
  symlinkSync(join(repositoryRoot, "node_modules"), nodeModulesPath, "dir");
  run("npm", ["run", "build"], { cwd: packageRoot, env: buildEnvironment });
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

/** @param {string} packageRoot @param {string} freshArtifact @param {string} freshManifest @param {NodeJS.ProcessEnv} buildEnvironment @param {string} artifact @param {{root: string, archivePath: string, archiveSha256: string, archiveBytes: number, stripComponents: number, manifestPath: string | null} | null} [selectedContext] */
async function runFreshCompatibility(packageRoot, freshArtifact, freshManifest, buildEnvironment, artifact, selectedContext = null) {
  if (selectedContext) {
    await extractSelectedSource(selectedContext, packageRoot);
    buildSelectedPackage(packageRoot, buildEnvironment);
  } else {
    const archive = join(dirname(packageRoot), "tracked-head.tar");
    run("git", ["archive", "--format=tar", `--output=${archive}`, "HEAD"]);
    mkdirSync(packageRoot, { recursive: true });
    run("tar", ["-xf", archive, "-C", packageRoot]);
    rmSync(archive, { force: true });
    rmSync(join(packageRoot, "dist"), { recursive: true, force: true });
    cpSync(join(repositoryRoot, "dist"), join(packageRoot, "dist"), { recursive: true });
    rmSync(join(packageRoot, "node_modules"), { recursive: true, force: true });
    symlinkSync(join(repositoryRoot, "node_modules"), join(packageRoot, "node_modules"), "dir");
  }
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

async function main() {
  const outputPath = argument("--output");
  /** @type {any} */
  const report = { schema: "tfsb.native-reproducibility-report", schemaVersion: 2, status: "fail", freshBuilds: [], freshLoaderProbes: [] };
  let scratch;
  /** @type {{root: string, archivePath: string, archiveSha256: string, archiveBytes: number, stripComponents: number, manifestPath: string | null} | null} */
  let selectedContext = null;
  /** @type {Array<{path: string, bytes: number, sha256: string}> | null} */
  let selectedCompatibilityInputs = null;
  try {
    if (!outputPath) throw new Error("--output is required.");
    const artifact = argument("--artifact") ?? hostArtifact();
    report.artifact = artifact;
    if (!knownArtifacts.has(artifact) || artifact !== hostArtifact()) throw new Error(`Native artifact ${artifact} is not valid for this exact host (${hostArtifact()}).`);
    const target = expectedDarwinDeploymentTarget(artifact);
    const selectedArchivePath = argument("--selected-source-archive");
    const selectedArchiveSha256 = argument("--selected-source-sha256");
    const selectedArchiveBytes = argument("--selected-source-bytes");
    const selectedArchiveManifest = argument("--selected-source-manifest");
    const selectedArchiveStrip = argument("--selected-source-strip-components");
    const selectedMode = [selectedArchivePath, selectedArchiveSha256, selectedArchiveBytes, selectedArchiveManifest, selectedArchiveStrip].some((value) => value !== undefined);
    if (selectedMode && (!selectedArchivePath || !selectedArchiveSha256 || selectedArchiveBytes === undefined)) {
      throw new Error("Selected source mode requires --selected-source-archive, --selected-source-sha256, and --selected-source-bytes.");
    }
    let selectedStripComponents = 0;
    if (selectedArchiveStrip !== undefined) {
      if (!/^[01]$/u.test(selectedArchiveStrip)) throw new Error("--selected-source-strip-components must be 0 or 1.");
      selectedStripComponents = Number(selectedArchiveStrip);
    }
    report.sourceAuthority = { mode: selectedMode ? "authenticated-selected-source-archive" : "committed-head", excludedDirectories: selectedSourceExcludedDirectories };
    scratch = mkdtempSync(join(tmpdir(), "tfsb-native-reproducibility-"));
    const nativeSourceRelative = relative(repositoryRoot, sourcePath);
    const buildToolRelative = relative(repositoryRoot, buildToolPath);
    let sourceRoot = repositoryRoot;
    let qualifiedSourcePath = sourcePath;
    let qualifiedBuildToolPath = buildToolPath;
    if (selectedMode) {
      if (!selectedArchivePath || !selectedArchiveSha256 || selectedArchiveBytes === undefined) {
        throw new Error("Selected source archive identity is incomplete.");
      }
      const identity = authenticateSelectedSourceArchive({ archivePath: selectedArchivePath, sha256: selectedArchiveSha256, bytes: selectedArchiveBytes, ...(selectedArchiveManifest ? { manifestPath: selectedArchiveManifest } : {}), stripComponents: selectedStripComponents });
      const selectedRoot = join(scratch, "selected-source");
      await extractReleaseArchive({ archivePath: identity.archivePath, destination: selectedRoot, stripComponents: identity.stripComponents, expectedSha256: identity.archiveSha256, ...(identity.manifestPath ? { manifestPath: identity.manifestPath } : {}) });
      const inventory = compareSelectedSourceInventory(selectedRoot, repositoryRoot);
      sourceRoot = selectedRoot;
      qualifiedSourcePath = join(selectedRoot, nativeSourceRelative);
      qualifiedBuildToolPath = join(selectedRoot, buildToolRelative);
      regularFile(qualifiedSourcePath);
      regularFile(qualifiedBuildToolPath);
      selectedContext = { root: selectedRoot, ...identity };
      selectedCompatibilityInputs = compatibilityInputIdentity(selectedRoot);
      report.sourceAuthority = { ...report.sourceAuthority, archive: { path: portablePath(identity.archivePath), sha256: identity.archiveSha256, bytes: identity.archiveBytes, stripComponents: identity.stripComponents, manifestPath: identity.manifestPath ? portablePath(identity.manifestPath) : null }, inventory, compatibilityInputs: selectedCompatibilityInputs };
    }
    const retainedDirectory = join(sourceRoot, "native/directory-snapshot/prebuilds", artifact);
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
    const sourceSha256 = sha256(qualifiedSourcePath);
    const buildToolSha256 = sha256(qualifiedBuildToolPath);
    const retainedArtifactSha256 = sha256(retainedArtifact);
    const retainedManifestSha256 = sha256(retainedManifestPath);
    const retainedArtifactStat = statSync(retainedArtifact);
    const trackedArtifactSha256 = selectedMode ? null : gitBlobSha256(retainedArtifact);
    const trackedManifestSha256 = selectedMode ? null : gitBlobSha256(retainedManifestPath);
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
    if (retainedManifest.nativeSource !== nativeSourceRelative) fatal("manifest native source path");
    if (retainedManifest.buildTool !== buildToolRelative) fatal("manifest build tool path");
    if (retainedManifest.nativeSourceSha256 !== sourceSha256) fatal("native source digest");
    if (retainedManifest.buildToolSha256 !== buildToolSha256) fatal("native build-script digest");
    if (retainedManifest.artifactSha256 !== retainedArtifactSha256) fatal("manifest artifact digest");
    if (retainedManifest.artifactBytes !== retainedArtifactStat.size) fatal("manifest artifact size");
    if (trackedArtifactSha256 !== null && trackedArtifactSha256 !== retainedArtifactSha256) fatal("tracked artifact digest");
    if (trackedManifestSha256 !== null && trackedManifestSha256 !== retainedManifestSha256) fatal("tracked manifest digest");
    if (process.platform === "darwin" && exceedsVersion(retainedMachO.minos, target ?? "0.0")) fatal(`retained Darwin minimum deployment target exceeds ${target}`);
    if (retainedManifest.nodeVersion !== process.version) historical("Node version differs from retained manifest");
    if (String(retainedManifest.nodeApiVersion) !== String(process.versions.napi)) historical("Node-API version differs from retained manifest");
    if (retainedManifest.compiler !== inputs.compiler.firstLine) historical("compiler identity differs from retained manifest");
    if (JSON.stringify(retainedManifest.command) !== JSON.stringify(flags.normalized)) historical("normalized compiler flags differ from retained manifest");
    if (process.platform === "darwin" && retainedMachO.minos !== target) historical(`retained minimum deployment target is ${retainedMachO.minos}; current supported build target is ${target}`);
    if (process.platform === "darwin" && retainedMachO.sdk !== null && inputs.sdk.version !== null && retainedMachO.sdk !== inputs.sdk.version) historical("Darwin SDK load-command identity differs from current SDK");
    const retainedInputIdentity = retainedManifest.qualificationInputs ?? retainedManifest.toolchainInputs ?? null;
    const currentInputReceipt = { schema: "tfsb.native-toolchain-input-receipt", schemaVersion: 1, artifact, sourceSha256, buildToolSha256, inputs, flags, ...(selectedContext ? { sourceArchive: { sha256: selectedContext.archiveSha256, bytes: selectedContext.archiveBytes, stripComponents: selectedContext.stripComponents, compatibilityInputs: selectedCompatibilityInputs } } : {}) };
    const currentInputReceiptSha256 = hashText(JSON.stringify(currentInputReceipt));
    const completeHistoricalInputMatch = Boolean(retainedInputIdentity && JSON.stringify(retainedInputIdentity) === JSON.stringify(currentInputReceipt));
    report.retained = { artifactSha256: retainedArtifactSha256, artifactBytes: retainedArtifactStat.size, manifestSha256: retainedManifestSha256, trackedArtifactSha256, trackedManifestSha256, machO: retainedMachO, source: selectedMode ? "selected-source-archive" : "committed-head" };
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
    if (!selectedMode && !existsSync(loaderPath)) throw new Error("dist/directory-snapshot-native.js is missing; build the package before fresh-loader qualification.");
    const buildRecords = [];
    for (const [index, label] of ["build-a", "build-b"].entries()) {
      const packageRoot = join(scratch, label);
      let outputDirectory;
      /** @type {any} */
      let freshManifest;
      if (selectedContext) {
        await extractSelectedSource(selectedContext, packageRoot);
        buildSelectedPackage(packageRoot, buildEnvironment);
        outputDirectory = join(packageRoot, "native/directory-snapshot/prebuilds", artifact);
        mkdirSync(outputDirectory, { recursive: true });
        freshManifest = buildSelectedNative(packageRoot, outputDirectory, artifact, buildEnvironment, includePath, flags, {
          sourcePath: join(packageRoot, nativeSourceRelative),
          buildToolPath: join(packageRoot, buildToolRelative),
          sourceRelative: nativeSourceRelative,
          buildToolRelative,
          archiveSha256: selectedContext.archiveSha256,
          archiveBytes: selectedContext.archiveBytes,
          stripComponents: selectedContext.stripComponents,
        });
      } else {
        outputDirectory = join(packageRoot, "native/directory-snapshot/prebuilds", artifact);
        mkdirSync(outputDirectory, { recursive: true });
        run("npm", ["run", "build:native", "--", "--artifact", artifact, "--output", outputDirectory], { env: buildEnvironment });
      }
      const freshArtifact = join(outputDirectory, "native-addon-posix-openat-v1.node");
      const freshManifestPath = join(outputDirectory, "manifest.json");
      regularFile(freshArtifact);
      regularFile(freshManifestPath);
      const freshMachO = machODetails(freshArtifact);
      if (process.platform === "darwin" && freshMachO.minos !== target) throw new Error(`Fresh ${artifact} build ${index + 1} has minimum deployment target ${freshMachO.minos}; expected ${target}.`);
      if (!selectedContext) {
        mkdirSync(join(packageRoot, "dist"), { recursive: true });
        copyFileSync(loaderPath, join(packageRoot, "dist/directory-snapshot-native.js"));
      }
      writeFileSync(join(packageRoot, "package.json"), '{"name":"tfsb-native-loader-probe","type":"module"}\n');
      if (!freshManifest) freshManifest = JSON.parse(readFileSync(freshManifestPath, "utf8"));
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
    report.freshCompatibility = await runFreshCompatibility(join(scratch, "fresh-compatibility"), first.artifactPath, first.manifestPath, buildEnvironment, artifact, selectedContext);
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

const invokedDirectly = process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (invokedDirectly) await main();

export {
  authenticateSelectedSourceArchive,
  compareSelectedSourceInventory,
  exactByteSize,
  sourceInventory,
};
