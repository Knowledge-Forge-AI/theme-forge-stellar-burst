#!/usr/bin/env node
// @ts-check
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const knownArtifacts = new Set(["darwin-arm64", "darwin-x64", "linux-x64-gnu", "linux-arm64-gnu"]);
const backend = "native-addon-posix-openat-v1";
/** @param {string} path */
export function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

/** Select only executing GNU Linux or Darwin targets. @param {string} platform @param {string} arch @param {unknown} glibc */
export function selectArtifact(platform, arch, glibc) {
  if (!["arm64", "x64"].includes(arch)) return undefined;
  if (platform === "darwin") return `darwin-${arch}`;
  if (platform === "linux" && typeof glibc === "string" && glibc.length > 0) return `linux-${arch}-gnu`;
  return undefined;
}
export function hostArtifact() {
  const report = /** @type {{header?: {glibcVersionRuntime?: unknown}}} */ (process.report?.getReport());
  return selectArtifact(process.platform, process.arch, report?.header?.glibcVersionRuntime);
}

/** Historical manifests retain their actual producer; never rewrite them as rebuilt.
 * @param {string} root @param {string} digest
 */
export function recognizedBuildTool(root, digest) {
  if (digest === sha256(join(root, "tools/build-directory-snapshot-native.mjs"))) return "current";
  const legacy = "a885da47c77aebbb18772f71b65e56888fea9a2453efd62a57bcc31319e36c91";
  if (digest === legacy && sha256(join(root, "native/directory-snapshot/build-tools/v1.mjs")) === legacy) return "historical-v1";
  const explicitProducer = "1dd3b18f2c8ad0e8e74e039ddb0cfa48457ae821796ebf432670b0522c767ee0";
  if (digest === explicitProducer && sha256(join(root, "native/directory-snapshot/build-tools/v2.mjs")) === explicitProducer) return "historical-v2";
  throw new Error("Unrecognized native build-tool provenance");
}

/** @param {string[]} argv */
export function parseArguments(argv) {
  /** @type {Record<string, string | boolean>} */
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === undefined) throw new Error("Missing argument");
    if (["--check", "--check-tracked", "--source-build", "--require-reproducible"].includes(key)) result[key] = true;
    else if (["--artifact", "--compiler", "--node-include", "--output"].includes(key)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
      result[key] = value;
    } else throw new Error(`Unknown argument: ${key}`);
  }
  if (result["--require-reproducible"] && !result["--check"]) throw new Error("--require-reproducible requires --check");
  return result;
}

/** @param {string} command @param {string[]} args @param {string} cwd */
function execute(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Native command failed: ${basename(command)}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

/** Hash the complete declared header tree with paths, independently of checkout location.
 * @param {string} root
 */
function headerIdentity(root) {
  const hash = createHash("sha256");
  /** @param {string} dir */
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() || (entry.isSymbolicLink() && statSync(path).isFile())) hash.update(relative(root, path)).update("\0").update(readFileSync(path)).update("\0");
      else throw new Error("Node headers must contain only regular files and directories");
    }
  }
  visit(root);
  return hash.digest("hex");
}

/** One producer for release and Nix; source-build requires declared inputs and no Git.
 * @param {string[]} [argv] @param {string} [root]
 */
