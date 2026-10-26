// @ts-check

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/u;
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA512 = /^sha512-[A-Za-z0-9+/]+=*$/u;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;

/** @param {Uint8Array} bytes @param {"sha1" | "sha256" | "sha512"} algorithm */
function digest(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest("hex");
}

/** @param {Uint8Array} bytes */
function integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** @param {string} path @param {number} maxBytes */
async function readStableRegularFile(path, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("[ROOT_ARTIFACT_FAIL] Invalid bounded input size.");
  // O_NOFOLLOW is available on the Unix runners and is deliberately used when
  // provided. Windows Node does not expose that Unix flag; the held descriptor
  // and before/after fstat checks still bind one stable regular file there.
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow, 0o600);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`[ROOT_ARTIFACT_FAIL] Input is not a regular file: ${path}`);
    if (!Number.isSafeInteger(before.size) || before.size <= 0 || before.size > maxBytes) {
      throw new Error(`[ROOT_ARTIFACT_FAIL] Input exceeds the bounded regular-file size: ${path}`);
    }
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== offset || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`[ROOT_ARTIFACT_FAIL] Input changed while reading: ${path}`);
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/** @param {string} path @param {Uint8Array} bytes */
async function writeNewFile(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new Error(`[ROOT_ARTIFACT_FAIL] Refusing to overwrite output '${path}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** @param {any} receipt @param {string} label */
function validateReceiptShape(receipt, label) {
  if (!receipt || typeof receipt !== "object" || receipt.schema !== "tfsb.ci-exact-head-receipt" || receipt.schemaVersion !== 1 || receipt.status !== "pass") {
    throw new Error(`[ROOT_ARTIFACT_FAIL] ${label} is not a passing exact-head receipt.`);
  }
  const event = receipt.event;
  const workflow = receipt.workflow;
  const checkout = receipt.checkout;
  if (!event || event.name !== "pull_request" || !["opened", "synchronize", "reopened"].includes(event.action) || !Number.isSafeInteger(event.number) ||
      typeof event.baseRef !== "string" || typeof event.baseSha !== "string" || typeof event.headRef !== "string" || typeof event.headSha !== "string" ||
      typeof event.repository !== "string" || typeof event.baseRepository !== "string" || typeof event.headRepository !== "string" ||
      !SHA1.test(event.baseSha) || !SHA1.test(event.headSha) || event.baseRef !== "main" || event.headRef !== "staging" ||
      event.repository !== event.baseRepository || event.repository !== event.headRepository) {
    throw new Error(`[ROOT_ARTIFACT_FAIL] ${label} has invalid PR source identity.`);
  }
  if (!workflow || typeof workflow !== "object" || typeof workflow.job !== "string" || workflow.job.length === 0 || typeof workflow.runId !== "string" || !/^\d+$/u.test(workflow.runId) ||
      typeof workflow.runAttempt !== "string" || !/^\d+$/u.test(workflow.runAttempt)) {
    throw new Error(`[ROOT_ARTIFACT_FAIL] ${label} has invalid run identity.`);
  }
  if (!checkout || checkout.role !== "merge-candidate" || typeof checkout.commit !== "string" || !SHA1.test(checkout.commit) ||
      typeof checkout.tree !== "string" || !SHA1.test(checkout.tree) || !Array.isArray(checkout.parents) || checkout.parents.length !== 2 ||
      !checkout.parents.every(/** @param {unknown} parent */ (parent) => typeof parent === "string" && SHA1.test(parent)) || checkout.clean !== true) {
    throw new Error(`[ROOT_ARTIFACT_FAIL] ${label} has invalid merge-candidate checkout identity.`);
  }
}

/** @param {any} receipt */
function sourceContext(receipt) {
  return {
    event: {
      name: receipt.event.name,
      action: receipt.event.action,
      number: receipt.event.number,
      baseRef: receipt.event.baseRef,
      baseSha: receipt.event.baseSha,
      headRef: receipt.event.headRef,
      headSha: receipt.event.headSha,
      repository: receipt.event.repository,
      baseRepository: receipt.event.baseRepository,
      headRepository: receipt.event.headRepository,
    },
    workflow: { runId: receipt.workflow.runId, runAttempt: receipt.workflow.runAttempt },
    checkout: { role: receipt.checkout.role, commit: receipt.checkout.commit, tree: receipt.checkout.tree, parents: receipt.checkout.parents, clean: receipt.checkout.clean },
  };
}

/**
 * @param {Map<string, {path?: unknown, size?: unknown, sha256?: unknown}>} listed
 * @param {string} required
 * @returns {{size: number, sha256: string}}
 */
function requireArtifactEntry(listed, required) {
  const item = listed.get(required);
  if (!item || typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size <= 0 || typeof item.sha256 !== "string" || !SHA256.test(item.sha256)) {
    throw new Error(`[ROOT_ARTIFACT_FAIL] Canonical root manifest is missing or invalid: ${required}`);
  }
  return { size: item.size, sha256: item.sha256 };
}

/** @param {string} path */
async function readJsonFile(path) {
  const bytes = await readStableRegularFile(path, MAX_JSON_BYTES);
  try {
    return { bytes, value: JSON.parse(Buffer.from(bytes).toString("utf8")) };
  } catch (error) {
    throw new Error(`[ROOT_ARTIFACT_FAIL] Invalid JSON '${path}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Authenticate and copy the canonical root package produced by the root-package job.
 * @param {{inputDir: string, consumerReceiptPath: string, outputPath: string, manifestOutputPath: string}} options
 */
export async function authenticateRootPackageArtifact(options) {
  const inputDir = resolve(options.inputDir);
  const consumerReceiptPath = resolve(options.consumerReceiptPath);
  const outputPath = resolve(options.outputPath);
  const manifestOutputPath = resolve(options.manifestOutputPath);
  if (basename(outputPath) !== "root-package.tgz" || basename(manifestOutputPath) !== "root-pack-manifest.json") {
    throw new Error("[ROOT_ARTIFACT_FAIL] Canonical root outputs must be root-package.tgz and root-pack-manifest.json.");
  }

  const manifestPath = join(inputDir, "artifact-manifest.json");
  const producerReceiptPath = join(inputDir, "receipt.json");
  const archivePath = join(inputDir, "root-package.tgz");
  const packManifestPath = join(inputDir, "pack-manifest.json");
  const producerManifestInput = await readJsonFile(manifestPath);
  const producerReceiptInput = await readJsonFile(producerReceiptPath);
  const consumerReceiptInput = await readJsonFile(consumerReceiptPath);
  const packManifestInput = await readJsonFile(packManifestPath);
  const producerManifest = producerManifestInput.value;
  const producerReceipt = producerReceiptInput.value;
  const consumerReceipt = consumerReceiptInput.value;
  const packManifest = packManifestInput.value;
  validateReceiptShape(producerReceipt, "producer receipt");
  validateReceiptShape(consumerReceipt, "consumer receipt");
  if (producerReceipt.workflow.job !== "root-package") throw new Error("[ROOT_ARTIFACT_FAIL] Producer receipt is not from root-package job.");
  if (sourceContext(producerReceipt).event.repository !== sourceContext(consumerReceipt).event.repository ||
      JSON.stringify(sourceContext(producerReceipt)) !== JSON.stringify(sourceContext(consumerReceipt))) {
    throw new Error("[ROOT_ARTIFACT_FAIL] Canonical root receipt is not bound to this run, attempt, source, or checkout.");
  }
  if (!producerManifest || producerManifest.schema !== "tfsb.ci-job-artifact-manifest" || producerManifest.schemaVersion !== 1 || producerManifest.status !== "pass" || producerManifest.job !== "root-package" || !Array.isArray(producerManifest.artifacts)) {
    throw new Error("[ROOT_ARTIFACT_FAIL] Canonical root artifact manifest is invalid.");
  }
  /** @type {Array<{path?: unknown, size?: unknown, sha256?: unknown}>} */
  const artifactEntries = producerManifest.artifacts;
  /** @type {Map<string, {path?: unknown, size?: unknown, sha256?: unknown}>} */
  const listed = new Map();
  for (const artifact of artifactEntries) {
    if (typeof artifact.path === "string") listed.set(artifact.path, artifact);
  }
  const archiveEntry = requireArtifactEntry(listed, "root-package.tgz");
  const packEntry = requireArtifactEntry(listed, "pack-manifest.json");
  const receiptEntry = requireArtifactEntry(listed, "receipt.json");
  const archive = await readStableRegularFile(archivePath, MAX_ARCHIVE_BYTES);
  const archiveSha256 = digest(archive, "sha256");
  const archiveSha1 = digest(archive, "sha1");
  const archiveIntegrity = integrity(archive);
  if (archive.length !== archiveEntry.size || archiveSha256 !== archiveEntry.sha256 || packManifestInput.bytes.length !== packEntry.size || digest(packManifestInput.bytes, "sha256") !== packEntry.sha256 || producerReceiptInput.bytes.length !== receiptEntry.size || digest(producerReceiptInput.bytes, "sha256") !== receiptEntry.sha256) {
    throw new Error("[ROOT_ARTIFACT_FAIL] Canonical root producer manifest digest or size mismatch.");
  }
  if (!Array.isArray(packManifest) || packManifest.length !== 1 || !packManifest[0] || packManifest[0].size !== archive.length || packManifest[0].shasum !== archiveSha1 || packManifest[0].integrity !== archiveIntegrity || !SHA1.test(packManifest[0].shasum) || !SHA512.test(packManifest[0].integrity)) {
    throw new Error("[ROOT_ARTIFACT_FAIL] Canonical root pack manifest SRI does not describe the authenticated archive.");
  }
  await writeNewFile(outputPath, archive);
  await writeNewFile(manifestOutputPath, packManifestInput.bytes);
  return { status: "pass", archiveSize: archive.length, archiveSha256, archiveSha1, archiveIntegrity };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const values = new Map();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value || !["--input", "--consumer-receipt", "--output", "--manifest-output"].includes(flag) || values.has(flag)) throw new Error("[ROOT_ARTIFACT_FAIL] Invalid arguments.");
    values.set(flag, value);
  }
  if (values.size !== 4) throw new Error("[ROOT_ARTIFACT_FAIL] --input, --consumer-receipt, --output, and --manifest-output are required.");
  authenticateRootPackageArtifact({ inputDir: values.get("--input"), consumerReceiptPath: values.get("--consumer-receipt"), outputPath: values.get("--output"), manifestOutputPath: values.get("--manifest-output") })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
