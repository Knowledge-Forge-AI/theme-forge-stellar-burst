// @ts-check

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, readFile, rename, writeFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_KEYRING_PATH = resolve(SCRIPT_DIR, "node-authenticity/active-keys.asc");
// Nebular declares the existing locked verifier as a package archive. Loading
// it never consults a private install tree; extracted tooling is disposable.
/** @type {Promise<typeof import("openpgp")> | undefined} */
let openpgpPromise;
async function loadOpenpgp() {
  if (openpgpPromise) return openpgpPromise;
  openpgpPromise = (async () => {
    const bindingPath = resolve(REPO_ROOT, "authenticated-inputs/tooling/binding.json");
    if (!existsSync(bindingPath)) return import("openpgp");
    const binding = JSON.parse(await readFile(bindingPath, "utf8"));
    const pkg = binding.packages?.find((/** @type {{name: string}} */ value) => value.name === "openpgp");
    if (binding.schema !== "tfsb.nebular-verification-tooling-v1" || pkg?.version !== "6.3.1" ||
        typeof pkg.filename !== "string" || basename(pkg.filename) !== pkg.filename || !/^[a-f0-9]{64}$/u.test(pkg.sha256)) {
      throw new Error("[NODE_AUTH_FAIL] Invalid declared OpenPGP tooling binding.");
    }
    const archive = resolve(REPO_ROOT, "authenticated-inputs/tooling-tarball", pkg.filename);
    if (sha256Hex(await readFile(archive)) !== pkg.sha256) throw new Error("[NODE_AUTH_FAIL] OpenPGP tooling archive digest mismatch.");
    const scratch = await mkdtemp(join(tmpdir(), "tfsb-node-verifier-"));
    try {
      execFileSync("tar", ["-xzf", archive, "-C", scratch], { stdio: "pipe" });
      const manifest = JSON.parse(await readFile(join(scratch, "package/package.json"), "utf8"));
      if (manifest.name !== "openpgp" || manifest.version !== pkg.version) throw new Error("[NODE_AUTH_FAIL] OpenPGP package identity mismatch.");
      return createRequire(import.meta.url)(join(scratch, "package"));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  })();
  return openpgpPromise;
}


export const EXPECTED_NODE_VERSION = "22.23.2";
export const EXPECTED_TARBALL_NAME = `node-v${EXPECTED_NODE_VERSION}-darwin-arm64.tar.gz`;
export const EXPECTED_TARBALL_SHA256 = "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6";
export const EXPECTED_EXECUTABLE_SHA256 = "18e387c90ab8a8400183e8bdd396376e1e875b91b4c874b894dcade7b35bf572";
export const EXPECTED_EXECUTABLE_SIZE = 112_937_728;

/** @type {Record<string, string>} */
export const OFFICIAL_RELEASERS = {
  "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356": "Antoine du Hamel <duhamelantoine1995@gmail.com>",
  "DD792F5973C6DE52C432CBDAC77ABFA00DDBF2B7": "Juan José Arboleda <soyjuanarbol@gmail.com>",
  "CC68F5A3106FF448322E48ED27F5E38D5B0A215F": "Marco Ippolito <marcoippolito54@gmail.com>",
  "890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4": "Rafael Gonzaga <rafael.nunu@hotmail.com>",
  "C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C": "Richard Lau <richard.lau@ibm.com>",
  "108F52B48DB57BB0CC439B2997B01419BD92F80A": "Ruy Adorno <ruyadorno@hotmail.com>",
  "655F3B5C1FB3FA8D1A0CA6BDE4A7D232B936D2FD": "Stewart X Addison <sxa@ibm.com>",
  "A363A499291CBBC940DD62E41F10027AF002F8B0": "Ulises Gascón <ulisesgascongonzalez@gmail.com>",
};

/** @param {Uint8Array | Buffer | string} bytes */
function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Load openpgp public keys from armored keyring text.
 * @param {string} armoredText
 */
export async function loadKeyring(armoredText) {
  const openpgp = await loadOpenpgp();
  const blocks = armoredText.split(/(?=-----BEGIN PGP PUBLIC KEY BLOCK-----)/u).filter(Boolean);
  const keys = await Promise.all(blocks.map((armoredKey) => openpgp.readKey({ armoredKey })));
  return keys;
}

/**
 * Verifies the authenticity of official Node release artifacts.
 * @param {object} options
 * @param {string} [options.keyringPath]
 * @param {string} [options.shasumsPath]
 * @param {string} [options.tarballPath]
 * @param {string} [options.executablePath]
 * @param {string} [options.outputNodePath]
 * @param {boolean} [options.offlineFixture]
 * @param {string} [options.downloadDir]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.version]
 */
export async function verifyNodeAuthenticity(options = {}) {
  const openpgp = await loadOpenpgp();
  const version = options.version ?? EXPECTED_NODE_VERSION;
  const tarballName = `node-v${version}-darwin-arm64.tar.gz`;

  const keyringPath = options.keyringPath ?? DEFAULT_KEYRING_PATH;
  const keyringText = await readFile(keyringPath, "utf8");
  const verificationKeys = await loadKeyring(keyringText);

  let shasumsPath = options.shasumsPath;
  let tarballPath = options.tarballPath;
  if (options.downloadDir) {
    const downloadDir = resolve(options.downloadDir);
    await mkdir(downloadDir, { recursive: true });
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const baseUrl = `https://nodejs.org/dist/v${version}`;
    const [manifestResponse, tarballResponse] = await Promise.all([
      fetchImpl(`${baseUrl}/SHASUMS256.txt.asc`, { redirect: "error" }),
      fetchImpl(`${baseUrl}/${tarballName}`, { redirect: "error" }),
    ]);
    if (!manifestResponse.ok || !tarballResponse.ok) {
      throw new Error(`[NODE_AUTH_FAIL] Official Node release download failed: manifest=${manifestResponse.status}, tarball=${tarballResponse.status}.`);
    }
    shasumsPath = join(downloadDir, "SHASUMS256.txt.asc");
    tarballPath = join(downloadDir, tarballName);
    await Promise.all([
      writeFile(shasumsPath, new Uint8Array(await manifestResponse.arrayBuffer())),
      writeFile(tarballPath, new Uint8Array(await tarballResponse.arrayBuffer())),
    ]);
  }

  let signedMessageText;
  if (shasumsPath) {
    signedMessageText = await readFile(shasumsPath, "utf8");
  } else if (options.offlineFixture) {
    const fixturePath = resolve(REPO_ROOT, "test/fixtures/node-v22.23.2/SHASUMS256.txt.asc");
    signedMessageText = await readFile(fixturePath, "utf8");
  } else {
    throw new Error("[NODE_AUTH_FAIL] Either shasumsPath or offlineFixture must be provided.");
  }

  // 1. Verify PGP cleartext signature
  const message = await openpgp.readCleartextMessage({ cleartextMessage: signedMessageText });
  const verificationResult = await openpgp.verify({ message, verificationKeys });
  const signature = verificationResult.signatures[0];
  if (!signature) {
    throw new Error("[NODE_AUTH_FAIL] No PGP signature found in SHASUMS256.txt.asc.");
  }
  try {
    await signature.verified;
  } catch (err) {
    throw new Error(`[NODE_AUTH_FAIL] PGP signature verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const keyIDHex = signature.keyID.toHex().toLowerCase();

  // Find key fingerprint among loaded keys
  let matchedFingerprint = "";
  let releaserName = "Unknown Releaser";
  for (const key of verificationKeys) {
    const primaryKeyId = key.getKeyID().toHex().toLowerCase();
    const subkeyIds = key.getSubkeys().map((k) => k.getKeyID().toHex().toLowerCase());
    if (primaryKeyId === keyIDHex || subkeyIds.includes(keyIDHex)) {
      matchedFingerprint = key.getFingerprint().toUpperCase();
      releaserName = OFFICIAL_RELEASERS[matchedFingerprint] ?? `Official Releaser (${matchedFingerprint})`;
      break;
    }
  }

  if (!matchedFingerprint) {
    throw new Error(`[NODE_AUTH_FAIL] Signature keyID '${keyIDHex}' does not match any known official Node.js releaser key.`);
  }

  // 2. Parse SHASUMS256 and find expected tarball entry
  const cleartext = message.getText();
  const lines = cleartext.split(/\r?\n/u);
  let shasumEntry = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.endsWith(`  ${tarballName}`) || trimmed.endsWith(` *${tarballName}`)) {
      shasumEntry = trimmed.split(/\s+/u)[0] ?? "";
      break;
    }
  }
  if (!shasumEntry) {
    throw new Error(`[NODE_AUTH_FAIL] ${tarballName} not found in verified SHASUMS256 content.`);
  }
  if (version === EXPECTED_NODE_VERSION && shasumEntry !== EXPECTED_TARBALL_SHA256) {
    throw new Error(`[NODE_AUTH_FAIL] ${tarballName} digest in SHASUMS '${shasumEntry}' does not match expected '${EXPECTED_TARBALL_SHA256}'.`);
  }

  // 3. Verify tarball bytes if provided
  let tarballSha = "";
  let executablePath = options.executablePath;
  if (tarballPath) {
    const tarballBytes = await readFile(tarballPath);
    tarballSha = sha256Hex(tarballBytes);
    if (tarballSha !== shasumEntry) {
      throw new Error(`[NODE_AUTH_FAIL] Tarball '${basename(tarballPath)}' SHA-256 '${tarballSha}' does not match verified checksum '${shasumEntry}'.`);
    }

    // If outputNodePath is specified, extract the binary from tarball
    if (options.outputNodePath) {
      await mkdir(dirname(options.outputNodePath), { recursive: true });
      const extractDir = dirname(options.outputNodePath);
      execFileSync("tar", [
        "-xzf",
        tarballPath,
        "-C",
        extractDir,
        "--strip-components=2",
        `node-v${version}-darwin-arm64/bin/node`,
      ]);
      const extractedPath = join(extractDir, "node");
      if (resolve(extractedPath) !== resolve(options.outputNodePath)) await rename(extractedPath, options.outputNodePath);
      await chmod(options.outputNodePath, 0o755);
      executablePath = options.outputNodePath;
    }
  }

  // 4. Verify node executable if available or passed
  let executableReceipt = null;
  if (executablePath) {
    const statInfo = await stat(executablePath);
    const execBytes = await readFile(executablePath);
    const execSha = sha256Hex(execBytes);

    if (version === EXPECTED_NODE_VERSION) {
      if (execSha !== EXPECTED_EXECUTABLE_SHA256) {
        throw new Error(`[NODE_AUTH_FAIL] Executable SHA-256 mismatch: got '${execSha}', expected '${EXPECTED_EXECUTABLE_SHA256}'.`);
      }
      if (statInfo.size !== EXPECTED_EXECUTABLE_SIZE) {
        throw new Error(`[NODE_AUTH_FAIL] Executable size mismatch: got ${statInfo.size}, expected ${EXPECTED_EXECUTABLE_SIZE}.`);
      }
    }

    executableReceipt = {
      filename: basename(executablePath),
      sha256: execSha,
      size: statInfo.size,
    };
  }

  const receipt = {
    schema: "tfsb.node-authenticity-receipt",
    schemaVersion: 1,
    status: "pass",
    verifiedAt: new Date().toISOString(),
    nodeVersion: version,
    target: "darwin-arm64",
    signature: {
      verified: true,
      keyId: keyIDHex,
      fingerprint: matchedFingerprint,
      releaser: releaserName,
    },
    shasums: {
      filename: "SHASUMS256.txt",
      tarballEntrySha256: shasumEntry,
    },
    tarball: tarballPath
      ? {
          filename: basename(tarballPath),
          sha256: tarballSha,
          verifiedAgainstShasums: true,
        }
      : null,
    executable: executableReceipt,
  };

  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  /** @type {Record<string, string>} */
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const current = args[i];
    const next = args[i + 1];
    if (current && current.startsWith("--") && next && !next.startsWith("--")) {
      parsed[current.slice(2)] = next;
      i++;
    } else if (current === "--offline-fixture") {
      parsed["offline-fixture"] = "true";
    }
  }

  /** @type {Record<string, any>} */
  const verifyOpts = {};
  if (parsed.keyring) verifyOpts.keyringPath = parsed.keyring;
  if (parsed.shasums) verifyOpts.shasumsPath = parsed.shasums;
  if (parsed.tarball) verifyOpts.tarballPath = parsed.tarball;
  if (parsed.executable) verifyOpts.executablePath = parsed.executable;
  if (parsed["output-node"]) verifyOpts.outputNodePath = parsed["output-node"];
  if (parsed["offline-fixture"] === "true") verifyOpts.offlineFixture = true;
  if (parsed["download-dir"]) verifyOpts.downloadDir = parsed["download-dir"];

  verifyNodeAuthenticity(verifyOpts)
    .then(async (receipt) => {
      const output = JSON.stringify(receipt, null, 2);
      if (parsed.output) {
        await mkdir(dirname(resolve(parsed.output)), { recursive: true });
        await writeFile(resolve(parsed.output), `${output}\n`, "utf8");
      }
      process.stdout.write(`${output}\n`);
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
