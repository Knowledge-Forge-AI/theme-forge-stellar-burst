#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "tfsb.burst-helper-manifest-v1";
export const SCHEMA_VERSION = 1;
export const DIRECTORY_SNAPSHOT_BACKEND = "native-addon-posix-openat-v1";
export const DIRECTORY_SNAPSHOT_BACKEND_ABI = 1;
export const SERVICE_ENTRYPOINT = "dist/service-protocol/server-cli.js";
export const CLI_ENTRYPOINT = "dist/cli.js";
export const SERVICE_NAME = "tfsb-studio-service";
export const PACKAGE_NAME = "@knowledge-forge-ai/theme-forge-stellar-burst";
export const NODE_ENGINE_REQUIREMENT = ">=22";
export const RUNTIME_KIND = "node-service-helper-v1";

export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_AGGREGATE_BYTES = 1024 * 1024 * 1024;
export const MAX_FILES = 10_000;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_PATH_BYTES = 512;

/** @type {Readonly<Record<string, string>>} */
export const TARGET_MAP = Object.freeze({
  "aarch64-darwin": "darwin-arm64",
  "aarch64-linux": "linux-arm64-gnu",
  "x86_64-linux": "linux-x64-gnu",
  "x86_64-darwin": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "linux-arm64-gnu": "linux-arm64-gnu",
  "linux-x64-gnu": "linux-x64-gnu",
  "darwin-x64": "darwin-x64",
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
});

export const SUPPORTED_TARGETS = Object.freeze(Object.keys(TARGET_MAP));

/** @type {Readonly<Record<string, string>>} */
export const CANONICAL_TARGET_FOR_ARTIFACT = Object.freeze({
  "darwin-arm64": "aarch64-darwin",
  "linux-arm64-gnu": "aarch64-linux",
  "linux-x64-gnu": "x86_64-linux",
  "darwin-x64": "x86_64-darwin",
});

/** @type {readonly ["1.0", "1.1", "1.2"]} */
export const REQUIRED_PROTOCOL_VERSIONS = Object.freeze(["1.0", "1.1", "1.2"]);

/** @type {Readonly<Record<string, { inventory: string; requests: string; results: string }>>} */
export const PROTOCOL_FILES_BY_VERSION = Object.freeze({
  "1.0": {
    inventory: "protocol/tfsb-studio-v1/inventory.json",
    requests: "protocol/tfsb-studio-v1/requests.schema.json",
    results: "protocol/tfsb-studio-v1/results.schema.json",
  },
  "1.1": {
    inventory: "protocol/tfsb-studio-v1/inventory-1.1.json",
    requests: "protocol/tfsb-studio-v1/requests-1.1.schema.json",
    results: "protocol/tfsb-studio-v1/results-1.1.schema.json",
  },
  "1.2": {
    inventory: "protocol/tfsb-studio-v1/inventory-1.2.json",
    requests: "protocol/tfsb-studio-v1/requests-1.2.schema.json",
    results: "protocol/tfsb-studio-v1/results-1.2.schema.json",
  },
});

/** @type {readonly string[]} */
export const COMMON_PROTOCOL_FILES = Object.freeze([
  "protocol/tfsb-studio-v1/envelope.schema.json",
  "protocol/tfsb-studio-v1/README.md",
]);

// --- JSDoc Types ---

/**
 * @typedef {Object} ManifestPackageDescriptor
 * @property {string} name
 * @property {string} version
 * @property {string} packageJsonSha256
 */

/**
 * @typedef {Object} ManifestServiceDescriptor
 * @property {string} name
 * @property {string} entrypoint
 * @property {string} cliEntrypoint
 * @property {string} sha256
 * @property {number} size
 * @property {number} mode
 */

/**
 * @typedef {Object} ManifestNativeDescriptor
 * @property {string} backend
 * @property {number} abi
 * @property {string} artifact
 * @property {string} path
 * @property {string} sha256
 * @property {number} size
 * @property {number} mode
 * @property {string} manifestPath
 * @property {string} manifestSha256
 */

/**
 * @typedef {Object} NodeRuntimeDescriptor
 * @property {string} [nodePath]
 * @property {string} [version]
 * @property {string} [v8]
 * @property {string} [target]
 * @property {boolean} [allowPathFallback]
 * @property {boolean} [usePathFallback]
 */

/**
 * @typedef {Object} RuntimeValidateOptions
 * @property {boolean} [usePathFallback]
 */

/**
 * @typedef {Object} VerifiedRuntimeBinding
 * @property {string} engine
 * @property {string} runtimeKind
 * @property {string} [nodePath]
 * @property {string} [sha256]
 * @property {number} [size]
 * @property {number} [mode]
 * @property {string} [version]
 * @property {string} [v8]
 * @property {string} [target]
 */

/**
 * @typedef {Object} ManifestFileEntry
 * @property {number} mode
 * @property {string} path
 * @property {string} sha256
 * @property {number} size
 */

/**
 * @typedef {Object} ManifestTotals
 * @property {number} bytes
 * @property {number} fileCount
 * @property {string} inventoryDigest
 */

/**
 * @typedef {Object} ProtocolVersionSchemas
 * @property {string} inventorySha256
 * @property {string} requestsSha256
 * @property {string} resultsSha256
 */

/**
 * @typedef {Object} BurstHelperManifest
 * @property {string} schema
 * @property {number} schemaVersion
 * @property {string} target
 * @property {string} targetArtifact
 * @property {ManifestPackageDescriptor} package
 * @property {ManifestServiceDescriptor} service
 * @property {ManifestNativeDescriptor} native
 * @property {VerifiedRuntimeBinding} runtime
 * @property {Record<string, unknown> & { name: string; supportedVersions: string[] }} protocol
 * @property {ManifestFileEntry[]} files
 * @property {ManifestTotals} totals
 * @property {string} manifestDigest
 */

/**
 * @typedef {Object} VerifiedHandoffPackage
 * @property {string} name
 * @property {string} version
 * @property {string} root
 */

/**
 * @typedef {Object} VerifiedHandoffService
 * @property {string} name
 * @property {string} entrypointPath
 * @property {string} cliPath
 * @property {string} sha256
 * @property {number} size
 * @property {number} mode
 */

