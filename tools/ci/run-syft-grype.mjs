// @ts-check
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  realpath,
  stat,
  writeFile
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(SCRIPT_DIR, "supply-chain-tools.json");
/** @type {Record<string, string[]>} */
const VERSION_ARGS = {
  syft: ["version"],
  grype: ["version"],
  actionlint: ["-version"],
  zizmor: ["--version"],
  betterleaks: ["--version"]
};
// These are existing Syft 1.51.1 catalogers. Keep the selection explicit on
// every format invocation so the release surface and every declared input can
// expose installed Node binaries, npm lock/packages, Rust lock metadata,
// auditable Rust binaries, and other classified executable binaries. Syft
// still owns discovery and emits no synthetic package records.
const SYFT_COMPONENT_CATALOGERS = [
  "binary-classifier-cataloger",
  "cargo-auditable-binary-cataloger",
  "javascript-lock-cataloger",
  "javascript-package-cataloger",
  "rust-cargo-lock-cataloger"
];
const SEVERITIES = ["critical", "high", "medium", "low", "negligible", "unknown"];

/**
 * Computes SHA-256 digest of bytes.
 * @param {Buffer | Uint8Array | string} bytes
 */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Returns normalized platform tuple ("darwin-arm64", "linux-amd64", etc.).
 */
export function hostPlatformTuple() {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch;
  return `${os}-${arch}`;
}

/**
 * @param {string} value
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * An executable release binary is not expected to consist solely of printable
 * text. This inexpensive preflight catches the reproduced cache fixture
 * before any network request is attempted. The archive comparison below is
 * still the authority for all non-obvious candidates.
 *
 * @param {Buffer} bytes
 */
function isClearlyText(bytes) {
  if (bytes.length === 0) return true;
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  return sample.every((byte) => byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e));
}

/**
 * @param {string} candidatePath
 * @param {{label: string, allowSymlink?: boolean}} options
 */
async function inspectBinaryCandidate(candidatePath, options) {
  let linkInfo;
  try {
    linkInfo = await lstat(candidatePath);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }

  if (linkInfo.isSymbolicLink() && !options.allowSymlink) {
    throw new Error(`[TOOL_BOOTSTRAP_FAIL] ${options.label} binary must not be a symlink: ${basename(candidatePath)}`);
  }

  const info = linkInfo.isSymbolicLink() ? await stat(candidatePath) : linkInfo;
  if (!info.isFile()) {
    throw new Error(`[TOOL_BOOTSTRAP_FAIL] ${options.label} binary is not a regular file: ${basename(candidatePath)}`);
  }
  if ((info.mode & 0o111) === 0) {
    throw new Error(`[TOOL_BOOTSTRAP_FAIL] ${options.label} binary is not executable: ${basename(candidatePath)}`);
  }

  const bytes = await readFile(candidatePath);
  if (isClearlyText(bytes)) {
    throw new Error(`[TOOL_BOOTSTRAP_FAIL] ${options.label} binary is an unauthenticated text file: ${basename(candidatePath)}`);
  }
  return {
    path: candidatePath,
    sha256: sha256Hex(bytes),
    bytes,
    symlink: linkInfo.isSymbolicLink()
  };
}

/**
 * @param {string} toolName
 * @param {string} toolsDir
 */
function cacheBinaryPath(toolName, toolsDir) {
  return join(resolve(toolsDir), "bin", toolName);
}

/**
 * @param {string} toolName
 */
