#!/usr/bin/env node
// @ts-check
import { copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recognizedBuildTool, sha256 } from "./build-directory-snapshot-native.mjs";

export const requiredTargets = ["darwin-arm64", "linux-arm64-gnu", "linux-x64-gnu"];
export const preservedTargets = ["darwin-x64"];

/** Read the binary header, never infer architecture from a filename.
 * @param {Buffer} bytes
 */
export function binaryTarget(bytes) {
  if (bytes.length < 64) throw new Error("Truncated native binary");
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    if (bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(16) !== 3) throw new Error("Expected little-endian ELF64 shared library");
    if (bytes.readUInt16LE(18) === 183) return "linux-arm64-gnu";
    if (bytes.readUInt16LE(18) === 62) return "linux-x64-gnu";
  } else if (bytes.readUInt32LE(0) === 0xfeedfacf) {
    if (bytes.readUInt32LE(4) === 0x0100000c) return "darwin-arm64";
    if (bytes.readUInt32LE(4) === 0x01000007) return "darwin-x64";
  }
  throw new Error("Unsupported native binary architecture");
}

/** Validate all payloads and optionally assemble target-labelled reference assets.
 * Runtime loading and installed qualification remain separate requirements.
 * @param {string} root @param {string | undefined} [output]
 */
export function assembleNative(root, output) {
  const records = [...requiredTargets, ...preservedTargets].map(target => {
    const directory = join(root, "native/directory-snapshot/prebuilds", target);
    const binary = join(directory, "native-addon-posix-openat-v1.node");
    const manifestPath = join(directory, "manifest.json");
    if (!lstatSync(binary).isFile() || !lstatSync(manifestPath).isFile() || lstatSync(directory).isSymbolicLink()) throw new Error("Native inputs must be regular contained files");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const [platform, architecture] = target.split("-");
    if (binaryTarget(readFileSync(binary)) !== target || manifest.artifact !== target || manifest.platform !== platform || manifest.architecture !== architecture
      || manifest.libc !== (platform === "linux" ? "glibc" : null) || manifest.backend !== "native-addon-posix-openat-v1" || manifest.abiVersion !== 1
      || manifest.artifactSha256 !== sha256(binary) || manifest.artifactBytes !== lstatSync(binary).size
      || manifest.nativeSourceSha256 !== sha256(join(root, "native/directory-snapshot/src/directory_snapshot.c"))) throw new Error(`Native payload identity mismatch: ${target}`);
    const producer = recognizedBuildTool(root, manifest.buildToolSha256);
    return { target, binary, manifestPath, producer, sha256: sha256(binary), bytes: lstatSync(binary).size, manifestSha256: sha256(manifestPath) };
  });
  const receipt = { schema: "tfsb.native-release-assembly-v1", published: false,
    artifacts: records.map(({ target, producer, sha256: digest, bytes, manifestSha256 }) => ({ target, producer, sha256: digest, bytes, manifestSha256 })) };
  if (output) {
    mkdirSync(output, { recursive: true });
    for (const record of records) {
      copyFileSync(record.binary, join(output, `burst-${record.target}.node`));
      copyFileSync(record.manifestPath, join(output, `burst-${record.target}.manifest.json`));
    }
    writeFileSync(join(output, "native-artifacts.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === "--output")) throw new Error("Usage: assemble-burst-native.mjs [--output DIR]");
    console.log(JSON.stringify(assembleNative(resolve("."), args[1]), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