/**
 * @typedef {Object} VerifiedHandoffNative
 * @property {string} backend
 * @property {number} abi
 * @property {string} artifact
 * @property {string} addonPath
 * @property {string} manifestPath
 * @property {string} sha256
 * @property {number} size
 * @property {number} mode
 */

/**
 * @typedef {Object} VerifiedHandoffProtocol
 * @property {string} name
 * @property {string[]} supportedVersions
 * @property {string} protocolDir
 */

/**
 * @typedef {Object} VerifiedHelperHandoff
 * @property {true} ok
 * @property {string} manifestDigest
 * @property {string} target
 * @property {string} targetArtifact
 * @property {VerifiedHandoffPackage} package
 * @property {VerifiedHandoffService} service
 * @property {VerifiedHandoffNative} native
 * @property {VerifiedRuntimeBinding} runtime
 * @property {VerifiedHandoffProtocol} protocol
 * @property {ManifestTotals} totals
 * @property {ManifestFileEntry[]} files
 * @property {number} verifiedFileCount
 */

/**
 * @typedef {Object} ProduceOptions
 * @property {string} packageRoot
 * @property {string} target
 * @property {string | NodeRuntimeDescriptor | undefined} [runtime]
 * @property {string | boolean | undefined} [writeTo]
 */

/**
 * @typedef {Object} ValidateOptions
 * @property {string} packageRoot
 * @property {string} target
 * @property {string} expectedManifestDigest
 * @property {string | NodeRuntimeDescriptor | undefined} [runtime]
 * @property {string | undefined} [manifestPath]
 * @property {string | Record<string, unknown> | undefined} [manifest]
 */

// --- Error Classes ---

export class HelperManifestError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = "HELPER_MANIFEST_ERROR") {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class TrustAnchorError extends HelperManifestError {
  /** @param {string} message */
  constructor(message) {
    super(message, "TRUST_ANCHOR_REQUIRED");
  }
}

export class ManifestDigestMismatchError extends HelperManifestError {
  /** @param {string} message */
  constructor(message) {
    super(message, "MANIFEST_DIGEST_MISMATCH");
  }
}

export class ForeignTargetError extends HelperManifestError {
  /** @param {string} message */
  constructor(message) {
    super(message, "FOREIGN_TARGET");
  }
}

export class IncompleteResourceError extends HelperManifestError {
  /** @param {string} message */
  constructor(message) {
    super(message, "INCOMPLETE_RESOURCE");
  }
}

export class TamperedResourceError extends HelperManifestError {
  /** @param {string} message */
  constructor(message) {
    super(message, "TAMPERED_RESOURCE");
  }
}

export class PathSecurityError extends HelperManifestError {
  /** @param {string} message */
  constructor(message) {
    super(message, "PATH_SECURITY_VIOLATION");
  }
}

export class RuntimeSecurityError extends HelperManifestError {
  /** @param {string} message */
  constructor(message) {
    super(message, "RUNTIME_SECURITY_VIOLATION");
  }
}

export class AddonCompatibilityError extends HelperManifestError {
  /** @param {string} message */
  constructor(message) {
    super(message, "ADDON_COMPATIBILITY_ERROR");
  }
}

// --- Helper Functions ---

/**
 * @param {unknown} err
 * @returns {string}
 */
function getErrorMessage(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

// --- Utility Functions ---

/**
 * Serializes a value to canonical JSON string (deterministic object key order).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === undefined) throw new Error("canonical JSON cannot encode undefined");
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * @param {Uint8Array|Buffer|string} bytes
 * @returns {string}
 */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * @param {Record<string, unknown>} manifestWithoutDigest
 * @returns {string}
 */
export function computeManifestDigest(manifestWithoutDigest) {
  const { manifestDigest: _discard, ...unsigned } = manifestWithoutDigest;
  return sha256(Buffer.from(canonicalJson(unsigned)));
}

/**
 * @param {string} target
 * @returns {string}
 */
export function resolveTargetArtifact(target) {
  if (typeof target !== "string" || !target.trim()) {
    throw new ForeignTargetError("Target must be a non-empty string");
  }
  const normalized = target.trim().toLowerCase();
  const artifact = TARGET_MAP[normalized];
  if (!artifact) {
    throw new ForeignTargetError(`Foreign or unsupported target: "${target}". Expected aarch64-darwin, aarch64-linux, x86_64-linux, or darwin-x64.`);
  }
  return artifact;
}

/**
 * @param {string} relPath
 * @returns {string}
 */
export function normalizeRelativePath(relPath) {
  if (typeof relPath !== "string") {
    throw new PathSecurityError("Relative path must be a string");
  }
  const normalized = relPath.split(sep).join("/").normalize("NFC");
  if (!normalized || Buffer.byteLength(normalized) > MAX_PATH_BYTES) {
    throw new PathSecurityError(`Path is empty or exceeds maximum byte limit: "${relPath}"`);
  }
  if (normalized.startsWith("/") || normalized.includes("\\")) {
    throw new PathSecurityError(`Path must be relative and POSIX-style: "${relPath}"`);
  }
  const components = normalized.split("/");
  for (const component of components) {
    if (!component || component === "." || component === ".." || !/^[A-Za-z0-9._@+-]+$/.test(component)) {
      throw new PathSecurityError(`Path contains unsafe or traversal component: "${relPath}"`);
    }
  }
  return normalized;
}

/**
 * @param {string} packageRoot
 * @param {string} relativePath
 * @returns {Promise<string>}
 */
export async function assertWithinPackageRoot(packageRoot, relativePath) {
  const normRel = normalizeRelativePath(relativePath);
  const resolvedRoot = resolve(packageRoot);
  const fullPath = resolve(resolvedRoot, normRel);

  if (!fullPath.startsWith(resolvedRoot + sep)) {
    throw new PathSecurityError(`Path "${relativePath}" traverses outside package root "${resolvedRoot}"`);
  }

  let current = resolvedRoot;
  for (const part of normRel.split("/")) {
    current = join(current, part);
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) {
        const real = await realpath(current);
        if (!real.startsWith(resolvedRoot + sep) && real !== resolvedRoot) {
          throw new PathSecurityError(`Symlink "${current}" points outside package root to "${real}"`);
        }
      }
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        // intermediate or non-existent path
      } else {
        throw err;
      }
    }
  }

  return fullPath;
}