function findPathBinary(toolName) {
  try {
    const output = execFileSync("which", [toolName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    const first = output.split(/\r?\n/u)[0]?.trim();
    return first ? resolve(first) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} archivePath
 * @param {{binary_path: string}} asset
 * @param {string} toolName
 */
async function extractPinnedBinary(archivePath, asset, toolName) {
  if (isAbsolute(asset.binary_path) || asset.binary_path.split(/[\\/]/u).includes("..")) {
    throw new Error(`[TOOL_BOOTSTRAP_FAIL] Unsafe binary path for ${toolName}: ${asset.binary_path}`);
  }

  const extractionDir = await mkdtemp(join(tmpdir(), `tfsb-${toolName}-`));
  try {
    execFileSync("tar", ["-xzf", archivePath, "-C", extractionDir, "--", asset.binary_path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const extractedPath = resolve(extractionDir, asset.binary_path);
    const extractedInfo = await lstat(extractedPath);
    if (extractedInfo.isSymbolicLink() || !extractedInfo.isFile()) {
      throw new Error(`[TOOL_BOOTSTRAP_FAIL] Pinned archive did not contain a regular ${toolName} binary.`);
    }
    if ((extractedInfo.mode & 0o111) === 0) {
      throw new Error(`[TOOL_BOOTSTRAP_FAIL] Pinned archive ${toolName} binary is not executable.`);
    }
    const bytes = await readFile(extractedPath);
    if (isClearlyText(bytes)) {
      throw new Error(`[TOOL_BOOTSTRAP_FAIL] Pinned archive ${toolName} binary is text, not an executable release binary.`);
    }
    return { bytes, sha256: sha256Hex(bytes) };
  } finally {
    await rm(extractionDir, { recursive: true, force: true });
  }
}

/**
 * @param {string} toolName
 * @param {string} binaryPath
 * @param {any} toolSpec
 */
export function measureToolVersion(toolName, binaryPath, toolSpec) {
  const args = Array.isArray(toolSpec.version_args) ? toolSpec.version_args : (VERSION_ARGS[toolName] ?? ["--version"]);
  let output;
  try {
    output = execFileSync(binaryPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    throw new Error(`[TOOL_BOOTSTRAP_FAIL] Could not execute ${toolName} for version authentication: ${error instanceof Error ? error.message : String(error)}`);
  }

  const expected = String(toolSpec.version ?? "");
  if (!expected || !new RegExp(`(?:^|\\D)${escapeRegExp(expected)}(?:$|\\D)`, "u").test(output)) {
    throw new Error(`[TOOL_BOOTSTRAP_FAIL] ${toolName} reported an unexpected version; expected ${expected}.`);
  }
  return { version: expected, args };
}

/**
 * @param {string} toolsDir
 * @param {string} archiveName
 * @param {string} expectedDigest
 * @param {string} url
 * @param {string} toolName
 */
async function ensureVerifiedArchive(toolsDir, archiveName, expectedDigest, url, toolName) {
  const archivePath = join(resolve(toolsDir), archiveName);
  let source = "cached-verified";
  let bytes;

  if (existsSync(archivePath)) {
    const archiveInfo = await lstat(archivePath);
    if (archiveInfo.isSymbolicLink() || !archiveInfo.isFile()) {
      throw new Error(`[TOOL_BOOTSTRAP_FAIL] Cached ${toolName} archive is not a regular file: ${archiveName}`);
    }
    bytes = await readFile(archivePath);
    const actualDigest = sha256Hex(bytes);
    if (actualDigest !== expectedDigest) {
      throw new Error(`[TOOL_BOOTSTRAP_FAIL] Cached archive integrity mismatch for ${archiveName}: expected ${expectedDigest}, got ${actualDigest}`);
    }
  } else {
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new Error(`[TOOL_BOOTSTRAP_FAIL] Failed to download ${toolName} archive: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new Error(`[TOOL_BOOTSTRAP_FAIL] Failed to download ${toolName} archive: ${response.status} ${response.statusText}`);
    }
    bytes = Buffer.from(await response.arrayBuffer());
    const actualDigest = sha256Hex(bytes);
    if (actualDigest !== expectedDigest) {
      throw new Error(`[TOOL_BOOTSTRAP_FAIL] Integrity mismatch for ${archiveName}: expected ${expectedDigest}, got ${actualDigest}`);
    }
    const downloadDir = await mkdtemp(join(resolve(toolsDir), ".download-"));
    const temporaryPath = join(downloadDir, archiveName);
    try {
      await writeFile(temporaryPath, bytes, { mode: 0o644 });
      await rename(temporaryPath, archivePath);
    } finally {
      await rm(downloadDir, { recursive: true, force: true });
    }
    source = "downloaded-verified";
  }

  return {
    path: archivePath,
    filename: archiveName,
    sha256: expectedDigest,
    source,
    url
  };
}

/**
 * Ensures a pinned release binary is present, authenticated, and executable.
 * The actual candidate (cache or PATH) is compared byte-for-byte with the
 * binary extracted from the verified platform archive before it is run.
 *
 * @param {string} toolName
 * @param {string} toolsDir
 */
export async function ensureToolWithProvenance(toolName, toolsDir) {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const toolSpec = manifest.tools?.[toolName];
  if (!toolSpec) throw new Error(`[TOOL_BOOTSTRAP_FAIL] Tool "${toolName}" not in manifest.`);

  const tuple = hostPlatformTuple();
  const asset = toolSpec.assets?.[tuple];
  if (!asset) throw new Error(`[TOOL_BOOTSTRAP_FAIL] Tool "${toolName}" has no asset for "${tuple}".`);

  const resolvedToolsDir = resolve(toolsDir);
  const binDir = join(resolvedToolsDir, "bin");
  await mkdir(binDir, { recursive: true });
  const targetBinPath = cacheBinaryPath(toolName, resolvedToolsDir);

  // Preflight local candidates before archive acquisition. This makes the
  // reproduced unauthenticated text cache fail closed without network access.
  let candidate = null;
  let source = "extracted-verified";
  if (existsSync(targetBinPath)) {
    candidate = await inspectBinaryCandidate(targetBinPath, { label: `Cached ${toolName}` });
    source = "cache-verified";
  } else {
    const pathCandidate = findPathBinary(toolName);
    if (pathCandidate) {
      candidate = await inspectBinaryCandidate(pathCandidate, { label: `PATH ${toolName}`, allowSymlink: true });
      source = "path-verified";
    }
  }

  const archive = await ensureVerifiedArchive(
    resolvedToolsDir,
    asset.archive,
    asset.sha256,
    asset.url,
    toolName
  );
  const pinnedBinary = await extractPinnedBinary(archive.path, asset, toolName);

  if (candidate && candidate.sha256 !== pinnedBinary.sha256) {
    throw new Error(`[TOOL_BOOTSTRAP_FAIL] ${source.replace("-verified", "")} ${toolName} binary does not match the authenticated ${asset.archive} payload.`);
  }

  let executablePath = candidate?.path;
  if (!executablePath) {
    await writeFile(targetBinPath, pinnedBinary.bytes, { mode: 0o755 });
    await chmod(targetBinPath, 0o755);
    executablePath = targetBinPath;
  }

  const executableInfo = await inspectBinaryCandidate(executablePath, { label: `${source} ${toolName}`, allowSymlink: source === "path-verified" });
  if (!executableInfo || executableInfo.sha256 !== pinnedBinary.sha256) {
    throw new Error(`[TOOL_BOOTSTRAP_FAIL] ${toolName} executable changed after authentication.`);
  }
  const measured = measureToolVersion(toolName, executablePath, toolSpec);

  return {
    path: executablePath,
    tool: toolName,
    platform: tuple,
    source,
    version: measured.version,
    versionArgs: measured.args,
    binarySha256: executableInfo.sha256,
    authenticatedBinarySha256: pinnedBinary.sha256,
    archive: {
      filename: archive.filename,
      sha256: archive.sha256,
      source: archive.source,
      url: archive.url,
      immutablePin: toolSpec.immutable_pin ?? null,
      integrity: toolSpec.integrity ?? null
    }
  };
}

/**
 * Ensures a tool binary is present and authenticated against supply-chain-tools.json.
 * @param {string} toolName
 * @param {string} toolsDir
 */
export async function ensureTool(toolName, toolsDir) {
  const provenance = await ensureToolWithProvenance(toolName, toolsDir);
  return provenance.path;
}

/**
 * @param {string} targetPath
 */
async function targetIdentity(targetPath) {
  const info = await lstat(targetPath);
  if (info.isSymbolicLink()) {
    throw new Error(`[SUPPLY_CHAIN_FAIL] Scan target must not be a symlink: ${basename(targetPath)}`);
  }
  if (info.isFile()) {
    const bytes = await readFile(targetPath);
    return { kind: "file", size: bytes.length, fileCount: 1, sha256: sha256Hex(bytes) };
  }
  if (!info.isDirectory()) {
    throw new Error(`[SUPPLY_CHAIN_FAIL] Scan target is not a file or directory: ${basename(targetPath)}`);
  }

  const hash = createHash("sha256");
  const targetRealpath = await realpath(targetPath);
  let size = 0;
  let fileCount = 0;
  /** @param {string} currentPath @param {string} relativePath */
  async function visit(currentPath, relativePath) {
    const entries = await readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childPath = join(currentPath, entry.name);
      const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const childInfo = await lstat(childPath);
      hash.update(`${childRelative}\0${childInfo.mode & 0o7777}\0`);
      if (childInfo.isDirectory()) {
        hash.update("d\0");
        await visit(childPath, childRelative);
      } else if (childInfo.isFile()) {
        const bytes = await readFile(childPath);
        size += bytes.length;
        fileCount += 1;
        hash.update("f\0");
        hash.update(bytes);
        hash.update("\0");
      } else if (childInfo.isSymbolicLink()) {
        const linkTarget = await readlink(childPath);
        if (isAbsolute(linkTarget)) {
          throw new Error(`[SUPPLY_CHAIN_FAIL] Scan-target symlink has an absolute destination: ${childRelative}`);
        }
        let resolvedLink;
        try {
          resolvedLink = await realpath(childPath);
        } catch (error) {
          throw new Error(`[SUPPLY_CHAIN_FAIL] Scan-target symlink is dangling: ${childRelative}`);
        }
        const linkRelative = relative(targetRealpath, resolvedLink);
        if (linkRelative === ".." || linkRelative.startsWith(`..${sep}`) || isAbsolute(linkRelative)) {
          throw new Error(`[SUPPLY_CHAIN_FAIL] Scan-target symlink escapes the release tree: ${childRelative}`);
        }
        hash.update(`l\0${linkTarget}\0`);
      } else {
        throw new Error(`[SUPPLY_CHAIN_FAIL] Unsupported scan-target entry: ${childRelative}`);
      }
    }
  }
  await visit(targetPath, "");
  return { kind: "directory", size, fileCount, sha256: hash.digest("hex") };
}

/**
 * @param {string} path
 */
function jsonObject(path) {
  return readFile(path, "utf8").then((text) => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Invalid JSON from ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] ${basename(path)} is not a JSON object.`);
    }
    return parsed;
  });
}

/**
 * Artifact names become several output filenames. Keep this API boundary
 * filename-only so a caller cannot move scanner evidence outside outputDir.
 *
 * @param {unknown} value
 */
function safeArtifactName(value) {
  const candidate = String(value ?? "");
  if (!candidate || candidate === "." || candidate === ".." || basename(candidate) !== candidate || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(candidate)) {
    throw new Error("[SUPPLY_CHAIN_FAIL] artifactName must be a simple filename stem.");
  }
  return candidate;
}

const COMPONENT_INPUT_SCOPES = new Set([
  "shipped-runtime",
  "shipped-application",
  "build-input",
  "dev-inventory"
]);
const SYFT_CATALOGER_SET = new Set(SYFT_COMPONENT_CATALOGERS);

/**
 * @param {unknown} value
 * @param {string} label
 */
function normalizeComponentCatalogers(value, label) {
  if (value === undefined) return [...SYFT_COMPONENT_CATALOGERS];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`[SUPPLY_CHAIN_FAIL] Component input ${label} must declare one or more Syft catalogers.`);
  }
  const catalogers = value.map((entry) => String(entry));
  const seen = new Set();
  for (const cataloger of catalogers) {
    if (!SYFT_CATALOGER_SET.has(cataloger)) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Unsupported Syft cataloger for ${label}: ${cataloger}`);
    }
    if (seen.has(cataloger)) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Duplicate Syft cataloger for ${label}: ${cataloger}`);
    }
    seen.add(cataloger);
  }
  return catalogers;
}

