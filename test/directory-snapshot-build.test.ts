import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNative, hostArtifact, parseArguments, recognizedBuildTool, selectArtifact, sha256 } from "../tools/build-directory-snapshot-native.mjs";
import { join, resolve } from "node:path";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const command = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: command }));
const roots: string[] = [];
afterEach(() => {
  command.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkFixture() {
  const root = mkdtempSync(join(tmpdir(), "native-check-policy-"));
  roots.push(root);
  cpSync("native/directory-snapshot", join(root, "native/directory-snapshot"), { recursive: true });
  mkdirSync(join(root, "tools"));
  cpSync("tools/build-directory-snapshot-native.mjs", join(root, "tools/build-directory-snapshot-native.mjs"));
  const include = join(root, "headers");
  mkdirSync(include);
  const headers = { "js_native_api.h": "fixture", "node_api.h": "fixture", "node_version.h": `#define NODE_MAJOR_VERSION ${process.versions.node.split(".")[0]}\n` };
  const hash = createHash("sha256");
  for (const [name, bytes] of Object.entries(headers)) {
    writeFileSync(join(include, name), bytes);
    hash.update(name).update("\0").update(bytes).update("\0");
  }
  const compiler = join(root, "compiler");
  writeFileSync(compiler, "fixture compiler");
  const output = join(root, "output");
  mkdirSync(output);
  const binary = join(output, "native-addon-posix-openat-v1.node");
  const bytes = Buffer.from("fixture binary");
  writeFileSync(binary, bytes);
  const manifest = {
    ...JSON.parse(readFileSync("native/directory-snapshot/prebuilds/linux-x64-gnu/manifest.json", "utf8")),
    artifact: hostArtifact(), platform: process.platform, architecture: process.arch,
    libc: process.platform === "linux" ? "glibc" : null,
    artifactSha256: sha256(binary), artifactBytes: bytes.length,
    compiler: "fixture compiler", compilerExecutableSha256: sha256(compiler),
    nodeHeadersSha256: hash.digest("hex"), nodeVersion: process.version, nodeApiVersion: process.versions.napi,
  };
  const save = () => writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest));
  save();
  command.mockImplementation((name: string, args: string[]) => {
    if (name === "git") return { status: 0, stdout: bytes };
    if (args[0] === "--version") return { status: 0, stdout: "fixture compiler\n" };
    writeFileSync(args[args.indexOf("-o") + 1]!, bytes);
    return { status: 0, stdout: "" };
  });
  const check = (tracked = false, required = false) => buildNative(["--check", ...(required ? ["--require-reproducible"] : []), ...(tracked ? ["--check-tracked"] : []), "--compiler", compiler, "--node-include", include, "--output", output], root);
  return { root, binary, bytes, manifest, save, check };
}

describe("production native build contract", () => {
  it.each([
    ["darwin", "arm64", undefined, "darwin-arm64"],
    ["darwin", "x64", undefined, "darwin-x64"],
    ["linux", "arm64", "2.36", "linux-arm64-gnu"],
    ["linux", "x64", "2.36", "linux-x64-gnu"],
    ["linux", "arm64", undefined, undefined],
    ["linux", "x64", "", undefined],
    ["linux", "s390x", "2.36", undefined],
    ["win32", "x64", undefined, undefined],
  ])("selects only actual supported runtimes: %s %s", (platform, arch, glibc, expected) => {
    expect(selectArtifact(platform!, arch!, glibc)).toBe(expected);
  });
  it("rejects missing, unknown and ambiguous command inputs before compiling", () => {
    expect(() => parseArguments(["--compiler"])).toThrow("Missing value");
    expect(() => parseArguments(["--compiler", "--check"])).toThrow("Missing value");
    expect(() => buildNative(["--require-reproducible"])).toThrow("requires --check");
    expect(() => parseArguments(["--bogus"])).toThrow("Unknown argument");
    expect(() => buildNative(["--source-build"])).toThrow("explicit");
    expect(() => buildNative(["--source-build", "--compiler", "cc", "--node-include", "/missing", "--output", "/missing"])).toThrow("absolute");
  });
  it("rejects unsupported target overrides and unknown historical producers", () => {
    expect(() => buildNative(["--artifact", "windows-arm64"])).toThrow("exact executing");
    expect(() => recognizedBuildTool(resolve("."), "0".repeat(64))).toThrow("Unrecognized");
    expect(recognizedBuildTool(resolve("."), "a885da47c77aebbb18772f71b65e56888fea9a2453efd62a57bcc31319e36c91")).toBe("historical-v1");
  });
});