/**
 * @param {string} fullPath
 * @param {number} [maxBytes]
 * @returns {Promise<{ bytes: Buffer; info: import("node:fs").Stats }>}
 */
export async function readRegularFile(fullPath, maxBytes = MAX_FILE_BYTES) {
  const infoBefore = await lstat(fullPath);
  if (infoBefore.isSymbolicLink() || !infoBefore.isFile()) {
    throw new PathSecurityError(`Input is not a regular file: ${fullPath}`);
  }
  if (infoBefore.size > maxBytes) {
    throw new PathSecurityError(`Input exceeds maximum byte limit: ${fullPath}`);
  }
  const handle = await open(fullPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const statOpened = await handle.stat();
    if (statOpened.size !== infoBefore.size || statOpened.ino !== infoBefore.ino) {
      throw new TamperedResourceError(`File modified concurrently before read: ${fullPath}`);
    }
    const bytes = await handle.readFile();
    const statAfter = await handle.stat();
    if (statAfter.size !== bytes.length || statAfter.size !== statOpened.size) {
      throw new TamperedResourceError(`File modified concurrently during read: ${fullPath}`);
    }
    return { bytes, info: statAfter };
  } finally {
    await handle.close();
  }
}

/**
 * @param {string | NodeRuntimeDescriptor | undefined} runtime
 * @param {RuntimeValidateOptions} [options]
 * @returns {VerifiedRuntimeBinding}
 */
export function validateNodeRuntime(runtime, options = {}) {
  if (!runtime) {
    return {
      engine: NODE_ENGINE_REQUIREMENT,
      runtimeKind: RUNTIME_KIND,
    };
  }

  /** @type {NodeRuntimeDescriptor} */
  const runtimeObj = typeof runtime === "string" ? { nodePath: runtime } : { ...runtime };

  if (options.usePathFallback || runtimeObj.allowPathFallback || runtimeObj.usePathFallback) {
    throw new RuntimeSecurityError("PATH fallback is strictly forbidden; runtime must be an exact path");
  }

  if (runtimeObj.nodePath !== undefined) {
    const nodePath = runtimeObj.nodePath;
    if (typeof nodePath !== "string" || !nodePath.trim()) {
      throw new RuntimeSecurityError("Node path must be a non-empty string");
    }
    if (!isAbsolute(nodePath) || !nodePath.includes(sep) || nodePath === "node") {
      throw new RuntimeSecurityError(`Node runtime must be an explicit absolute path without PATH fallback: "${nodePath}"`);
    }
    const resolvedPath = resolve(nodePath);
    if (!existsSync(resolvedPath)) {
      throw new RuntimeSecurityError(`Node binary not found at: "${resolvedPath}"`);
    }
    const st = statSync(resolvedPath);
    if (!st.isFile()) {
      throw new RuntimeSecurityError(`Node path is not a regular file: "${resolvedPath}"`);
    }
    if ((st.mode & 0o111) === 0) {
      throw new RuntimeSecurityError(`Node binary is not executable: "${resolvedPath}"`);
    }

    const nodeBytes = readFileSync(resolvedPath);
    const nodeSha256 = sha256(nodeBytes);
    const nodeSize = st.size;
    const nodeMode = st.mode & 0o777;

    return {
      engine: NODE_ENGINE_REQUIREMENT,
      runtimeKind: RUNTIME_KIND,
      nodePath: resolvedPath,
      sha256: nodeSha256,
      size: nodeSize,
      mode: nodeMode,
      ...(runtimeObj.version ? { version: runtimeObj.version } : {}),
      ...(runtimeObj.v8 ? { v8: runtimeObj.v8 } : {}),
      ...(runtimeObj.target ? { target: runtimeObj.target } : {}),
    };
  }

  return {
    engine: NODE_ENGINE_REQUIREMENT,
    runtimeKind: RUNTIME_KIND,
    ...(runtimeObj.version ? { version: runtimeObj.version } : {}),
  };
}

/**
 * @param {string} baseDir
 * @param {string} currentSubdir
 * @param {Map<string, ManifestFileEntry>} filesMap
 * @param {string} packageRoot
 * @returns {Promise<void>}
 */
async function collectDirectoryFiles(baseDir, currentSubdir, filesMap, packageRoot) {
  const currentDir = join(baseDir, currentSubdir);
  if (!existsSync(currentDir)) return;
  const entries = await readdir(currentDir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const relFromBase = currentSubdir ? `${currentSubdir}/${entry.name}` : entry.name;
    const fullPath = join(baseDir, relFromBase);

    if (entry.isSymbolicLink()) {
      const real = await realpath(fullPath);
      const resolvedRoot = resolve(packageRoot);
      if (!real.startsWith(resolvedRoot + sep) && real !== resolvedRoot) {
        throw new PathSecurityError(`Symlink "${fullPath}" escapes package root to "${real}"`);
      }
    }

    if (entry.isDirectory()) {
      await collectDirectoryFiles(baseDir, relFromBase, filesMap, packageRoot);
    } else if (entry.isFile()) {
      const pkgRel = normalizeRelativePath(relFromBase);
      if (pkgRel === "burst-helper-manifest.json" || pkgRel === "manifest.json") {
        continue;
      }
      const { bytes, info } = await readRegularFile(fullPath);
      filesMap.set(pkgRel, {
        mode: info.mode & 0o777,
        path: pkgRel,
        sha256: sha256(bytes),
        size: bytes.length,
      });
    } else {
      throw new PathSecurityError(`Special file encountered in package tree: ${fullPath}`);
    }
  }
}

/** Runtime dependencies must be inside an immutable handoff root, not resolved from PATH or a sibling install.
 * @param {Record<string, unknown>} pkg
 * @returns {string[]}
 */
function dependencyRoots(pkg) {
  if (pkg.dependencies === undefined) return [];
  if (!pkg.dependencies || typeof pkg.dependencies !== "object" || Array.isArray(pkg.dependencies)) throw new IncompleteResourceError("Invalid runtime dependency declaration");
  return Object.keys(pkg.dependencies).sort().map(name => normalizeRelativePath(`node_modules/${name}`));
}

// --- Producer ---