/**
 * @param {unknown} value
 * @returns {Map<string, string[]>}
 */
function componentCatalogerMap(value) {
  if (value === undefined) return new Map();
  if (value instanceof Map) return new Map(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[SUPPLY_CHAIN_FAIL] componentCatalogers must be a map of labels to cataloger arrays.");
  }
  return new Map(Object.entries(value));
}

/**
 * Parse the deliberately explicit command-line form
 * `<scope>:<label>=<path>`. Paths are resolved and contained by the release
 * target later, after the target has been validated. Keeping the parser
 * separate means API callers can provide the same structured value without
 * manufacturing a command-line string.
 *
 * @param {string} value
 * @returns {{scope: string, label: string, path: string}}
 */
function parseComponentInput(value) {
  const separator = value.indexOf("=");
  const scopeLabel = separator > 0 ? value.slice(0, separator) : "";
  const inputPath = separator > 0 ? value.slice(separator + 1) : "";
  const scopeSeparator = scopeLabel.indexOf(":");
  const scope = scopeSeparator > 0 ? scopeLabel.slice(0, scopeSeparator) : "";
  const label = scopeSeparator > 0 ? scopeLabel.slice(scopeSeparator + 1) : "";
  if (!scope || !label || !inputPath) {
    throw new Error(`[SUPPLY_CHAIN_FAIL] --component-input must be <scope>:<label>=<path>: ${value}`);
  }
  return { scope, label, path: inputPath };
}

/**
 * Parse the optional per-input cataloger selection form
 * `<label>=<cataloger>,<cataloger>`. Unknown names are rejected when the
 * structured input is resolved against Syft 1.51.1's supported catalogers.
 *
 * @param {string} value
 * @returns {{label: string, catalogers: string[]}}
 */
function parseComponentCatalogers(value) {
  const separator = value.indexOf("=");
  const label = separator > 0 ? value.slice(0, separator) : "";
  const rawCatalogers = separator > 0 ? value.slice(separator + 1) : "";
  if (!label || !rawCatalogers) {
    throw new Error(`[SUPPLY_CHAIN_FAIL] --component-catalogers must be <label>=<cataloger>,...: ${value}`);
  }
  const catalogers = rawCatalogers.split(",").map((entry) => entry.trim()).filter(Boolean);
  return { label, catalogers };
}

/**
 * Resolve exact supplemental scan inputs inside the release staging parent.
 * A caller must deliberately classify every input. This keeps runtime/shipped
 * evidence distinct from lockfiles and other build/development inventories,
 * and prevents the scanner from reaching outside the curated staging area.
 *
 * @param {unknown} values
 * @param {string} targetPath
 * @param {{kind: string, size: number, fileCount: number, sha256: string}} target
 * @param {Map<string, string[]>} [catalogerSelections]
 */
