import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assembleNative, binaryTarget } from "../tools/assemble-burst-native.mjs";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "burst-assembly-"));
  roots.push(root);
  cpSync("native/directory-snapshot", join(root, "native/directory-snapshot"), { recursive: true });
  cpSync("tools/build-directory-snapshot-native.mjs", join(root, "tools/build-directory-snapshot-native.mjs"), { recursive: true });
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("authentic Burst release payload assembly", () => {
  it("carries three required binaries and preserves Intel macOS", () => {
    const receipt = assembleNative(resolve("."));
    expect(receipt.artifacts.map(x => x.target)).toEqual(["darwin-arm64", "linux-arm64-gnu", "linux-x64-gnu", "darwin-x64"]);
    expect(receipt.published).toBe(false);
  });
  it("rejects foreign architecture and malformed binaries", () => {
    expect(() => binaryTarget(Buffer.from("fake"))).toThrow("Truncated");
    const root = fixture();
    const base = join(root, "native/directory-snapshot/prebuilds");
    cpSync(join(base, "linux-x64-gnu/native-addon-posix-openat-v1.node"), join(base, "linux-arm64-gnu/native-addon-posix-openat-v1.node"));
    expect(() => assembleNative(root)).toThrow("identity mismatch");
  });
  it("rejects provenance tampering without changing old manifests", () => {
    const root = fixture();
    const path = join(root, "native/directory-snapshot/prebuilds/darwin-x64/manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.buildToolSha256 = "0".repeat(64);
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => assembleNative(root)).toThrow("Unrecognized");
  });
  it("accepts the exact ADDON1-qualified AMD64 payload and manifest", () => {
    const record = assembleNative(resolve(".")).artifacts.find(x => x.target === "linux-x64-gnu");
    expect(record).toMatchObject({ producer: "historical-v2", bytes: 27240,
      sha256: "a2999fc9ac1b1f0a31600595f7069e10aadb032f01059b4d7e64ed80cd8a38a8",
      manifestSha256: "aa60f4655cfe03abba8b85b3ab74bf9c20f1131c7bbc7dfcddc96941f5315b84" });
  });
  it("rejects corruption of the qualified AMD64 candidate", () => {
    const root = fixture();
    const path = join(root, "native/directory-snapshot/prebuilds/linux-x64-gnu/native-addon-posix-openat-v1.node");
    const bytes = readFileSync(path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    writeFileSync(path, bytes);
    expect(() => assembleNative(root)).toThrow("identity mismatch");
  });
});
