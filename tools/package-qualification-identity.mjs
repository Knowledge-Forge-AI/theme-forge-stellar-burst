import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {Object} CandidatePackageIdentity
 * @property {string} name
 * @property {string} version
 * @property {Record<string, string>} bin
 * @property {Record<string, string>} dependencies
 * @property {unknown} exports
 * @property {Record<string, unknown>} raw
 */

/**
 * Derives candidate package identity (name, version, bin, dependencies, exports)
 * from the candidate root package.json.
 *
 * @param {string} candidateRoot
 * @returns {CandidatePackageIdentity}
 */
export function readCandidatePackageIdentity(candidateRoot) {
  const packageJsonPath = join(candidateRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Candidate package.json not found at ${packageJsonPath}`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse candidate package.json at ${packageJsonPath}: ${/** @type {Error} */ (error).message}`);
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("Candidate package.json must define a JSON object.");
  }
  if (typeof raw.name !== "string" || !raw.name.trim()) {
    throw new Error("Candidate package.json must have a valid 'name' string.");
  }
  if (typeof raw.version !== "string" || !raw.version.trim()) {
    throw new Error("Candidate package.json must have a valid 'version' string.");
  }

  /** @type {Record<string, string>} */
  const bin = {};
  if (typeof raw.bin === "string") {
    const binName = raw.name.startsWith("@") ? raw.name.split("/")[1] ?? raw.name : raw.name;
    bin[binName] = raw.bin;
  } else if (raw.bin && typeof raw.bin === "object") {
    for (const [key, value] of Object.entries(raw.bin)) {
      if (typeof value === "string") {
        bin[key] = value;
      }
    }
  }

  return {
    name: raw.name.trim(),
    version: raw.version.trim(),
    bin,
    dependencies: raw.dependencies && typeof raw.dependencies === "object" ? { ...raw.dependencies } : {},
    exports: raw.exports,
    raw,
  };
}

/**
 * Validates a --package-under-test argument string narrowly.
 *
 * @param {string} filePath
 * @param {{ checkExists?: boolean }} [options]
 * @returns {string} Absolute path to validated tarball
 */
export function validatePackageUnderTest(filePath, options = {}) {
  const { checkExists = true } = options;
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("Missing value for --package-under-test.");
  }
  if (!filePath.endsWith(".tgz")) {
    throw new Error(`Invalid --package-under-test: expected a .tgz file, got "${filePath}".`);
  }
  const resolved = resolve(filePath);
  if (checkExists && !existsSync(resolved)) {
    throw new Error(`Package archive under test not found: "${resolved}".`);
  }
  return resolved;
}

/**
 * Parses CLI arguments for qualification tools, strictly validating --package-under-test.
 *
 * @param {string[]} args
 * @param {{ checkExists?: boolean }} [options]
 * @returns {{ packageUnderTest: string | null }}
 */
export function parseQualificationArgs(args, options = {}) {
  let packageUnderTest = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--package-under-test") {
      if (packageUnderTest !== null) {
        throw new Error("Duplicate --package-under-test argument.");
      }
      i++;
      if (i >= args.length || !args[i] || args[i]?.startsWith("-")) {
        throw new Error("Missing value for --package-under-test.");
      }
      packageUnderTest = validatePackageUnderTest(args[i] ?? "", options);
    } else if (arg.startsWith("--package-under-test=")) {
      if (packageUnderTest !== null) {
        throw new Error("Duplicate --package-under-test argument.");
      }
      const val = arg.slice("--package-under-test=".length);
      packageUnderTest = validatePackageUnderTest(val, options);
    } else {
      throw new Error(`Unexpected argument: "${arg}".`);
    }
  }
  return { packageUnderTest };
}

/**
 * Verifies installed package metadata, exact resolved bin bindings, and name match in consumer node_modules.
 * Cannot accept an unrelated package.
 *
 * @param {string} consumerRoot
 * @param {CandidatePackageIdentity} candidateIdentity
 * @returns {{ installedPackageRoot: string, installedManifest: Record<string, unknown> }}
 */