/**
 * Produces a canonical Burst helper manifest for an installed package root and target.
 *
 * @param {ProduceOptions} options
 * @returns {Promise<BurstHelperManifest>} Closed manifest object including manifestDigest
 */
export async function produceBurstHelperManifest({ packageRoot, target, runtime, writeTo = false }) {
  if (!packageRoot || typeof packageRoot !== "string") {
    throw new HelperManifestError("packageRoot must be a non-empty string path");
  }
  const resolvedRoot = resolve(packageRoot);
  if (!existsSync(resolvedRoot)) {
    throw new IncompleteResourceError(`Package root not found: ${resolvedRoot}`);
  }
  const rootStat = await lstat(resolvedRoot);
  if (!rootStat.isDirectory()) {
    throw new IncompleteResourceError(`Package root is not a directory: ${resolvedRoot}`);
  }

  const targetArtifact = resolveTargetArtifact(target);
  const canonicalTarget = CANONICAL_TARGET_FOR_ARTIFACT[targetArtifact] ?? target;

  // 1. Package.json identity
  const packageJsonPath = resolve(resolvedRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new IncompleteResourceError(`package.json missing from package root: ${packageJsonPath}`);
  }
  const { bytes: packageJsonBytes } = await readRegularFile(packageJsonPath, MAX_MANIFEST_BYTES);
  /** @type {Record<string, unknown>} */
  let pkgJson;
  try {
    pkgJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packageJsonBytes));
  } catch (err) {
    throw new IncompleteResourceError(`package.json is not valid JSON: ${getErrorMessage(err)}`);
  }
  const packageJsonSha256 = sha256(packageJsonBytes);

  // 2. Service Executables
  const serviceRel = SERVICE_ENTRYPOINT;
  const cliRel = CLI_ENTRYPOINT;
  const serviceFull = resolve(resolvedRoot, serviceRel);
  const cliFull = resolve(resolvedRoot, cliRel);

  if (!existsSync(serviceFull)) {
    throw new IncompleteResourceError(`Service entrypoint missing: ${serviceRel}`);
  }
  if (!existsSync(cliFull)) {
    throw new IncompleteResourceError(`CLI entrypoint missing: ${cliRel}`);
  }

  const { bytes: serviceBytes, info: serviceInfo } = await readRegularFile(serviceFull);
  const serviceSha256 = sha256(serviceBytes);
  const serviceSize = serviceBytes.length;
  const serviceMode = serviceInfo.mode & 0o777;

  // 3. Native Addon & Manifest for target artifact
  const nativeRel = `native/directory-snapshot/prebuilds/${targetArtifact}/native-addon-posix-openat-v1.node`;
  const nativeManifestRel = `native/directory-snapshot/prebuilds/${targetArtifact}/manifest.json`;
  const nativeFull = resolve(resolvedRoot, nativeRel);
  const nativeManifestFull = resolve(resolvedRoot, nativeManifestRel);

  if (!existsSync(nativeFull)) {
    throw new IncompleteResourceError(`Native addon binary missing for target artifact "${targetArtifact}": ${nativeRel}`);
  }
  if (!existsSync(nativeManifestFull)) {
    throw new IncompleteResourceError(`Native addon manifest missing for target artifact "${targetArtifact}": ${nativeManifestRel}`);
  }

  const { bytes: nativeBytes, info: nativeInfo } = await readRegularFile(nativeFull);
  const { bytes: nativeManifestBytes } = await readRegularFile(nativeManifestFull, MAX_MANIFEST_BYTES);

  const nativeSha256 = sha256(nativeBytes);
  const nativeSize = nativeBytes.length;
  const nativeMode = nativeInfo.mode & 0o777;
  const nativeManifestSha256 = sha256(nativeManifestBytes);

  /** @type {Record<string, unknown>} */
  let nativeManifest;
  try {
    nativeManifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(nativeManifestBytes));
  } catch (err) {
    throw new AddonCompatibilityError(`Native addon manifest is not valid JSON: ${getErrorMessage(err)}`);
  }

  if (nativeManifest.backend !== DIRECTORY_SNAPSHOT_BACKEND) {
    throw new AddonCompatibilityError(`Native addon manifest declares unexpected backend: ${nativeManifest.backend}`);
  }
  if (nativeManifest.abiVersion !== DIRECTORY_SNAPSHOT_BACKEND_ABI) {
    throw new AddonCompatibilityError(`Native addon manifest declares ABI ${nativeManifest.abiVersion}, expected ${DIRECTORY_SNAPSHOT_BACKEND_ABI}`);
  }
  if (nativeManifest.artifactSha256 !== nativeSha256 || nativeManifest.artifactBytes !== nativeSize) {
    throw new TamperedResourceError("Native addon binary does not match its prebuild manifest hash/size");
  }

  // 4. Protocol Files
  /** @type {Record<string, unknown> & { name: string; supportedVersions: string[] }} */
  const protocol = {
    name: "tfsb-studio-v1",
    supportedVersions: [...REQUIRED_PROTOCOL_VERSIONS],
  };

  for (const v of REQUIRED_PROTOCOL_VERSIONS) {
    const fileSpec = PROTOCOL_FILES_BY_VERSION[v];
    if (!fileSpec) continue;
    const invFull = resolve(resolvedRoot, fileSpec.inventory);
    const reqFull = resolve(resolvedRoot, fileSpec.requests);
    const resFull = resolve(resolvedRoot, fileSpec.results);

    if (!existsSync(invFull) || !existsSync(reqFull) || !existsSync(resFull)) {
      throw new IncompleteResourceError(`Required protocol ${v} schemas missing from ${resolvedRoot}`);
    }

    const { bytes: invBytes } = await readRegularFile(invFull, MAX_MANIFEST_BYTES);
    const { bytes: reqBytes } = await readRegularFile(reqFull, MAX_MANIFEST_BYTES);
    const { bytes: resBytes } = await readRegularFile(resFull, MAX_MANIFEST_BYTES);

    protocol[v] = {
      inventorySha256: sha256(invBytes),
      requestsSha256: sha256(reqBytes),
      resultsSha256: sha256(resBytes),
    };
  }

  for (const commonRel of COMMON_PROTOCOL_FILES) {
    const commonFull = resolve(resolvedRoot, commonRel);
    if (!existsSync(commonFull)) {
      throw new IncompleteResourceError(`Common protocol file missing: ${commonRel}`);
    }
  }

  // 5. Node Runtime Requirements
  const runtimeBinding = validateNodeRuntime(runtime);

  // 6. Complete Inventory Collection
  /** @type {Map<string, ManifestFileEntry>} */
  const filesMap = new Map();
  // package.json
  filesMap.set("package.json", {
    mode: (await lstat(packageJsonPath)).mode & 0o777,
    path: "package.json",
    sha256: packageJsonSha256,
    size: packageJsonBytes.length,
  });

  for (const dependency of dependencyRoots(pkgJson)) {
    const metadata = await assertWithinPackageRoot(resolvedRoot, `${dependency}/package.json`);
    if (!existsSync(metadata)) throw new IncompleteResourceError("Runtime dependency missing from helper root");
    await collectDirectoryFiles(resolvedRoot, dependency, filesMap, resolvedRoot);
  }
  // dist/
  await collectDirectoryFiles(resolvedRoot, "dist", filesMap, resolvedRoot);
  // protocol/tfsb-studio-v1
  await collectDirectoryFiles(resolvedRoot, "protocol", filesMap, resolvedRoot);
  // native/directory-snapshot/prebuilds/<targetArtifact>
  await collectDirectoryFiles(resolvedRoot, `native/directory-snapshot/prebuilds/${targetArtifact}`, filesMap, resolvedRoot);

  // Optional legal files if present
  for (const legal of ["NOTICE", "COMMERCIAL-LICENSE.md", "LICENSE"]) {
    const legalPath = resolve(resolvedRoot, legal);
    if (existsSync(legalPath)) {
      const { bytes, info } = await readRegularFile(legalPath);
      filesMap.set(legal, {
        mode: info.mode & 0o777,
        path: legal,
        sha256: sha256(bytes),
        size: bytes.length,
      });
    }
  }

  if (filesMap.size > MAX_FILES) {
    throw new HelperManifestError(`Package files exceed maximum file count (${MAX_FILES})`);
  }

  const files = Array.from(filesMap.values()).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  if (totalBytes > MAX_AGGREGATE_BYTES) {
    throw new HelperManifestError(`Package files exceed maximum aggregate bytes (${MAX_AGGREGATE_BYTES})`);
  }

  const inventoryDigest = sha256(Buffer.from(canonicalJson(files)));

  const pkgName = typeof pkgJson.name === "string" ? pkgJson.name : PACKAGE_NAME;
  const pkgVersion = typeof pkgJson.version === "string" ? pkgJson.version : "0.0.0";

  /** @type {Omit<BurstHelperManifest, "manifestDigest">} */
  const manifest = {
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    target: canonicalTarget,
    targetArtifact,
    package: {
      name: pkgName,
      version: pkgVersion,
      packageJsonSha256,
    },
    service: {
      name: SERVICE_NAME,
      entrypoint: serviceRel,
      cliEntrypoint: cliRel,
      sha256: serviceSha256,
      size: serviceSize,
      mode: serviceMode,
    },
    native: {
      backend: DIRECTORY_SNAPSHOT_BACKEND,
      abi: DIRECTORY_SNAPSHOT_BACKEND_ABI,
      artifact: targetArtifact,
      path: nativeRel,
      sha256: nativeSha256,
      size: nativeSize,
      mode: nativeMode,
      manifestPath: nativeManifestRel,
      manifestSha256: nativeManifestSha256,
    },
    runtime: runtimeBinding,
    protocol,
    files,
    totals: {
      bytes: totalBytes,
      fileCount: files.length,
      inventoryDigest,
    },
  };

  const manifestDigest = computeManifestDigest(manifest);
  /** @type {BurstHelperManifest} */
  const closedManifest = { ...manifest, manifestDigest };

  if (writeTo) {
    const outPath = typeof writeTo === "string" ? resolve(writeTo) : resolve(resolvedRoot, "burst-helper-manifest.json");
    await writeFile(outPath, `${canonicalJson(closedManifest)}\n`, { mode: 0o644 });
  }

  return closedManifest;
}