async function resolveComponentInputs(values, targetPath, target, catalogerSelections = new Map()) {
  if (values === undefined) {
    if (catalogerSelections.size > 0) {
      throw new Error("[SUPPLY_CHAIN_FAIL] Syft cataloger selections require matching component inputs.");
    }
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error("[SUPPLY_CHAIN_FAIL] componentInputs must be an array.");
  }
  if (values.length === 0) {
    if (catalogerSelections.size > 0) {
      throw new Error("[SUPPLY_CHAIN_FAIL] Syft cataloger selections require matching component inputs.");
    }
    return [];
  }
  if (target.kind !== "directory") {
    throw new Error("[SUPPLY_CHAIN_FAIL] component inputs require a directory scan target.");
  }

  const targetRealpath = await realpath(targetPath);
  const stagingParentRealpath = await realpath(dirname(targetPath));
  const seenLabels = new Set();
  const resolved = [];
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("[SUPPLY_CHAIN_FAIL] Each component input must be an object.");
    }
    const candidate = /** @type {Record<string, unknown>} */ (value);
    const scope = String(candidate.scope ?? "");
    if (!COMPONENT_INPUT_SCOPES.has(scope)) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Unsupported component input scope: ${scope}`);
    }
    const label = safeArtifactName(candidate.label);
    if (seenLabels.has(label)) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Duplicate component input label: ${label}`);
    }
    seenLabels.add(label);
    const inputValue = String(candidate.path ?? "");
    if (!inputValue || inputValue === "." || inputValue === "..") {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Component input ${label} has an invalid path.`);
    }
    const inputPath = resolve(targetPath, inputValue);
    const inputInfo = await lstat(inputPath).catch((error) => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        throw new Error(`[SUPPLY_CHAIN_FAIL] Component input not found: ${label}`);
      }
      throw error;
    });
    if (inputInfo.isSymbolicLink()) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Component input must not be a symlink: ${label}`);
    }
    if (!inputInfo.isFile() && !inputInfo.isDirectory()) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Component input is not a file or directory: ${label}`);
    }
    const inputRealpath = await realpath(inputPath);
    const stagingRelative = relative(stagingParentRealpath, inputRealpath);
    if (stagingRelative === ".." || stagingRelative.startsWith(`..${sep}`) || isAbsolute(stagingRelative)) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Component input must be inside the release staging parent: ${label}`);
    }
    const identity = await targetIdentity(inputPath);
    const explicitCatalogers = candidate.catalogers !== undefined
      ? candidate.catalogers
      : catalogerSelections.get(label);
    resolved.push({
      scope,
      label,
      path: inputPath,
      relativePath: relative(targetRealpath, inputRealpath) || ".",
      catalogers: normalizeComponentCatalogers(explicitCatalogers, label),
      identity
    });
  }
  for (const label of catalogerSelections.keys()) {
    if (!seenLabels.has(label)) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Syft cataloger selection has no matching component input: ${label}`);
    }
  }
  return resolved;
}

/**
 * The scanner must not read configuration, cache, or credential variables
 * from the private operator environment. The small portable allowlist keeps
 * process execution deterministic while leaving no GRYPE_/SYFT_ override
 * available to bypass the explicit database binding below.
 *
 * @param {string} isolatedHome
 * @param {string} databaseCache
 */
function isolatedScanEnvironment(isolatedHome, databaseCache) {
  /** @type {NodeJS.ProcessEnv} */
  const environment = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "NO_COLOR", "CI"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.HOME = isolatedHome;
  environment.XDG_CONFIG_HOME = join(isolatedHome, "config");
  environment.XDG_CACHE_HOME = join(isolatedHome, "cache");
  environment.GOMODCACHE = join(isolatedHome, "go-mod");
  environment.GOPATH = join(isolatedHome, "go");
  environment.TMPDIR = join(isolatedHome, "tmp");
  environment.GRYPE_DB_CACHE_DIR = databaseCache;
  return environment;
}

const OFFICIAL_GRYPE_DATABASE_HOST = "grype.anchore.io";

/**
 * Validate and normalize the database identity emitted by Grype. Grype's
 * report and `db status` use the same official URL with a sha256 query; this
 * check makes that source and digest part of the acceptance contract.
 *
 * @param {unknown} status
 * @param {string} label
 */
function validateGrypeDatabaseStatus(status, label) {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error(`[SUPPLY_CHAIN_FAIL] Grype ${label} database metadata is missing.`);
  }
  const candidate = /** @type {Record<string, unknown>} */ (status);
  if (candidate.valid !== true || !candidate.built || candidate.schemaVersion === undefined || !candidate.from) {
    throw new Error(`[SUPPLY_CHAIN_FAIL] Grype ${label} database metadata is invalid.`);
  }
  const from = String(candidate.from);
  let databaseUrl;
  try {
    databaseUrl = new URL(from);
  } catch (error) {
    throw new Error(`[SUPPLY_CHAIN_FAIL] Grype ${label} database source is not a URL.`);
  }
  if (databaseUrl.protocol !== "https:" || databaseUrl.hostname !== OFFICIAL_GRYPE_DATABASE_HOST || !/^\/databases\/v\d+\//u.test(databaseUrl.pathname)) {
    throw new Error(`[SUPPLY_CHAIN_FAIL] Grype ${label} database source is not the official endpoint.`);
  }
  const checksum = databaseUrl.searchParams.get("checksum") ?? "";
  const checksumMatch = checksum.match(/^sha256:([0-9a-f]{64})$/iu);
  if (!checksumMatch?.[1]) {
    throw new Error(`[SUPPLY_CHAIN_FAIL] Grype ${label} database checksum is missing or invalid.`);
  }
  const built = String(candidate.built);
  const builtAt = Date.parse(built);
  if (!Number.isFinite(builtAt) || builtAt > Date.now() + 5 * 60 * 1000) {
    throw new Error(`[SUPPLY_CHAIN_FAIL] Grype ${label} database build time is invalid.`);
  }
  return {
    valid: true,
    built,
    schemaVersion: String(candidate.schemaVersion),
    from,
    source: `${databaseUrl.origin}${databaseUrl.pathname}`,
    checksum: checksumMatch[1]
  };
}

/**
 * @param {{built: string, schemaVersion: string, from: string, checksum: string}} left
 * @param {{built: string, schemaVersion: string, from: string, checksum: string}} right
 */
function sameGrypeDatabase(left, right) {
  return left.built === right.built && left.schemaVersion === right.schemaVersion && left.from === right.from && left.checksum === right.checksum;
}

/**
 * @param {string} path
 * @param {"syftJson"|"spdxJson"|"cyclonedxJson"} format
 */
async function validateSbom(path, format) {
  const parsed = await jsonObject(path);
  let componentCount;
  if (format === "syftJson") {
    if (!Array.isArray(parsed.artifacts) || !parsed.schema || typeof parsed.schema !== "object" || typeof parsed.schema.version !== "string") {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Syft JSON is missing its schema or artifacts array: ${basename(path)}`);
    }
    componentCount = parsed.artifacts.length;
  } else if (format === "spdxJson") {
    if (!/^SPDX-\d+\.\d+$/u.test(String(parsed.spdxVersion ?? "")) || !Array.isArray(parsed.packages)) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] SPDX JSON is missing its version or packages array: ${basename(path)}`);
    }
    componentCount = parsed.packages.length;
  } else {
    // CycloneDX permits an empty BOM to omit the optional top-level
    // components array. A metadata component still proves the BOM shape;
    // report zero discovery rather than treating that valid result as green
    // coverage for a different artifact.
    if (parsed.components !== undefined && !Array.isArray(parsed.components)) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] CycloneDX components is not an array: ${basename(path)}`);
    }
    if (parsed.bomFormat !== "CycloneDX" || !parsed.specVersion) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] CycloneDX JSON is missing its BOM identity: ${basename(path)}`);
    }
    componentCount = Array.isArray(parsed.components) ? parsed.components.length : 0;
  }
  return { sha256: sha256Hex(await readFile(path)), componentCount, format, parsed };
}

/**
 * Count the npm package representations in each emitted format. The counts
 * are intentionally format-specific: a release may contain both a standalone
 * sidecar payload and the same payload embedded in an application bundle.
 *
 * @param {any} parsed
 * @param {"syftJson"|"spdxJson"|"cyclonedxJson"} format
 */
function countNpmPackages(parsed, format) {
  if (format === "syftJson") {
    /** @param {any} artifact */
    const isNpmArtifact = (artifact) => String(artifact?.type ?? "").toLowerCase() === "npm";
    return Array.isArray(parsed.artifacts) ? parsed.artifacts.filter(isNpmArtifact).length : 0;
  }
  if (format === "spdxJson") {
    /** @param {any} ref */
    const isNpmReference = (ref) => String(ref?.referenceLocator ?? "").toLowerCase().startsWith("pkg:npm/");
    /** @param {any} pkg */
    const isNpmPackage = (pkg) => Array.isArray(pkg?.externalRefs) && pkg.externalRefs.some(isNpmReference);
    return Array.isArray(parsed.packages) ? parsed.packages.filter(isNpmPackage).length : 0;
  }
  /** @type {any[]} */
  const components = [];
  /** @param {any} entries */
  function collect(entries) {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      components.push(entry);
      collect(entry?.components);
    }
  }
  collect(parsed.components);
  /** @param {any} component */
  const isNpmComponent = (component) => String(component?.purl ?? "").toLowerCase().startsWith("pkg:npm/");
  return components.filter(isNpmComponent).length;
}

/**
 * Replace only private roots in scanner metadata fields. Package/artifact and
 * vulnerability objects are deliberately outside this traversal so a private
 * path in those data-bearing areas fails closed instead of being rewritten.
 *
 * @param {string} value
 * @param {Array<{label: string, path: string}>} roots
 */
function normalizePrivateRoot(value, roots) {
  for (const root of roots) {
    const index = value.indexOf(root.path);
    if (index < 0) continue;
    const next = value[index + root.path.length];
    if (next && next !== "/" && next !== "\\") continue;
    const suffix = value.slice(index + root.path.length).replace(/^[/\\]+/u, "");
    return suffix ? `<${root.label}>/${suffix}` : `<${root.label}>`;
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} jsonPath
 * @param {Array<{label: string, path: string}>} roots
 * @param {string[]} changedPaths
 * @returns {unknown}
 */
function sanitizeMetadataValue(value, jsonPath, roots, changedPaths) {
  if (typeof value === "string") {
    const normalized = normalizePrivateRoot(value, roots);
    if (normalized !== value) changedPaths.push(jsonPath);
    return normalized;
  }
  if (Array.isArray(value)) return value.map((entry, index) => sanitizeMetadataValue(entry, `${jsonPath}[${index}]`, roots, changedPaths));
  if (!value || typeof value !== "object") return value;
  const object = /** @type {Record<string, unknown>} */ (value);
  for (const [key, entry] of Object.entries(object)) {
    object[key] = sanitizeMetadataValue(entry, `${jsonPath}.${key}`, roots, changedPaths);
  }
  return object;
}

/**
 * @param {string} text
 * @param {string} label
 * @param {string[]} residualRoots
 */
function assertNoPrivatePaths(text, label, residualRoots) {
  const remaining = residualRoots.find((root) => root && text.includes(root));
  if (remaining) {
    throw new Error(`[SUPPLY_CHAIN_FAIL] Private path remained in retained ${label} output.`);
  }
}

/**
 * Normalize task-owned cache/report roots in known scanner metadata fields,
 * then fail if any user-home or temporary root remains anywhere in the JSON.
 * The returned before/after digests make the retained transformation explicit
 * without retaining the raw private-path-bearing bytes.
 *
 * @param {string} path
 * @param {"syft-json"|"spdx-json"|"cyclonedx-json"|"grype-json"|"grype-sarif"} format
 * @param {Array<{label: string, path: string}>} roots
 * @param {string[]} residualRoots
 */
export async function sanitizeReportFile(path, format, roots, residualRoots) {
  const originalBytes = await readFile(path);
  const originalText = originalBytes.toString("utf8");
  const beforeSha256 = sha256Hex(originalBytes);
  let parsed;
  try {
    parsed = JSON.parse(originalText);
  } catch (error) {
    throw new Error(`[SUPPLY_CHAIN_FAIL] Cannot sanitize invalid ${format} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  /** @type {string[]} */
  const changedPaths = [];
  if (format === "syft-json" && parsed?.descriptor?.configuration) {
    parsed.descriptor.configuration = sanitizeMetadataValue(parsed.descriptor.configuration, "$.descriptor.configuration", roots, changedPaths);
  } else if (format === "grype-json") {
    if (parsed?.descriptor?.configuration) {
      parsed.descriptor.configuration = sanitizeMetadataValue(parsed.descriptor.configuration, "$.descriptor.configuration", roots, changedPaths);
    }
    const originalDbStatusPath = parsed?.descriptor?.db?.status?.path;
    if (typeof originalDbStatusPath === "string") {
      parsed.descriptor.db.status.path = normalizePrivateRoot(originalDbStatusPath, roots);
      if (parsed.descriptor.db.status.path !== originalDbStatusPath) changedPaths.push("$.descriptor.db.status.path");
    }
  }
  const sanitizedText = changedPaths.length > 0 ? JSON.stringify(parsed) : originalText;
  assertNoPrivatePaths(sanitizedText, format, residualRoots);
  if (changedPaths.length > 0) await writeFile(path, sanitizedText, "utf8");
  const sanitizedBytes = Buffer.from(sanitizedText, "utf8");
  return {
    filename: basename(path),
    format,
    beforeSha256,
    sha256: sha256Hex(sanitizedBytes),
    changed: changedPaths.length > 0,
    replacements: changedPaths.length,
    fields: changedPaths
  };
}