export function verifyInstalledPackageIdentity(consumerRoot, candidateIdentity) {
  const installedRelPath = join("node_modules", ...candidateIdentity.name.split("/"));
  const installedPackageRoot = join(consumerRoot, installedRelPath);
  const manifestPath = join(installedPackageRoot, "package.json");

  if (!existsSync(manifestPath)) {
    throw new Error(`Installed package not found at "${installedPackageRoot}". Expected package "${candidateIdentity.name}" was not installed. Cannot accept unrelated package.`);
  }

  let installedManifest;
  try {
    installedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Installed package.json at "${manifestPath}" is unreadable or malformed: ${/** @type {Error} */ (error).message}`);
  }

  if (!installedManifest || typeof installedManifest !== "object") {
    throw new Error(`Installed package.json at "${manifestPath}" is not a valid JSON object.`);
  }

  if (installedManifest.name !== candidateIdentity.name) {
    throw new Error(`Installed package name mismatch: expected "${candidateIdentity.name}", received "${installedManifest.name}". Cannot accept unrelated package.`);
  }

  if (installedManifest.version !== candidateIdentity.version) {
    throw new Error(`Installed package version mismatch: expected "${candidateIdentity.version}", received "${installedManifest.version}".`);
  }

  /** @type {Record<string, string>} */
  const installedBin = {};
  if (typeof installedManifest.bin === "string") {
    const binName = installedManifest.name.startsWith("@") ? installedManifest.name.split("/")[1] ?? installedManifest.name : installedManifest.name;
    installedBin[binName] = installedManifest.bin;
  } else if (installedManifest.bin && typeof installedManifest.bin === "object") {
    for (const [key, value] of Object.entries(installedManifest.bin)) {
      if (typeof value === "string") {
        installedBin[key] = value;
      }
    }
  }

  const normalizeRel = (/** @type {unknown} */ p) => (typeof p === "string" ? p.replace(/^\.\//, "") : p);

  for (const [binName, expectedRelPath] of Object.entries(candidateIdentity.bin)) {
    if (normalizeRel(installedBin[binName]) !== normalizeRel(expectedRelPath)) {
      throw new Error(`Installed package.json bin mismatch for "${binName}": expected "${expectedRelPath}", received "${installedBin[binName]}".`);
    }

    const binLinkPath = join(consumerRoot, "node_modules", ".bin", binName);
    if (!existsSync(binLinkPath)) {
      throw new Error(`Installed bin executable missing: "${binLinkPath}".`);
    }

    const expectedTargetPath = resolve(installedPackageRoot, expectedRelPath);
    if (!existsSync(expectedTargetPath)) {
      throw new Error(`Expected bin target does not exist: "${expectedTargetPath}".`);
    }

    let resolvedBin;
    try {
      resolvedBin = realpathSync(binLinkPath);
    } catch (err) {
      throw new Error(`Could not resolve symlink for "${binLinkPath}": ${/** @type {Error} */ (err).message}`);
    }

    let resolvedTarget;
    try {
      resolvedTarget = realpathSync(expectedTargetPath);
    } catch (err) {
      throw new Error(`Could not resolve target path "${expectedTargetPath}": ${/** @type {Error} */ (err).message}`);
    }

    if (resolvedBin !== resolvedTarget) {
      throw new Error(`Installed bin binding mismatch for "${binName}": resolved to "${resolvedBin}", expected "${resolvedTarget}". Cannot accept unrelated package.`);
    }
  }

  return { installedPackageRoot, installedManifest };
}

/**
 * Executes the installed CLI --version and asserts it matches the expected version.
 *
 * @param {string} binPath
 * @param {string} expectedVersion
 * @param {string} cwd
 * @returns {string} Trimmed version output
 */
export function verifyCliVersion(binPath, expectedVersion, cwd) {
  const versionOutput = execFileSync(binPath, ["--version"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const trimmed = versionOutput.trim();
  if (trimmed !== expectedVersion) {
    throw new Error(`Packed CLI version mismatch: expected "${expectedVersion}", received "${trimmed}".`);
  }
  return trimmed;
}

/**
 * Computes sha256 hex digest of a file.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function computeTarballDigest(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Validates that frozen tarball bytes match freshly packed tarball bytes.
 *
 * @param {string} packedTarball
 * @param {string} frozenTarball
 */
export function verifyFrozenTarball(packedTarball, frozenTarball) {
  const packedDigest = computeTarballDigest(packedTarball);
  const frozenDigest = computeTarballDigest(frozenTarball);
  if (packedDigest !== frozenDigest) {
    throw new Error("Frozen artifact differs from qualified package bytes.");
  }
}

/**
 * Checks whether the current module is the main process entry point.
 *
 * @param {string} metaUrl
 * @returns {boolean}
 */
export function isMainScript(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(metaUrl) === resolve(process.argv[1]);
  }
}