export const produceHelperManifest = produceBurstHelperManifest;

// --- Validator ---

/**
 * Validates an installed Burst helper package root against an externally authenticated expected manifest digest.
 *
 * Self-declared manifest is an inventory NOT a trust anchor.
 *
 * @param {ValidateOptions} options
 * @returns {Promise<VerifiedHelperHandoff>} Verified handoff descriptor with verified exact paths
 */
export async function validateBurstHelperManifest({
  packageRoot,
  target,
  expectedManifestDigest,
  runtime,
  manifestPath,
  manifest: providedManifest,
}) {
  // Trust anchor check: caller MUST provide expectedManifestDigest
  if (!expectedManifestDigest || typeof expectedManifestDigest !== "string" || !/^[0-9a-f]{64}$/i.test(expectedManifestDigest.trim())) {
    throw new TrustAnchorError(
      "Externally authenticated expectedManifestDigest is required; self-declared manifest is an inventory, not a trust anchor."
    );
  }
  const normalizedExpectedDigest = expectedManifestDigest.trim().toLowerCase();

  if (!packageRoot || typeof packageRoot !== "string") {
    throw new HelperManifestError("packageRoot must be a non-empty string path");
  }
  const resolvedRoot = resolve(packageRoot);
  if (!existsSync(resolvedRoot)) {
    throw new IncompleteResourceError(`Package root not found: ${resolvedRoot}`);
  }

  const targetArtifact = resolveTargetArtifact(target);

  // 1. Obtain manifest
  /** @type {BurstHelperManifest} */
  let manifest;
  let rawManifestString = null;
  if (providedManifest) {
    if (typeof providedManifest === "string") {
      rawManifestString = providedManifest;
      try {
        manifest = JSON.parse(rawManifestString);
      } catch (err) {
        throw new HelperManifestError(`Provided manifest is not valid JSON: ${getErrorMessage(err)}`);
      }
    } else if (typeof providedManifest === "object" && providedManifest !== null) {
      manifest = /** @type {BurstHelperManifest} */ (providedManifest);
    } else {
      throw new HelperManifestError("Provided manifest must be a JSON string or object");
    }
  } else {
    const targetManifestPath = manifestPath
      ? resolve(manifestPath)
      : (existsSync(resolve(resolvedRoot, "burst-helper-manifest.json"))
          ? resolve(resolvedRoot, "burst-helper-manifest.json")
          : resolve(resolvedRoot, "manifest.json"));

    if (!existsSync(targetManifestPath)) {
      throw new IncompleteResourceError(`Burst helper manifest not found at: ${targetManifestPath}`);
    }
    const { bytes } = await readRegularFile(targetManifestPath, MAX_MANIFEST_BYTES);
    rawManifestString = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    try {
      manifest = JSON.parse(rawManifestString);
    } catch (err) {
      throw new HelperManifestError(`Burst helper manifest is not valid JSON: ${getErrorMessage(err)}`);
    }
  }

  // 2. Validate external expected digest vs manifest
  if (!manifest.manifestDigest || typeof manifest.manifestDigest !== "string") {
    throw new TrustAnchorError("Manifest is missing manifestDigest");
  }
  if (manifest.manifestDigest.toLowerCase() !== normalizedExpectedDigest) {
    throw new ManifestDigestMismatchError(
      `Manifest digest "${manifest.manifestDigest}" does not match externally authenticated expected digest "${normalizedExpectedDigest}".`
    );
  }

  // 3. Verify internal self-digest of manifest
  const computedSelfDigest = computeManifestDigest(/** @type {Record<string, unknown>} */ (manifest));
  if (computedSelfDigest !== manifest.manifestDigest) {
    throw new TamperedResourceError(
      `Manifest self-digest is invalid (computed ${computedSelfDigest} != declared ${manifest.manifestDigest}). Content was tampered.`
    );
  }

  // 4. Validate schema and target
  if (manifest.schema !== SCHEMA || manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new HelperManifestError(`Invalid manifest schema "${manifest.schema}" version ${manifest.schemaVersion}`);
  }

  if (!manifest.target || typeof manifest.target !== "string") {
    throw new ForeignTargetError("Manifest target must be a non-empty string");
  }
  let manifestTargetArtifact;
  try {
    manifestTargetArtifact = resolveTargetArtifact(manifest.target);
  } catch {
    throw new ForeignTargetError(`Manifest target "${manifest.target}" is foreign or unsupported`);
  }

  if (manifest.targetArtifact !== targetArtifact || manifestTargetArtifact !== targetArtifact) {
    throw new ForeignTargetError(
      `Manifest target "${manifest.target}" (artifact: "${manifest.targetArtifact}") does not match requested target "${target}" (expected artifact: "${targetArtifact}"). Foreign target rejected.`
    );
  }

  if (!manifest.native || typeof manifest.native !== "object") {
    throw new IncompleteResourceError("Manifest native descriptor missing");
  }
  if (manifest.native.artifact !== targetArtifact) {
    throw new ForeignTargetError(
      `Manifest native artifact "${manifest.native.artifact}" does not match requested target artifact "${targetArtifact}".`
    );
  }

  // 5. Validate Native ABI and Backend
  if (manifest.native.abi !== DIRECTORY_SNAPSHOT_BACKEND_ABI) {
    throw new AddonCompatibilityError(
      `Manifest declares native addon ABI ${manifest.native.abi}, but ABI ${DIRECTORY_SNAPSHOT_BACKEND_ABI} is required.`
    );
  }
  if (manifest.native.backend !== DIRECTORY_SNAPSHOT_BACKEND) {
    throw new AddonCompatibilityError(
      `Manifest declares native backend "${manifest.native.backend}", expected "${DIRECTORY_SNAPSHOT_BACKEND}".`
    );
  }

  // 6. Validate runtime options
  const runtimeBinding = validateNodeRuntime(runtime);
  if (manifest.runtime) {
    if (runtimeBinding.sha256 && manifest.runtime.sha256) {
      if (runtimeBinding.sha256 !== manifest.runtime.sha256) {
        throw new TamperedResourceError("Supplied Node runtime executable does not match manifest runtime digest");
      }
    }
    if (runtimeBinding.version && manifest.runtime.version) {
      if (runtimeBinding.version !== manifest.runtime.version) {
        throw new TamperedResourceError("Supplied Node runtime version does not match manifest runtime version");
      }
    }
  }

  // 7. Verify declared inventory and authenticated required files
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new IncompleteResourceError("Manifest contains no inventory files");
  }

  /** @type {Map<string, ManifestFileEntry>} */
  const inventoryByPath = new Map();
  for (const fileEntry of manifest.files) {
    if (!fileEntry || typeof fileEntry !== "object" || typeof fileEntry.path !== "string") {
      throw new HelperManifestError("Invalid file entry in manifest inventory");
    }
    inventoryByPath.set(fileEntry.path, fileEntry);
  }

  // Cross-check 7a: package.json must be in declared inventory and match packageJsonSha256
  const pkgEntry = inventoryByPath.get("package.json");
  if (!pkgEntry) {
    throw new IncompleteResourceError("package.json is missing from declared inventory");
  }
  if (manifest.package?.packageJsonSha256 && pkgEntry.sha256 !== manifest.package.packageJsonSha256) {
    throw new TamperedResourceError("Declared package.json digest does not match manifest packageJsonSha256");
  }

  const installedPackage = /** @type {Record<string, unknown>} */ (JSON.parse(await readFile(join(resolvedRoot, "package.json"), "utf8")));
  /** @type {Map<string, ManifestFileEntry>} */
  const dependencies = new Map();
  for (const dependency of dependencyRoots(installedPackage)) {
    const metadata = await assertWithinPackageRoot(resolvedRoot, `${dependency}/package.json`);
    if (!existsSync(metadata)) throw new IncompleteResourceError("Runtime dependency missing from helper root");
    await collectDirectoryFiles(resolvedRoot, dependency, dependencies, resolvedRoot);
  }
  for (const [path, entry] of dependencies) {
    const declared = inventoryByPath.get(path);
    if (!declared || declared.sha256 !== entry.sha256 || declared.size !== entry.size || declared.mode !== entry.mode) throw new TamperedResourceError("Runtime dependency is missing or differs from authenticated inventory");
  }

  // Cross-check 7b: Service entrypoint must be in declared inventory and match service metadata
  if (!manifest.service || typeof manifest.service !== "object") {
    throw new IncompleteResourceError("Service descriptor missing in manifest");
  }
  const serviceEntry = inventoryByPath.get(manifest.service.entrypoint);
  if (!serviceEntry) {
    throw new IncompleteResourceError(`Service entrypoint "${manifest.service.entrypoint}" is missing from declared inventory`);
  }
  if (
    serviceEntry.sha256 !== manifest.service.sha256 ||
    serviceEntry.size !== manifest.service.size ||
    serviceEntry.mode !== manifest.service.mode
  ) {
    throw new TamperedResourceError("Declared service entrypoint metadata does not match manifest service metadata");
  }
  if ((serviceEntry.mode & 0o111) === 0) {
    throw new TamperedResourceError(`Service entrypoint is not executable: ${manifest.service.entrypoint}`);
  }

  // Cross-check 7c: CLI entrypoint must be in declared inventory and executable
  const cliEntry = inventoryByPath.get(manifest.service.cliEntrypoint);
  if (!cliEntry) {
    throw new IncompleteResourceError(`CLI entrypoint "${manifest.service.cliEntrypoint}" is missing from declared inventory`);
  }
  if ((cliEntry.mode & 0o111) === 0) {
    throw new TamperedResourceError(`CLI entrypoint is not executable: ${manifest.service.cliEntrypoint}`);
  }

  // Cross-check 7d: Native addon binary and manifest must be in declared inventory and match native metadata
  const nativeAddonEntry = inventoryByPath.get(manifest.native.path);
  if (!nativeAddonEntry) {
    throw new IncompleteResourceError(`Native addon binary "${manifest.native.path}" is missing from declared inventory`);
  }
  if (
    nativeAddonEntry.sha256 !== manifest.native.sha256 ||
    nativeAddonEntry.size !== manifest.native.size ||
    nativeAddonEntry.mode !== manifest.native.mode
  ) {
    throw new TamperedResourceError("Declared native addon metadata does not match manifest native metadata");
  }

  const nativeManifestEntry = inventoryByPath.get(manifest.native.manifestPath);
  if (!nativeManifestEntry) {
    throw new IncompleteResourceError(`Native prebuild manifest "${manifest.native.manifestPath}" is missing from declared inventory`);
  }
  if (nativeManifestEntry.sha256 !== manifest.native.manifestSha256) {
    throw new TamperedResourceError("Declared native manifest digest does not match manifest native.manifestSha256");
  }

  // Cross-check 7e: Protocol suite schemas for all required versions must be in declared inventory
  if (!manifest.protocol || typeof manifest.protocol !== "object") {
    throw new IncompleteResourceError("Protocol descriptor missing in manifest");
  }
  for (const v of REQUIRED_PROTOCOL_VERSIONS) {
    const fileSpec = PROTOCOL_FILES_BY_VERSION[v];
    if (!fileSpec) continue;
    const protoMeta = /** @type {Record<string, unknown>} */ (manifest.protocol)[v];
    if (!protoMeta || typeof protoMeta !== "object") {
      throw new IncompleteResourceError(`Protocol version ${v} metadata missing in manifest`);
    }
    const protoRecord = /** @type {ProtocolVersionSchemas} */ (protoMeta);

    const invFile = inventoryByPath.get(fileSpec.inventory);
    if (!invFile) {
      throw new IncompleteResourceError(`Protocol ${v} inventory "${fileSpec.inventory}" missing from declared inventory`);
    }
    if (invFile.sha256 !== protoRecord.inventorySha256) {
      throw new TamperedResourceError(`Protocol ${v} inventory digest does not match manifest protocol metadata`);
    }

    const reqFile = inventoryByPath.get(fileSpec.requests);
    if (!reqFile) {
      throw new IncompleteResourceError(`Protocol ${v} requests schema "${fileSpec.requests}" missing from declared inventory`);
    }
    if (reqFile.sha256 !== protoRecord.requestsSha256) {
      throw new TamperedResourceError(`Protocol ${v} requests schema digest does not match manifest protocol metadata`);
    }

    const resFile = inventoryByPath.get(fileSpec.results);
    if (!resFile) {
      throw new IncompleteResourceError(`Protocol ${v} results schema "${fileSpec.results}" missing from declared inventory`);
    }
    if (resFile.sha256 !== protoRecord.resultsSha256) {
      throw new TamperedResourceError(`Protocol ${v} results schema digest does not match manifest protocol metadata`);
    }
  }

  // Cross-check 7f: Common protocol files must be in declared inventory
  for (const commonRel of COMMON_PROTOCOL_FILES) {
    if (!inventoryByPath.has(commonRel)) {
      throw new IncompleteResourceError(`Common protocol file "${commonRel}" missing from declared inventory`);
    }
  }

  // 8. Verify all declared files on disk (Tampering, Traversal, Incomplete Resources)
  /** @type {ManifestFileEntry[]} */
  const verifiedFiles = [];
  let totalBytes = 0;

  for (const fileEntry of manifest.files) {
    const fullPath = await assertWithinPackageRoot(resolvedRoot, fileEntry.path);
    if (!existsSync(fullPath)) {
      throw new IncompleteResourceError(`Declared resource file missing on disk: ${fileEntry.path}`);
    }

    const { bytes, info } = await readRegularFile(fullPath);
    if (bytes.length !== fileEntry.size) {
      throw new TamperedResourceError(
        `File size mismatch for ${fileEntry.path}: expected ${fileEntry.size} bytes, got ${bytes.length} bytes.`
      );
    }
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== fileEntry.sha256) {
      throw new TamperedResourceError(
        `File digest mismatch for ${fileEntry.path}: expected ${fileEntry.sha256}, got ${actualSha256}.`
      );
    }
    if ((info.mode & 0o777) !== fileEntry.mode) {
      throw new TamperedResourceError(
        `File mode mismatch for ${fileEntry.path}: expected 0o${fileEntry.mode.toString(8)}, got 0o${(info.mode & 0o777).toString(8)}.`
      );
    }

    verifiedFiles.push({
      path: fileEntry.path,
      sha256: actualSha256,
      size: bytes.length,
      mode: info.mode & 0o777,
    });
    totalBytes += bytes.length;
  }

  // Check totals
  if (manifest.totals.fileCount !== verifiedFiles.length) {
    throw new TamperedResourceError(`Totals file count mismatch: declared ${manifest.totals.fileCount}, actual ${verifiedFiles.length}`);
  }
  if (manifest.totals.bytes !== totalBytes) {
    throw new TamperedResourceError(`Totals bytes mismatch: declared ${manifest.totals.bytes}, actual ${totalBytes}`);
  }
  const computedInventoryDigest = sha256(Buffer.from(canonicalJson(verifiedFiles)));
  if (manifest.totals.inventoryDigest !== computedInventoryDigest) {
    throw new TamperedResourceError(`Inventory digest mismatch: declared ${manifest.totals.inventoryDigest}, computed ${computedInventoryDigest}`);
  }

  // 9. Verify service executable specifically
  const serviceEntryPath = await assertWithinPackageRoot(resolvedRoot, manifest.service.entrypoint);
  const cliEntryPath = await assertWithinPackageRoot(resolvedRoot, manifest.service.cliEntrypoint);

  // 10. Verify native addon & prebuild manifest specifically
  const nativeAddonPath = await assertWithinPackageRoot(resolvedRoot, manifest.native.path);
  const nativeManifestPath = await assertWithinPackageRoot(resolvedRoot, manifest.native.manifestPath);

  const { bytes: nativeManifestBytes } = await readRegularFile(nativeManifestPath, MAX_MANIFEST_BYTES);
  /** @type {Record<string, unknown>} */
  let prebuildManifest;
  try {
    prebuildManifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(nativeManifestBytes));
  } catch (err) {
    throw new AddonCompatibilityError(`Prebuild native manifest is not valid JSON: ${getErrorMessage(err)}`);
  }
  if (prebuildManifest.abiVersion !== DIRECTORY_SNAPSHOT_BACKEND_ABI) {
    throw new AddonCompatibilityError(`Prebuild manifest has ABI ${prebuildManifest.abiVersion}, expected ${DIRECTORY_SNAPSHOT_BACKEND_ABI}`);
  }
  if (prebuildManifest.artifactSha256 !== manifest.native.sha256 || prebuildManifest.artifactBytes !== manifest.native.size) {
    throw new TamperedResourceError("Prebuild manifest does not match bound native addon hash/size");
  }

  // Return verified handoff descriptor
  return {
    ok: true,
    manifestDigest: manifest.manifestDigest,
    target: manifest.target,
    targetArtifact,
    package: {
      name: manifest.package.name,
      version: manifest.package.version,
      root: resolvedRoot,
    },
    service: {
      name: manifest.service.name,
      entrypointPath: serviceEntryPath,
      cliPath: cliEntryPath,
      sha256: manifest.service.sha256,
      size: manifest.service.size,
      mode: manifest.service.mode,
    },
    native: {
      backend: manifest.native.backend,
      abi: manifest.native.abi,
      artifact: manifest.native.artifact,
      addonPath: nativeAddonPath,
      manifestPath: nativeManifestPath,
      sha256: manifest.native.sha256,
      size: manifest.native.size,
      mode: manifest.native.mode,
    },
    runtime: manifest.runtime,
    protocol: {
      name: manifest.protocol.name,
      supportedVersions: manifest.protocol.supportedVersions,
      protocolDir: resolve(resolvedRoot, "protocol/tfsb-studio-v1"),
    },
    totals: manifest.totals,
    files: verifiedFiles,
    verifiedFileCount: verifiedFiles.length,
  };
}