describe("retained integrity and conditional exact rebuild", () => {
  it("requires exact rebuilt bytes with matching explicit inputs", () => {
    const f = checkFixture();
    expect(f.check(true, true)).toMatchObject({ integrity: "passed", reproducibility: "passed", provenance: "historical-v2" });
    command.mockImplementation((_name: string, args: string[]) => {
      if (args[0] === "--version") return { status: 0, stdout: "fixture compiler" };
      writeFileSync(args[args.indexOf("-o") + 1]!, "different");
      return { status: 0, stdout: "" };
    });
    expect(() => f.check(false, true)).toThrow("Fresh build differs");
  });
  it.each(["compilerExecutableSha256", "nodeHeadersSha256", "compiler", "nodeVersion", "nodeApiVersion"])("reports exact rebuild unrun for differing %s", field => {
    const f = checkFixture();
    f.manifest[field] = "0".repeat(64); f.save();
    expect(f.check(true)).toMatchObject({ integrity: "passed", reproducibility: "not-applicable" });
    expect(() => f.check(true, true)).toThrow("Exact reproducibility required");
    expect(command.mock.calls.some(([, args]) => args.includes("-o"))).toBe(false);
    command.mockImplementation(() => ({ status: 0, stdout: Buffer.from("different tracked bytes") }));
    expect(() => f.check(true)).toThrow("Git-tracked artifact differs");
  });
  it("rejects tampering before a differing toolchain can skip rebuild", () => {
    const f = checkFixture();
    f.manifest.compilerExecutableSha256 = "0".repeat(64); f.save();
    writeFileSync(f.binary, "tampered");
    expect(() => f.check()).toThrow("integrity mismatch");
    expect(command).not.toHaveBeenCalled();
  });
  it.each(["nativeSourceSha256", "buildToolSha256", "artifactBytes", "backend", "abiVersion", "platform", "architecture", "artifact", "libc"])("rejects mismatched %s", field => {
    const f = checkFixture();
    f.manifest[field] = "invalid"; f.save();
    expect(() => f.check()).toThrow(/integrity mismatch|Unrecognized/);
  });
  it("authenticates archived producer bytes", () => {
    const f = checkFixture();
    writeFileSync(join(f.root, "native/directory-snapshot/build-tools/v2.mjs"), "tampered");
    expect(() => f.check()).toThrow("Unrecognized");
  });
  it("rejects incomplete explicit toolchain identity", () => {
    const f = checkFixture();
    f.manifest.compilerExecutableSha256 = null; f.save();
    expect(() => f.check()).toThrow("identity is incomplete");
  });
  it("preserves unconditional exact equality for historical manifests", () => {
    const f = checkFixture();
    delete f.manifest.sourceIdentity;
    delete f.manifest.compilerExecutableSha256;
    delete f.manifest.nodeHeadersSha256;
    f.manifest.buildToolSha256 = "a885da47c77aebbb18772f71b65e56888fea9a2453efd62a57bcc31319e36c91";
    f.save();
    expect(f.check()).toMatchObject({ provenance: "historical-v1", reproducibility: "passed" });
    command.mockImplementation((_name: string, args: string[]) => {
      writeFileSync(args[args.indexOf("-o") + 1]!, "different");
      return { status: 0, stdout: "" };
    });
    expect(() => f.check(false, true)).toThrow("Fresh build differs");
  });
});