/**
 * Runs Syft and Grype against a release-shaped artifact and generates SBOM and
 * vulnerability reports. The target may be a package/archive file or a
 * materialized release directory.
 *
 * @param {object} options
 * @param {string} options.targetPath Path to package tarball or file or directory
 * @param {string} options.outputDir Destination directory for artifacts
 * @param {string} [options.toolsDir] Cache directory for tools (defaults outside output)
 * @param {string} [options.artifactName] Base name for output artifacts
 * @param {string} [options.failOn] Severity threshold to fail on (default "high")
 * @param {Array<{scope: string, label: string, path: string, catalogers?: string[]}>} [options.componentInputs]
 *   Exact staging inputs to scan separately. Inputs may be under the primary
 *   target or a sibling curated inventory directory. `shipped-*` inputs describe
 *   shipped/runtime coverage; `build-input` and `dev-inventory` are retained
 *   inventories and never establish shipped coverage.
 * @param {Map<string, string[]> | Record<string, string[]>} [options.componentCatalogers]
 *   Optional per-input selection from the supported Syft 1.51.1 catalogers.
 */
export async function runSupplyChainScan(options) {
  if (!options?.targetPath || !options?.outputDir) throw new Error("[SUPPLY_CHAIN_FAIL] targetPath and outputDir are required.");
  const targetPath = resolve(options.targetPath);
  if (!existsSync(targetPath)) throw new Error(`[SUPPLY_CHAIN_FAIL] Target not found: ${basename(targetPath)}`);

  const name = safeArtifactName(options.artifactName ?? basename(targetPath).replace(/\.(tar\.gz|tgz|tar|zip)$/u, ""));
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const targetInfo = await lstat(targetPath);
  if (targetInfo.isDirectory()) {
    const outputRelative = relative(targetPath, outputDir);
    if (outputRelative === "" || (!outputRelative.startsWith(`..${sep}`) && outputRelative !== ".." && !isAbsolute(outputRelative))) {
      throw new Error("[SUPPLY_CHAIN_FAIL] Output directory must be outside a directory scan target.");
    }
  }

  const toolsDir = resolve(options.toolsDir ?? join(tmpdir(), "tfsb-supply-chain-tools", hostPlatformTuple()));
  const syft = await ensureToolWithProvenance("syft", toolsDir);
  const grype = await ensureToolWithProvenance("grype", toolsDir);

  // Scanner configuration must not inherit the private operator's home,
  // module caches, or config files. Keep the runtime state in temporary
  // scratch and record only sanitized tool provenance in the receipt.
  const isolatedHome = join(tmpdir(), "tfsb-supply-chain-home", hostPlatformTuple());
  await mkdir(isolatedHome, { recursive: true });
  const databaseCache = join(tmpdir(), "tfsb-grype-db", hostPlatformTuple());
  const scanEnv = isolatedScanEnvironment(isolatedHome, databaseCache);
  // Syft's file-metadata cataloger records source paths verbatim. Omit those
  // descriptive file components so retained SBOMs remain host-path-free while
  // package, native, raster, and application catalogers continue to run.
  scanEnv.SYFT_FILE_METADATA_SELECTION = "none";
  await mkdir(join(isolatedHome, "config"), { recursive: true });
  await mkdir(join(isolatedHome, "cache"), { recursive: true });
  await mkdir(join(isolatedHome, "tmp"), { recursive: true });
  await mkdir(databaseCache, { recursive: true });

  const initialTarget = await targetIdentity(targetPath);
  const componentInputs = await resolveComponentInputs(
    options.componentInputs,
    targetPath,
    initialTarget,
    componentCatalogerMap(options.componentCatalogers)
  );
  const targetCwd = dirname(targetPath);
  const targetArg = basename(targetPath);
  // Keep tool-generated metadata outside the requested evidence directory.
  // Grype records its output path in JSON; a temporary path prevents private
  // operator prefixes from entering retained scanner outputs. The copied
  // bytes remain exact and are hashed in the receipt after validation.
  const scannerOutputDir = await mkdtemp(join(tmpdir(), "tfsb-supply-chain-reports-"));
  const privateReportRoots = [
    { label: "scanner-output", path: scannerOutputDir },
    { label: "grype-db-cache", path: databaseCache },
    { label: "isolated-home", path: isolatedHome },
    ...(process.env.HOME ? [{ label: "operator-home", path: resolve(process.env.HOME) }] : []),
    ...(process.env.USERPROFILE ? [{ label: "operator-home", path: resolve(process.env.USERPROFILE) }] : []),
    { label: "temporary-root", path: resolve(tmpdir()) }
  ]
    .filter((root, index, roots) => roots.findIndex((candidate) => candidate.path === root.path) === index)
    .sort((left, right) => right.path.length - left.path.length);
  const residualPrivateRoots = privateReportRoots.map((root) => root.path);
  /** @type {Array<{filename: string, format: string, beforeSha256: string, sha256: string, changed: boolean, replacements: number, fields: string[]}>} */
  const sanitizationRecords = [];
  /** @param {string} path */
  const outputArg = (path) => relative(targetCwd, path) || basename(path);

  const syftJsonPath = join(scannerOutputDir, `${name}.syft.json`);
  const spdxJsonPath = join(scannerOutputDir, `${name}.spdx.json`);
  const cdxJsonPath = join(scannerOutputDir, `${name}.cdx.json`);
  const grypeJsonPath = join(scannerOutputDir, `${name}.grype.json`);
  const grypeSarifPath = join(scannerOutputDir, `${name}.grype.sarif`);
  const retainedSyftJsonPath = join(outputDir, `${name}.syft.json`);
  const retainedSpdxJsonPath = join(outputDir, `${name}.spdx.json`);
  const retainedCdxJsonPath = join(outputDir, `${name}.cdx.json`);
  const retainedGrypeJsonPath = join(outputDir, `${name}.grype.json`);
  const retainedGrypeSarifPath = join(outputDir, `${name}.grype.sarif`);
  const componentScanRecords = componentInputs.map((input) => {
    const stem = `${name}.input-${input.label}`;
    return {
      input,
      syftJsonPath: join(scannerOutputDir, `${stem}.syft.json`),
      spdxJsonPath: join(scannerOutputDir, `${stem}.spdx.json`),
      cdxJsonPath: join(scannerOutputDir, `${stem}.cdx.json`),
      grypeJsonPath: join(scannerOutputDir, `${stem}.grype.json`),
      grypeSarifPath: join(scannerOutputDir, `${stem}.grype.sarif`),
      retainedSyftJsonPath: join(outputDir, `${stem}.syft.json`),
      retainedSpdxJsonPath: join(outputDir, `${stem}.spdx.json`),
      retainedCdxJsonPath: join(outputDir, `${stem}.cdx.json`),
      retainedGrypeJsonPath: join(outputDir, `${stem}.grype.json`),
      retainedGrypeSarifPath: join(outputDir, `${stem}.grype.sarif`)
    };
  });
  const retainedPaths = [
    retainedSyftJsonPath,
    retainedSpdxJsonPath,
    retainedCdxJsonPath,
    retainedGrypeJsonPath,
    retainedGrypeSarifPath,
    ...componentScanRecords.flatMap((record) => [
      record.retainedSyftJsonPath,
      record.retainedSpdxJsonPath,
      record.retainedCdxJsonPath,
      record.retainedGrypeJsonPath,
      record.retainedGrypeSarifPath
    ])
  ];
  for (const path of retainedPaths) {
    await rm(path, { force: true });
  }

  /** @param {string} binaryPath @param {string[]} args */
  function runTool(binaryPath, args) {
    execFileSync(binaryPath, args, {
      cwd: targetCwd,
      env: scanEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  // Keep source identity and paths stable across worktrees. The target itself
  // remains the exact input bound by initialTarget; these flags only control
  // Syft's descriptive source metadata and path rendering.
  /** @param {string} sourceName @param {string[]} [catalogers] */
  const syftSourceArgs = (sourceName, catalogers = SYFT_COMPONENT_CATALOGERS) => [
    "--base-path",
    ".",
    "--source-name",
    sourceName,
    ...catalogers.flatMap((cataloger) => ["--select-catalogers", `+${cataloger}`])
  ];

  /**
   * Every separately declared input is scanned with the same existing Syft
   * cataloger selection and all three retained output formats. The input and
   * enclosing release tree are checked after each format so a moving staged
   * artifact cannot be mistaken for a qualified SBOM.
   *
   * @param {{sourcePath: string, sourceArg: string, sourceName: string, paths: {syftJsonPath: string, spdxJsonPath: string, cdxJsonPath: string}, initialInput: {kind?: string, sha256: string}, catalogers?: string[], label: string}} scan
   */
  async function generateSyftOutputs(scan) {
    /** @type {Array<[string, string, string]>} */
    const formats = [
      ["json", scan.paths.syftJsonPath, "Syft JSON"],
      ["spdx-json", scan.paths.spdxJsonPath, "SPDX"],
      ["cyclonedx-json", scan.paths.cdxJsonPath, "CycloneDX"]
    ];
    for (const [format, outputPath, formatLabel] of formats) {
      const sourceType = scan.initialInput.kind === "file" ? "file" : "dir";
      runTool(syft.path, [scan.sourceArg, "--from", sourceType, ...syftSourceArgs(scan.sourceName, scan.catalogers), "-o", `${format}=${outputArg(outputPath)}`, "-q"]);
      const afterInput = await targetIdentity(scan.sourcePath);
      if (afterInput.sha256 !== scan.initialInput.sha256) {
        throw new Error(`[SUPPLY_CHAIN_FAIL] Scan input changed during ${formatLabel} generation: ${scan.label}`);
      }
      const afterTarget = await targetIdentity(targetPath);
      if (afterTarget.sha256 !== initialTarget.sha256) {
        throw new Error(`[SUPPLY_CHAIN_FAIL] Scan target changed during ${formatLabel} generation.`);
      }
      sanitizationRecords.push(await sanitizeReportFile(outputPath, format === "json" ? "syft-json" : format === "spdx-json" ? "spdx-json" : "cyclonedx-json", privateReportRoots, residualPrivateRoots));
    }
    return {
      syftJson: await validateSbom(scan.paths.syftJsonPath, "syftJson"),
      spdxJson: await validateSbom(scan.paths.spdxJsonPath, "spdxJson"),
      cdxJson: await validateSbom(scan.paths.cdxJsonPath, "cyclonedxJson")
    };
  }

  /**
   * Read the DB identity through Grype itself after the explicit update and
   * between the two output-format scans. Raw status output is deliberately
   * kept ephemeral because it contains the scratch cache path.
   */
  function readDatabaseStatus() {
    let text;
    try {
      text = execFileSync(grype.path, ["db", "status", "-o", "json", "-q"], {
        cwd: targetCwd,
        env: scanEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Could not read Grype database status: ${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Grype database status is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return validateGrypeDatabaseStatus(parsed, "status");
  }

  const primarySyft = await generateSyftOutputs({
    sourcePath: targetPath,
    sourceArg: targetArg,
    sourceName: name,
    paths: { syftJsonPath, spdxJsonPath, cdxJsonPath },
    initialInput: initialTarget,
    catalogers: SYFT_COMPONENT_CATALOGERS,
    label: "primary release target"
  });
  const componentSyft = [];
  for (const record of componentScanRecords) {
    const componentSyftResult = await generateSyftOutputs({
      sourcePath: record.input.path,
      sourceArg: relative(targetCwd, record.input.path) || basename(record.input.path),
      sourceName: `${name}-input-${record.input.label}`,
      paths: record,
      initialInput: record.input.identity,
      catalogers: record.input.catalogers,
      label: record.input.label
    });
    componentSyft.push({ record, ...componentSyftResult });
  }
  const syftJson = primarySyft.syftJson;
  const spdxJson = primarySyft.spdxJson;
  const cdxJson = primarySyft.cdxJson;

  // Grype's default database endpoint is intentionally exercised at scan
  // time. Disable its later automatic update checks only after this succeeds,
  // so JSON and SARIF are bound to one immutable DB identity.
  const databaseUpdateStartedAt = new Date().toISOString();
  runTool(grype.path, ["db", "update", "-q"]);
  const databaseUpdateFinishedAt = new Date().toISOString();
  const databaseAfterUpdate = readDatabaseStatus();
  scanEnv.GRYPE_DB_AUTO_UPDATE = "false";

  /**
   * Scan one retained Syft JSON with both existing Grype report formats. The
   * authenticated database is read back after each report and must remain the
   * same for the primary and every declared component input.
   *
   * @param {{syftJsonPath: string, grypeJsonPath: string, grypeSarifPath: string, syftJson: {sha256: string}, label: string}} scan
   */
  async function runGrypeOutputs(scan) {
    const sbomDigestBefore = scan.syftJson.sha256;
    runTool(grype.path, [`sbom:${outputArg(scan.syftJsonPath)}`, "-o", "json", "--file", outputArg(scan.grypeJsonPath), "-q"]);
    sanitizationRecords.push(await sanitizeReportFile(scan.grypeJsonPath, "grype-json", privateReportRoots, residualPrivateRoots));
    const sbomDigestAfterJson = sha256Hex(await readFile(scan.syftJsonPath));
    if (sbomDigestAfterJson !== sbomDigestBefore) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Grype JSON input changed after SBOM generation: ${scan.label}`);
    }

    const grypeJson = await jsonObject(scan.grypeJsonPath);
    if (!Array.isArray(grypeJson.matches)) throw new Error(`[SUPPLY_CHAIN_FAIL] Grype JSON is missing its matches array: ${scan.label}`);
    if (!grypeJson.descriptor || typeof grypeJson.descriptor !== "object") throw new Error(`[SUPPLY_CHAIN_FAIL] Grype JSON is missing its descriptor: ${scan.label}`);
    const databaseFromJson = validateGrypeDatabaseStatus(grypeJson.descriptor.db?.status, `JSON (${scan.label})`);
    if (!sameGrypeDatabase(databaseAfterUpdate, databaseFromJson)) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Grype JSON used a different vulnerability database: ${scan.label}`);
    }
    if (String(grypeJson.descriptor.version ?? "") !== grype.version) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Grype report version does not match measured ${grype.version}: ${scan.label}`);
    }

    runTool(grype.path, [`sbom:${outputArg(scan.syftJsonPath)}`, "-o", "sarif", "--file", outputArg(scan.grypeSarifPath), "-q"]);
    sanitizationRecords.push(await sanitizeReportFile(scan.grypeSarifPath, "grype-sarif", privateReportRoots, residualPrivateRoots));
    const sbomDigestAfterSarif = sha256Hex(await readFile(scan.syftJsonPath));
    if (sbomDigestAfterSarif !== sbomDigestBefore) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Grype SARIF input changed after SBOM generation: ${scan.label}`);
    }

    const grypeSarif = await jsonObject(scan.grypeSarifPath);
    if (grypeSarif.version !== "2.1.0" || !Array.isArray(grypeSarif.runs)) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Grype SARIF is missing the required SARIF 2.1.0 structure: ${scan.label}`);
    }
    const databaseAfterSarif = readDatabaseStatus();
    if (!sameGrypeDatabase(databaseAfterUpdate, databaseAfterSarif)) {
      throw new Error(`[SUPPLY_CHAIN_FAIL] Grype SARIF used a different vulnerability database: ${scan.label}`);
    }
    return {
      grypeJson,
      grypeSarif,
      databaseFromJson,
      databaseAfterSarif,
      sbomDigestBefore,
      grypeJsonSha256: sha256Hex(await readFile(scan.grypeJsonPath)),
      grypeSarifSha256: sha256Hex(await readFile(scan.grypeSarifPath))
    };
  }

  const primaryGrype = await runGrypeOutputs({
    syftJsonPath,
    grypeJsonPath,
    grypeSarifPath,
    syftJson,
    label: "primary release target"
  });
  const componentGrype = [];
  for (const component of componentSyft) {
    componentGrype.push({
      component,
      result: await runGrypeOutputs({
        syftJsonPath: component.record.syftJsonPath,
        grypeJsonPath: component.record.grypeJsonPath,
        grypeSarifPath: component.record.grypeSarifPath,
        syftJson: component.syftJson,
        label: component.record.input.label
      })
    });
  }
  const grypeJson = primaryGrype.grypeJson;
  const databaseFromJson = primaryGrype.databaseFromJson;
  const databaseAfterSarif = primaryGrype.databaseAfterSarif;

  /** @param {any[]} matches */
  function vulnerabilityCounts(matches) {
    /** @type {Record<string, number> & { critical: number, high: number, medium: number, low: number, negligible: number, unknown: number }} */
    const result = { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 };
    for (const match of matches) {
      const severity = String(match?.vulnerability?.severity ?? "unknown").toLowerCase();
      if (SEVERITIES.includes(severity)) result[severity] = (result[severity] ?? 0) + 1;
      else result.unknown = (result.unknown ?? 0) + 1;
    }
    return result;
  }
  /** @type {Record<string, number> & { critical: number, high: number, medium: number, low: number, negligible: number, unknown: number }} */
  const counts = { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 };
  /** @param {any[]} matches */
  function addVulnerabilityCounts(matches) {
    const result = vulnerabilityCounts(matches);
    for (const severity of SEVERITIES) {
      counts[severity] = (counts[severity] ?? 0) + (result[severity] ?? 0);
    }
  }
  addVulnerabilityCounts(grypeJson.matches);
  for (const component of componentGrype) addVulnerabilityCounts(component.result.grypeJson.matches);

  const failThreshold = String(options.failOn ?? "high").toLowerCase();
  if (!SEVERITIES.includes(failThreshold) || failThreshold === "unknown") {
    throw new Error(`[SUPPLY_CHAIN_FAIL] Unsupported vulnerability threshold: ${failThreshold}`);
  }
  /** @type {Record<string, number>} */
  const severityRank = { negligible: 0, low: 1, medium: 2, high: 3, critical: 4 };
  const thresholdRank = severityRank[failThreshold] ?? 3;
  /** @param {Record<string, number>} candidate */
  const isBlocking = (candidate) => Object.entries(candidate).some(([severity, count]) => severity !== "unknown" && count > 0 && (severityRank[severity] ?? -1) >= thresholdRank);
  const hasBlocking = isBlocking(counts);

  const componentReports = componentGrype.map(({ component, result }) => {
    const record = component.record;
    const componentCounts = vulnerabilityCounts(result.grypeJson.matches);
    return {
      label: record.input.label,
      scope: record.input.scope,
      catalogers: record.input.catalogers,
      coverage: record.input.scope.startsWith("shipped-") ? record.input.scope : "non-shipped-inventory",
      path: record.input.relativePath,
      input: {
        kind: record.input.identity.kind,
        size: record.input.identity.size,
        fileCount: record.input.identity.fileCount,
        sha256: record.input.identity.sha256
      },
      syft: {
        syftJson: { filename: basename(record.retainedSyftJsonPath), sha256: component.syftJson.sha256, componentCount: component.syftJson.componentCount, npmPackageCount: countNpmPackages(component.syftJson.parsed, "syftJson") },
        spdxJson: { filename: basename(record.retainedSpdxJsonPath), sha256: component.spdxJson.sha256, componentCount: component.spdxJson.componentCount, npmPackageCount: countNpmPackages(component.spdxJson.parsed, "spdxJson") },
        cyclonedxJson: { filename: basename(record.retainedCdxJsonPath), sha256: component.cdxJson.sha256, componentCount: component.cdxJson.componentCount, npmPackageCount: countNpmPackages(component.cdxJson.parsed, "cyclonedxJson") }
      },
      scans: {
        grypeInput: { filename: basename(record.retainedSyftJsonPath), sha256: result.sbomDigestBefore },
        grypeJson: { filename: basename(record.retainedGrypeJsonPath), sha256: result.grypeJsonSha256 },
        grypeSarif: { filename: basename(record.retainedGrypeSarifPath), sha256: result.grypeSarifSha256 }
      },
      vulnerabilities: {
        total: result.grypeJson.matches.length,
        counts: componentCounts,
        blocking: isBlocking(componentCounts)
      }
    };
  });
  const shippedComponentLabels = componentReports.filter((component) => component.scope.startsWith("shipped-")).map((component) => component.label);
  const inventoryComponentLabels = componentReports.filter((component) => !component.scope.startsWith("shipped-")).map((component) => component.label);

  const emptyDeclaredInputs = componentReports.filter((component) => component.syft.syftJson.componentCount === 0);
  const receipt = {
    schema: "tfsb.supply-chain-scan-receipt-v1",
    schemaVersion: 1,
    status: hasBlocking || emptyDeclaredInputs.length > 0 ? "fail" : "pass",
    scannedAt: new Date().toISOString(),
    target: {
      path: basename(targetPath),
      kind: initialTarget.kind,
      size: initialTarget.size,
      fileCount: initialTarget.fileCount,
      sha256: initialTarget.sha256
    },
    tools: {
      syft: {
        version: syft.version,
        versionArgs: syft.versionArgs,
        binarySha256: syft.binarySha256,
        authenticatedBinarySha256: syft.authenticatedBinarySha256,
        source: syft.source,
        platform: syft.platform,
        archive: syft.archive
      },
      grype: {
        version: grype.version,
        versionArgs: grype.versionArgs,
        binarySha256: grype.binarySha256,
        authenticatedBinarySha256: grype.authenticatedBinarySha256,
        source: grype.source,
        platform: grype.platform,
        archive: grype.archive
      }
    },
    sanitization: {
      schema: "tfsb.supply-chain-report-sanitization-v1",
      status: "complete",
      privateRoots: privateReportRoots.map((root) => ({ label: root.label, replacement: `<${root.label}>` })),
      residualCheck: "failed if any declared private root remains in a retained report",
      records: sanitizationRecords
    },
    discovery: {
      catalogers: {
        added: SYFT_COMPONENT_CATALOGERS,
        selectionExpression: SYFT_COMPONENT_CATALOGERS.map((cataloger) => `+${cataloger}`).join(","),
        appliedTo: ["syft-json", "spdx-json", "cyclonedx-json"],
        fileMetadataSelection: "none",
        primarySelection: SYFT_COMPONENT_CATALOGERS
      },
      syft: {
        format: "syft-json",
        componentCount: syftJson.componentCount,
        npmPackageCount: countNpmPackages(syftJson.parsed, "syftJson")
      },
      spdx: {
        format: "spdx-json",
        componentCount: spdxJson.componentCount,
        npmPackageCount: countNpmPackages(spdxJson.parsed, "spdxJson")
      },
      cyclonedx: {
        format: "cyclonedx-json",
        componentCount: cdxJson.componentCount,
        npmPackageCount: countNpmPackages(cdxJson.parsed, "cyclonedxJson")
      },
      componentInputs: componentReports,
      mapping: {
        primaryTarget: "shipped-release-surface",
        shippedInputs: shippedComponentLabels,
        inventoryInputs: inventoryComponentLabels,
        semantics: "shipped-runtime and shipped-application inputs are declared shipped coverage; build-input and dev-inventory inputs are retained inventories and do not establish shipped coverage.",
        limits: [
          "Cataloger output is evidence for the primary target and explicitly declared inputs only.",
          "A valid SBOM or zero Grype matches does not prove complete discovery of every bundled or native component.",
          "Unrepresented, stripped, or unsupported binary components remain coverage limits and require the release workflow to declare their exact materialized input when available."
        ]
      }
    },
    vulnerabilityDatabase: {
      status: "valid",
      built: databaseAfterUpdate.built,
      schemaVersion: databaseAfterUpdate.schemaVersion,
      checksum: databaseAfterUpdate.checksum,
      source: databaseAfterUpdate.source,
      update: {
        status: "completed",
        endpoint: `https://${OFFICIAL_GRYPE_DATABASE_HOST}/databases/`,
        startedAt: databaseUpdateStartedAt,
        finishedAt: databaseUpdateFinishedAt
      },
      bindings: {
        json: {
          built: databaseFromJson.built,
          schemaVersion: databaseFromJson.schemaVersion,
          from: databaseFromJson.from,
          checksum: databaseFromJson.checksum
        },
        sarif: {
          built: databaseAfterSarif.built,
          schemaVersion: databaseAfterSarif.schemaVersion,
          from: databaseAfterSarif.from,
          checksum: databaseAfterSarif.checksum
        }
      }
    },
    sboms: {
      syftJson: { filename: basename(syftJsonPath), sha256: syftJson.sha256, componentCount: syftJson.componentCount },
      spdxJson: { filename: basename(spdxJsonPath), sha256: spdxJson.sha256, componentCount: spdxJson.componentCount },
      cyclonedxJson: { filename: basename(cdxJsonPath), sha256: cdxJson.sha256, componentCount: cdxJson.componentCount },
      componentInputs: componentReports.map((component) => component.syft)
    },
    scans: {
      grypeInput: { filename: basename(syftJsonPath), sha256: primaryGrype.sbomDigestBefore },
      grypeJson: { filename: basename(retainedGrypeJsonPath), sha256: primaryGrype.grypeJsonSha256 },
      grypeSarif: { filename: basename(retainedGrypeSarifPath), sha256: primaryGrype.grypeSarifSha256 },
      componentInputs: componentReports.map((component) => component.scans)
    },
    vulnerabilities: {
      threshold: failThreshold,
      total: grypeJson.matches.length + componentGrype.reduce((total, component) => total + component.result.grypeJson.matches.length, 0),
      counts,
      counting: "per-input-scan; overlapping declared inputs are retained separately and findings are not deduplicated",
      blocking: hasBlocking
    }
  };

  /** @type {Array<[string, string]>} */
  const outputPairs = [
    [syftJsonPath, retainedSyftJsonPath],
    [spdxJsonPath, retainedSpdxJsonPath],
    [cdxJsonPath, retainedCdxJsonPath],
    [grypeJsonPath, retainedGrypeJsonPath],
    [grypeSarifPath, retainedGrypeSarifPath]
  ];
  for (const record of componentScanRecords) {
    outputPairs.push(
      [record.syftJsonPath, record.retainedSyftJsonPath],
      [record.spdxJsonPath, record.retainedSpdxJsonPath],
      [record.cdxJsonPath, record.retainedCdxJsonPath],
      [record.grypeJsonPath, record.retainedGrypeJsonPath],
      [record.grypeSarifPath, record.retainedGrypeSarifPath]
    );
  }
  for (const [source, destination] of outputPairs) {
    await copyFile(source, destination);
  }
  const receiptPath = join(outputDir, `${name}.receipt.json`);
  const receiptText = JSON.stringify(receipt, null, 2) + "\n";
  assertNoPrivatePaths(receiptText, "receipt", residualPrivateRoots);
  await writeFile(receiptPath, receiptText, "utf8");
  await rm(scannerOutputDir, { recursive: true, force: true });

  if (emptyDeclaredInputs.length > 0) {
    throw new Error(`[SUPPLY_CHAIN_FAIL] Declared component inputs discovered no packages: ${emptyDeclaredInputs.map((component) => component.label).join(", ")}. Retained zero findings do not establish coverage.`);
  }

  if (hasBlocking) {
    throw new Error(`[SUPPLY_CHAIN_FAIL] Scan of ${name} found ${counts.critical} critical and ${counts.high} high vulnerabilities.`);
  }

  return receipt;
}

/**
 * @param {string[]} args
 */
export async function main(args = process.argv.slice(2)) {
  let targetPath = "";
  let outputDir = ".test-reports/supply-chain";
  /** @type {string | undefined} */
  let toolsDir;
  /** @type {string | undefined} */
  let artifactName;
  /** @type {string | undefined} */
  let failOn;
  /** @type {Array<{scope: string, label: string, path: string}>} */
  const componentInputs = [];
  /** @type {Map<string, string[]>} */
  const componentCatalogers = new Map();

  for (let i = 0; i < args.length; i++) {
    const current = args[i];
    const next = args[i + 1];
    if (current === "--target" && next !== undefined) { targetPath = next; i++; }
    else if (current === "--output-dir" && next !== undefined) { outputDir = next; i++; }
    else if (current === "--tools-dir" && next !== undefined) { toolsDir = next; i++; }
    else if (current === "--name" && next !== undefined) { artifactName = next; i++; }
    else if (current === "--fail-on" && next !== undefined) { failOn = next; i++; }
    else if (current === "--component-input" && next !== undefined) { componentInputs.push(parseComponentInput(next)); i++; }
    else if (current === "--component-catalogers" && next !== undefined) {
      const selection = parseComponentCatalogers(next);
      if (componentCatalogers.has(selection.label)) throw new Error(`[SUPPLY_CHAIN_FAIL] Duplicate component cataloger selection: ${selection.label}`);
      componentCatalogers.set(selection.label, selection.catalogers);
      i++;
    }
    else throw new Error(`Unknown or incomplete argument: ${current}`);
  }

  if (!targetPath) {
    throw new Error("Usage: node run-syft-grype.mjs --target <file_or_dir> [--output-dir <dir>] [--tools-dir <dir>] [--name <name>] [--fail-on <severity>] [--component-input <scope>:<label>=<path>]... [--component-catalogers <label>=<cataloger>,...]...");
  }

  /** @type {{ targetPath: string, outputDir: string, toolsDir?: string, artifactName?: string, failOn?: string, componentInputs?: Array<{scope: string, label: string, path: string}>, componentCatalogers?: Map<string, string[]> }} */
  const scanOpts = { targetPath, outputDir, componentInputs, componentCatalogers };
  if (toolsDir !== undefined) scanOpts.toolsDir = toolsDir;
  if (artifactName !== undefined) scanOpts.artifactName = artifactName;
  if (failOn !== undefined) scanOpts.failOn = failOn;

  const receipt = await runSupplyChainScan(scanOpts);
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