export const validateHelperManifest = validateBurstHelperManifest;

// --- CLI Entrypoint ---

/**
 * @param {string[]} argv
 * @returns {{ produce: boolean; validate: boolean; options: Map<string, string | boolean> }}
 */
function parseCliArgs(argv) {
  const args = { produce: false, validate: false, options: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--produce") args.produce = true;
    else if (arg === "--validate") args.validate = true;
    else if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args.options.set(key, true);
      } else {
        args.options.set(key, next);
        i++;
      }
    }
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const parsed = parseCliArgs(process.argv.slice(2));
  const rawPackageRoot = parsed.options.get("package-root");
  const packageRoot = typeof rawPackageRoot === "string" ? rawPackageRoot : process.cwd();
  const rawTarget = parsed.options.get("target");
  const target = typeof rawTarget === "string" ? rawTarget : "aarch64-darwin";
  const rawNodePath = parsed.options.get("node");
  const nodePath = typeof rawNodePath === "string" ? rawNodePath : undefined;
  const rawExpectedDigest = parsed.options.get("expected-digest");
  const expectedDigest = typeof rawExpectedDigest === "string" ? rawExpectedDigest : undefined;
  const rawWrite = parsed.options.get("write") ?? parsed.options.get("output");
  const writeTo = (typeof rawWrite === "string" || typeof rawWrite === "boolean") ? rawWrite : false;

  try {
    if (parsed.produce) {
      /** @type {ProduceOptions} */
      const produceOpts = {
        packageRoot,
        target,
        writeTo,
      };
      if (nodePath) {
        produceOpts.runtime = { nodePath };
      }
      const manifest = await produceBurstHelperManifest(produceOpts);
      console.log(JSON.stringify(manifest, null, 2));
    } else if (parsed.validate) {
      if (!expectedDigest) {
        console.error("Error: --expected-digest is required for validation");
        process.exitCode = 1;
      } else {
        /** @type {ValidateOptions} */
        const validateOpts = {
          packageRoot,
          target,
          expectedManifestDigest: expectedDigest,
        };
        if (nodePath) {
          validateOpts.runtime = { nodePath };
        }
        const result = await validateBurstHelperManifest(validateOpts);
        console.log(JSON.stringify({ ok: true, manifestDigest: result.manifestDigest, targetArtifact: result.targetArtifact }, null, 2));
      }
    } else {
      console.log("Usage:");
      console.log("  node burst-helper-manifest.mjs --produce --package-root <path> --target <target> [--node <path>] [--write]");
      console.log("  node burst-helper-manifest.mjs --validate --package-root <path> --target <target> --expected-digest <sha256> [--node <path>]");
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    const code = (err && typeof err === "object" && "code" in err && typeof err.code === "string") ? err.code : "UNKNOWN";
    console.error(`Error: ${msg} (${code})`);
    process.exitCode = 1;
  }
}