export function buildNative(argv = process.argv.slice(2), root = repositoryRoot) {
  const options = parseArguments(argv);
  const artifact = String(options["--artifact"] ?? hostArtifact() ?? "");
  if (!knownArtifacts.has(artifact) || artifact !== hostArtifact()) throw new Error("Native artifacts require the exact executing platform and architecture");
  const sourceBuild = options["--source-build"] === true;
  if (sourceBuild && (!["--compiler", "--node-include", "--output"].every(key => typeof options[key] === "string"))) {
    throw new Error("Source builds require explicit --compiler, --node-include and --output");
  }
  const compiler = String(options["--compiler"] ?? process.env.CC ?? "cc");
  if (sourceBuild && !isAbsolute(compiler)) throw new Error("Source-build compiler must be absolute");
  const prefix = process.config.variables.node_prefix;
  const candidates = [resolve(dirname(process.execPath), "../include/node")];
  if (typeof prefix === "string") candidates.unshift(resolve(prefix, "include/node"));
  const include = typeof options["--node-include"] === "string" ? options["--node-include"] : candidates.find(path => {
    try { accessSync(join(path, "node_api.h"), constants.R_OK); return true; } catch { return false; }
  });
  if (!include || !isAbsolute(include)) throw new Error("Explicit readable absolute Node header directory required");
  for (const header of ["node_api.h", "js_native_api.h", "node_version.h"]) accessSync(join(include, header), constants.R_OK);
  const version = readFileSync(join(include, "node_version.h"), "utf8");
  const major = version.match(/#define NODE_MAJOR_VERSION\s+(\d+)/)?.[1];
  if (major !== process.versions.node.split(".")[0]) throw new Error("Node headers and executing runtime major version differ");
  const source = join(root, "native/directory-snapshot/src/directory_snapshot.c");
  const tool = join(root, "tools/build-directory-snapshot-native.mjs");
  const output = resolve(root, String(options["--output"] ?? `native/directory-snapshot/prebuilds/${artifact}`));
  const binary = join(output, `${backend}.node`);
  const manifestPath = join(output, "manifest.json");
  const flags = ["-O2", "-Wall", "-Wextra", "-Werror", "-std=c11", `-I${include}`,
    ...(process.platform === "darwin" ? ["-bundle", "-undefined", "dynamic_lookup", "-arch", process.arch === "arm64" ? "arm64" : "x86_64"] : ["-fPIC", "-shared"])];
  if (options["--check"]) {
    const retained = JSON.parse(readFileSync(manifestPath, "utf8"));
    const provenance = recognizedBuildTool(root, retained.buildToolSha256);
    if (retained.artifact !== artifact || retained.backend !== backend || retained.abiVersion !== 1 || retained.architecture !== process.arch
      || retained.platform !== process.platform || retained.libc !== (process.platform === "linux" ? "glibc" : null) || retained.nativeSourceSha256 !== sha256(source)
      || retained.artifactSha256 !== sha256(binary) || retained.artifactBytes !== statSync(binary).size) throw new Error("Retained artifact integrity mismatch");
    if (options["--check-tracked"]) {
      const tracked = spawnSync("git", ["show", `HEAD:${relative(root, binary)}`], { cwd: root, maxBuffer: 1024 * 1024 });
      if (tracked.status !== 0 || createHash("sha256").update(tracked.stdout).digest("hex") !== sha256(binary)) throw new Error("Git-tracked artifact differs");
    }
    // Explicit producer identities delimit exact rebuild claims. Legacy manifests
    // without those identities retain their unconditional byte-equality check.
    if (retained.sourceIdentity?.explicitToolchain === true) {
      if (![retained.compilerExecutableSha256, retained.nodeHeadersSha256].every(value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value))) {
        throw new Error("Explicit toolchain identity is incomplete");
      }
      const compilerPath = isAbsolute(compiler) ? compiler : (process.env.PATH ?? "").split(":").map(path => resolve(path, compiler)).find(path => {
        try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
      });
      if (!compilerPath) throw new Error("Checking compiler executable unavailable");
      const matchingToolchain = retained.compilerExecutableSha256 === sha256(compilerPath)
        && retained.nodeHeadersSha256 === headerIdentity(include)
        && retained.compiler === execute(compiler, ["--version"], root).split("\n")[0]
        && retained.nodeVersion === process.version && retained.nodeApiVersion === process.versions.napi;
      if (!matchingToolchain && options["--require-reproducible"]) throw new Error("Exact reproducibility required but checking toolchain differs from explicit producer");
      if (!matchingToolchain) return { check: "passed", integrity: "passed", artifact, provenance, artifactSha256: sha256(binary),
        reproducibility: "not-applicable", reason: "Checking compiler, Node runtime or header identity differs from explicit producer; exact rebuild unrun" };
    }
    const temp = mkdtempSync(join(tmpdir(), "tfsb-native-check-"));
    try {
      const fresh = join(temp, `${backend}.node`);
      execute(compiler, [...flags, "-o", fresh, source], root);
      if (sha256(fresh) !== sha256(binary)) throw new Error("Fresh build differs from retained artifact; qualify supported reproducibility separately");
      return { check: "passed", integrity: "passed", artifact, provenance, artifactSha256: sha256(binary), reproducibility: "passed" };
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  mkdirSync(output, { recursive: true });
  execute(compiler, [...flags, "-o", binary, source], root);
  const manifest = {
    schemaVersion: 1, backend, abiVersion: 1, artifact, platform: process.platform, architecture: process.arch,
    libc: process.platform === "linux" ? "glibc" : null,
    nodeVersion: process.version, nodeApiVersion: process.versions.napi,
    nodeHeadersSha256: headerIdentity(include),
    compiler: execute(compiler, ["--version"], root).split("\n")[0],
    compilerExecutableSha256: isAbsolute(compiler) ? sha256(compiler) : null,
    command: [basename(compiler), ...flags.map(value => value.startsWith("-I") ? "-I<NODE_INCLUDE>" : value), "-o", `<${artifact}>/${backend}.node`, relative(root, source)],
    sourceIdentity: { kind: "source-files", gitRequired: false, explicitToolchain: sourceBuild },
    nativeSource: relative(root, source), nativeSourceSha256: sha256(source),
    buildTool: relative(root, tool), buildToolSha256: sha256(tool),
    artifactSha256: sha256(binary), artifactBytes: statSync(binary).size,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(buildNative(), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
