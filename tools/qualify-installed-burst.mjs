#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { isMainScript } from "./package-qualification-identity.mjs";

export const SUPPORTED_ARTIFACTS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64-gnu",
  "linux-arm64-gnu",
]);

/**
 * Resolves the platform artifact tuple for the given OS platform and architecture.
 * Correctly maps Linux ARM64 to linux-arm64-gnu and Linux x64 to linux-x64-gnu,
 * as well as Darwin arm64 and x64 architectures.
 *
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {string} One of SUPPORTED_ARTIFACTS or "none"
 */
export function resolvePlatformArtifact(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64-gnu";
  if (platform === "linux" && arch === "x64") return "linux-x64-gnu";
  return "none";
}

/**
 * Checks whether an artifact string is a recognized supported artifact.
 *
 * @param {string} artifact
 * @returns {boolean}
 */
export function isSupportedArtifact(artifact) {
  return SUPPORTED_ARTIFACTS.includes(/** @type {any} */ (artifact));
}

/**
 * Terminates a process group or child process safely.
 *
 * @param {import("node:child_process").ChildProcess | { pid?: number | null, killed?: boolean, exitCode?: number | null } | null | undefined} [child]
 * @param {NodeJS.Signals | number} [signal]
 */
export function killProcessGroup(child, signal = "SIGTERM") {
  if (!child || child.killed || (child.exitCode !== null && child.exitCode !== undefined)) return;
  try {
    if (child.pid && process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else if (typeof /** @type {any} */ (child).kill === "function") {
      /** @type {any} */ (child).kill(signal);
    }
  } catch {
    try {
      if (typeof /** @type {any} */ (child).kill === "function") {
        /** @type {any} */ (child).kill(signal);
      }
    } catch {
      // Process already terminated
    }
  }
}

/**
 * Executes a command with bounded execution time, bounded output collection,
 * and automatic process group cleanup on failure or timeout.
 *
 * @param {string} executable
 * @param {string[]} args
 * @param {{
 *   cwd?: string,
 *   timeoutMs?: number,
 *   maxOutputBytes?: number,
 *   nodePath?: string,
 *   env?: Record<string, string>,
 * }} [options]
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
export function runBoundedCommand(executable, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxOutputBytes = options.maxOutputBytes ?? 10_000_000;

  let bin = executable;
  let cmdArgs = [...args];
  if (executable.endsWith(".js") || executable.endsWith(".mjs")) {
    bin = options.nodePath ?? process.execPath;
    cmdArgs = [executable, ...args];
  }

  /** @type {import("node:child_process").SpawnSyncOptionsWithStringEncoding & { detached?: boolean }} */
  const spawnSyncOpts = {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: maxOutputBytes,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env ? { ...process.env, ...options.env } : process.env,
  };
  const result = spawnSync(
    bin,
    cmdArgs,
    /** @type {import("node:child_process").SpawnSyncOptionsWithStringEncoding} */ (spawnSyncOpts),
  );
  // Terminate descendants too, including helpers that outlived their leader.
  killProcessGroup(/** @type {any} */ ({ pid: result.pid }), "SIGKILL");
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
}

/**
 * Creates an in-memory recursive snapshot of a directory mapping relative paths
 * to file sizes and SHA-256 hex digests.
 *
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {Record<string, { size: number, sha256: string }>}
 */
export function takeDirectorySnapshot(dir, prefix = "") {
  /** @type {Record<string, { size: number, sha256: string }>} */
  const entries = {};
  if (!existsSync(dir)) return entries;
  const items = readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) =>
    Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
  );
  for (const item of items) {
    const rel = prefix === "" ? item.name : `${prefix}/${item.name}`;
    const full = join(dir, rel);
    if (item.isDirectory()) {
      Object.assign(entries, takeDirectorySnapshot(dir, rel));
    } else if (item.isFile()) {
      const buf = readFileSync(full);
      entries[rel] = {
        size: statSync(full).size,
        sha256: createHash("sha256").update(buf).digest("hex"),
      };
    }
  }
  return entries;
}

/**
 * Compares two directory snapshots for exact size and SHA-256 equivalence.
 *
 * @param {Record<string, { size: number, sha256: string }>} before
 * @param {Record<string, { size: number, sha256: string }>} after
 * @returns {boolean}
 */
export function compareDirectorySnapshots(before, after) {
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  if (beforeKeys.length !== afterKeys.length) return false;
  for (let i = 0; i < beforeKeys.length; i++) {
    const key = beforeKeys[i];
    if (key === undefined || key !== afterKeys[i]) return false;
    const b = before[key];
    const a = after[key];
    if (!b || !a || b.size !== a.size || b.sha256 !== a.sha256) return false;
  }
  return true;
}

/**
 * Creates a minimal valid project fixture inside projectDir containing
 * .tfsb/project.toml and assets alpha.toml and beta.toml.
 *
 * @param {string} projectDir
 */
export function createTestFixtureProject(projectDir) {
  mkdirSync(join(projectDir, ".tfsb", "assets"), { recursive: true });
  writeFileSync(
    join(projectDir, ".tfsb", "project.toml"),
    `schema_version = 1
name = "Installed qualification"

[build]
directory = "dist"

[[install]]
asset = "alpha"
destinations = ["installed/alpha.svg"]

[[install]]
asset = "beta"
destinations = ["installed/beta.svg"]
`,
  );

  /**
   * @param {string} id
   * @param {string} title
   */
  const asset = (id, title) => `schema_version = 1
id = ${JSON.stringify(id)}
filename = ${JSON.stringify(`${id}.svg`)}

[canvas]
view_box = "0 0 24 24"

[accessibility]
title = ${JSON.stringify(title)}
title_id = "title"
description = "Deterministic qualification asset."
description_id = "description"

[[elements]]
type = "path"
d = "M 0 0 H 24 V 24 Z"
`;

  writeFileSync(join(projectDir, ".tfsb", "assets", "alpha.toml"), asset("alpha", "Alpha"));
  writeFileSync(join(projectDir, ".tfsb", "assets", "beta.toml"), asset("beta", "Beta"));
}

/**
 * Asynchronous JSON-RPC client connected to an installed tfsb-studio-service process
 * with finite timeouts, bounded stderr capture, and process group lifecycle control.
 */
export class InstalledServiceClient {
  /**
   * @param {string} executable
   * @param {string[]} [extraArgs]
   * @param {{ cwd?: string, timeoutMs?: number, nodePath?: string }} [options]
   */
  constructor(executable, extraArgs = [], options = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    /** @type {any[]} */
    this.messages = [];
    /** @type {any[]} */
    this.allMessages = [];
    /** @type {Array<() => void>} */
    this.waiters = [];
    this.stderr = "";
    this.closed = false;
    /** @type {number | null} */
    this.exitCode = null;

    let bin = executable;
    let args = [...extraArgs];
    if (executable.endsWith(".js") || executable.endsWith(".mjs")) {
      bin = options.nodePath ?? process.execPath;
      args = [executable, ...extraArgs];
    }

    this.child = spawn(bin, args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.pid = this.child.pid;

    let outputBytes = 0;
    this.child.stdout.on("data", chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 1_000_000) void this.kill("SIGKILL");
    });
    this.child.on("error", () => {
      this.closed = true;
      void this.kill("SIGKILL");
      for (const done of this.waiters.splice(0)) done();
    });
    this.child.stdin.on("error", () => { void this.kill("SIGKILL"); });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const parsed = JSON.parse(line);
        this.messages.push(parsed);
        this.allMessages.push(parsed);
        const waiters = this.waiters.splice(0);
        for (const done of waiters) done();
      } catch {
        // Drop unparseable non-JSON output
      }
    });

    this.child.stderr.on("data", (chunk) => {
      if (this.stderr.length < 1_000_000) {
        this.stderr += chunk.toString("utf8");
      }
    });

    this.child.once("close", (code) => {
      this.closed = true;
      this.exitCode = code;
      const waiters = this.waiters.splice(0);
      for (const done of waiters) done();
    });
  }

  /**
   * Terminates the service and ensures its process group is cleaned up.
   *
   * @param {NodeJS.Signals | number} [signal]
   * @returns {Promise<void>}
   */
  async kill(signal = "SIGKILL") {
    killProcessGroup(this.child, signal);
    if (this.pid) {
      killProcessGroup({ pid: this.pid }, signal);
    }
    if (this.closed) return;
    await new Promise((resolve) => {
      if (this.closed) return resolve(undefined);
      const timer = setTimeout(() => resolve(undefined), 2000);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }

  /** @param {unknown} value */
  send(value) {
    if (this.child.stdin.writable) {
      this.child.stdin.write(`${JSON.stringify(value)}\n`);
    }
  }

  /**
   * Waits for a response message with matching id within timeout.
   *
   * @param {string | number} id
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  async response(id, timeoutMs = this.timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(
        (msg) => msg && typeof msg === "object" && msg.id === id,
      );
      if (index >= 0) {
        return this.messages.splice(index, 1)[0];
      }
      if (this.closed) {
        throw new Error(
          `Service process exited unexpectedly with code ${this.exitCode} while waiting for response ${id}`,
        );
      }
      await new Promise((resolve, reject) => {
        const remaining = Math.max(1, deadline - Date.now());
        const timer = setTimeout(() => {
          reject(new Error(`Service response timeout waiting for message id: ${id}`));
        }, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
    }
    throw new Error(`Service response timeout waiting for message id: ${id}`);
  }

  /**
   * Sends a request and awaits response.
   *
   * @param {string | number} id
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  async call(id, method, params, timeoutMs) {
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.response(id, timeoutMs);
  }

  /**
   * Initializes the session negotiating the requested protocol version and notifies initialized.
   *
   * @param {string} [version]
   * @returns {Promise<{ nonce: string, result: any }>}
   */
  async initialize(version = "1.0") {
    const res = await this.call(`init-${version}`, "initialize", {
      protocol: "tfsb.studio",
      minVersion: version,
      maxVersion: version,
      client: { name: "installed-burst-qualification", version: "1.0.0" },
      capabilities: { progress: false, cancellation: true },
    });
    if (res?.error !== undefined || res?.result === undefined) {
      throw new Error(`Service initialize ${version} failed: ${JSON.stringify(res?.error)}`);
    }
    const { sessionNonce, selectedVersion, protocol } = res.result;
    if (protocol !== "tfsb.studio" || selectedVersion !== version) {
      throw new Error(
        `Service initialize protocol negotiation mismatch: expected ${version}, got ${selectedVersion}`,
      );
    }
    if (typeof sessionNonce !== "string" || !sessionNonce) {
      throw new Error("Service initialize did not return a valid session nonce");
    }
    this.send({ jsonrpc: "2.0", method: "initialized", params: { sessionNonce } });
    return { nonce: sessionNonce, result: res.result };
  }

  /**
   * Sends shutdown request, exit notification, and waits for clean exit zero.
   *
   * @param {string} nonce
   * @returns {Promise<{ exitCode: number | null, stderr: string }>}
   */
  async shutdown(nonce) {
    const res = await this.call("shutdown", "shutdown", { sessionNonce: nonce });
    if (res?.error !== undefined || res?.result === undefined) {
      throw new Error(`Service shutdown failed: ${JSON.stringify(res?.error)}`);
    }
    this.send({ jsonrpc: "2.0", method: "exit", params: {} });
    this.child.stdin.end();

    const exitCode = await new Promise((resolve, reject) => {
      if (this.closed) return resolve(this.exitCode);
      const timer = setTimeout(() => {
        void this.kill("SIGKILL");
        reject(new Error("Service exit timeout after shutdown"));
      }, this.timeoutMs);
      this.child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    if (exitCode !== 0) {
      throw new Error(`Service exited with non-zero code ${exitCode}. Stderr: ${this.stderr}`);
    }
    await this.kill("SIGKILL");
    return { exitCode, stderr: this.stderr };
  }
}

/**
 * Exercises the installed service across protocol versions 1.0, 1.1, and 1.2
 * verifying initialize, initialized, project.open, asset.list, asset.get, shutdown,
 * and exit zero, and asserting the fixture remains unchanged.
 *
 * @param {string} serviceExecutable
 * @param {string} fixtureDir
 * @param {{ cwd?: string, timeoutMs?: number, nodePath?: string }} [options]
 * @returns {Promise<{ versions: Record<string, unknown>, fixtureUnchanged: boolean }>}
 */
export async function qualifyInstalledService(serviceExecutable, fixtureDir, options = {}) {
  const versions = ["1.0", "1.1", "1.2"];
  /** @type {Record<string, unknown>} */
  const results = {};
  const snapshotBefore = takeDirectorySnapshot(fixtureDir);

  for (const version of versions) {
    const client = new InstalledServiceClient(serviceExecutable, [], {
      cwd: options.cwd ?? dirname(fixtureDir),
      timeoutMs: options.timeoutMs ?? 10_000,
      nodePath: options.nodePath ?? process.execPath,
    });

    try {
      // 1. initialize & initialized
      const { nonce } = await client.initialize(version);

      // 2. project.open
      const openRes = await client.call(`open-${version}`, "project.open", {
        sessionNonce: nonce,
        path: fixtureDir,
      });
      if (openRes?.error || !openRes?.result?.projectHandle) {
        throw new Error(`Service project.open failed (${version}): ${JSON.stringify(openRes?.error)}`);
      }
      const projectHandle = openRes.result.projectHandle;

      // 3. asset.list
      const listRes = await client.call(`list-${version}`, "asset.list", {
        sessionNonce: nonce,
        scope: { kind: "project", projectHandle },
        pageSize: 64,
      });
      if (listRes?.error || !listRes?.result?.page) {
        throw new Error(`Service asset.list failed (${version}): ${JSON.stringify(listRes?.error)}`);
      }

      // 4. asset.get
      const getRes = await client.call(`get-${version}`, "asset.get", {
        sessionNonce: nonce,
        scope: { kind: "project", projectHandle, assetId: "alpha" },
      });
      if (getRes?.error || getRes?.result?.assetId !== "alpha" || !getRes?.result?.canonicalSvg) {
        throw new Error(`Service asset.get failed (${version}): ${JSON.stringify(getRes?.error)}`);
      }

      // 5. shutdown & exit 0
      const shutdownResult = await client.shutdown(nonce);

      results[version] = {
        version,
        initialized: true,
        projectOpen: true,
        assetList: true,
        assetGet: true,
        shutdown: true,
        exitZero: shutdownResult.exitCode === 0,
      };
    } catch (err) {
      await client.kill("SIGKILL");
      throw err;
    } finally {
      await client.kill("SIGKILL");
    }
  }

  const snapshotAfter = takeDirectorySnapshot(fixtureDir);
  const fixtureUnchanged = compareDirectorySnapshots(snapshotBefore, snapshotAfter);
  if (!fixtureUnchanged) {
    throw new Error("Service qualification mutated the fixture project directory.");
  }

  return {
    versions: results,
    fixtureUnchanged: true,
  };
}

/**
 * Tests actual installed CLI version, help, deterministic valid SVG compilation,
 * malformed rejection, and prior-output preservation.
 *
 * @param {string} cliExecutable
 * @param {string} fixtureDir
 * @param {{ timeoutMs?: number, nodePath?: string }} [options]
 * @returns {Promise<{
 *   version: string,
 *   help: boolean,
 *   deterministicSvg: boolean,
 *   svgDigest: string,
 *   malformedRejection: boolean,
 *   priorOutputPreserved: boolean,
 * }>}
 */
export async function qualifyInstalledCli(cliExecutable, fixtureDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const nodePath = options.nodePath ?? process.execPath;

  // 1. CLI version and help
  const versionRes = runBoundedCommand(cliExecutable, ["--version"], { timeoutMs, nodePath });
  if (versionRes.status !== 0) {
    throw new Error(`CLI --version failed with exit code ${versionRes.status}: ${versionRes.stderr}`);
  }
  const versionStr = versionRes.stdout.trim();
  if (!/^\d+\.\d+\.\d+/.test(versionStr)) {
    throw new Error(`CLI --version returned unexpected output: "${versionStr}"`);
  }

  const helpRes = runBoundedCommand(cliExecutable, ["--help"], { timeoutMs, nodePath });
  if (helpRes.status !== 0) {
    throw new Error(`CLI --help failed with exit code ${helpRes.status}: ${helpRes.stderr}`);
  }
  if (!helpRes.stdout.includes("Usage:") && !helpRes.stdout.includes("tfsb")) {
    throw new Error("CLI --help returned unexpected output.");
  }

  // 2. Deterministic valid SVG compile twice
  const projectDir = join(fixtureDir, "cli-project");
  createTestFixtureProject(projectDir);

  const build1 = runBoundedCommand(cliExecutable, ["build", "--root", projectDir], { timeoutMs, nodePath });
  if (build1.status !== 0) {
    throw new Error(`CLI build run 1 failed with exit code ${build1.status}: ${build1.stderr}`);
  }
  const builtSvgPath = join(projectDir, "dist", "alpha.svg");
  if (!existsSync(builtSvgPath)) {
    throw new Error(`CLI build did not create expected output: ${builtSvgPath}`);
  }
  const digest1 = createHash("sha256").update(readFileSync(builtSvgPath)).digest("hex");

  const build2 = runBoundedCommand(cliExecutable, ["build", "--root", projectDir], { timeoutMs, nodePath });
  if (build2.status !== 0) {
    throw new Error(`CLI build run 2 failed with exit code ${build2.status}: ${build2.stderr}`);
  }
  const digest2 = createHash("sha256").update(readFileSync(builtSvgPath)).digest("hex");
  if (digest1 !== digest2) {
    throw new Error(`CLI build is not deterministic: digest mismatch ${digest1} !== ${digest2}`);
  }

  // 3. Malformed rejection and prior-output preservation
  const alphaTomlPath = join(projectDir, ".tfsb", "assets", "alpha.toml");
  const validToml = readFileSync(alphaTomlPath, "utf8");
  writeFileSync(alphaTomlPath, "schema_version = 1\n[[malformed_elements]]\n<<<syntax-error>>>");

  const buildMalformed = runBoundedCommand(cliExecutable, ["build", "--root", projectDir], { timeoutMs, nodePath });
  if (buildMalformed.status === 0) {
    throw new Error("CLI build should have failed for malformed asset, but succeeded.");
  }
  if (!existsSync(builtSvgPath)) {
    throw new Error(`CLI build deleted prior output upon error: ${builtSvgPath}`);
  }
  const digestAfterMalformed = createHash("sha256").update(readFileSync(builtSvgPath)).digest("hex");
  if (digestAfterMalformed !== digest1) {
    throw new Error(`CLI build corrupted prior output upon error: ${digestAfterMalformed} !== ${digest1}`);
  }

  // Restore valid TOML
  writeFileSync(alphaTomlPath, validToml);

  return {
    version: versionStr,
    help: true,
    deterministicSvg: true,
    svgDigest: digest1,
    malformedRejection: true,
    priorOutputPreserved: true,
  };
}

/**
 * Validates installed native loader, self-test, and prebuild manifest target diagnostics.
 *
 * @param {string} packageRoot
 * @param {{ timeoutMs?: number, nodePath?: string }} [options]
 * @returns {Promise<{
 *   targetArtifact: string,
 *   manifest: Record<string, unknown>,
 *   loader: Record<string, unknown>,
 * }>}
 */
export async function qualifyInstalledLoaderAndManifest(packageRoot, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const nodePath = options.nodePath ?? process.execPath;
  const targetArtifact = resolvePlatformArtifact(process.platform, process.arch);

  // 1. Manifest target diagnostics
  let manifest = null;
  /** @type {Record<string, unknown>} */
  const manifestDiagnostics = {
    targetArtifact,
    supported: isSupportedArtifact(targetArtifact),
    manifestFound: false,
    manifestValid: false,
    artifactFileFound: false,
    artifactValid: false,
    reason: null,
  };

  const manifestCandidates = [
    join(packageRoot, "native", "directory-snapshot", "prebuilds", targetArtifact, "manifest.json"),
  ];
  const manifestPath = manifestCandidates.find((p) => existsSync(p));

  if (manifestPath) {
    manifestDiagnostics.manifestFound = true;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (
        manifest?.schemaVersion === 1 &&
        manifest?.backend === "native-addon-posix-openat-v1" &&
        manifest?.abiVersion === 1 &&
        manifest?.artifact === targetArtifact
      ) {
        manifestDiagnostics.manifestValid = true;
      } else {
        manifestDiagnostics.reason = "manifest-schema-mismatch";
      }
    } catch {
      manifestDiagnostics.reason = "manifest-unreadable";
    }

    const artifactPath = join(dirname(manifestPath), "native-addon-posix-openat-v1.node");
    if (existsSync(artifactPath)) {
      manifestDiagnostics.artifactFileFound = true;
      const bytes = statSync(artifactPath).size;
      const sha256 = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
      if (manifest?.artifactBytes === bytes && manifest?.artifactSha256 === sha256) {
        manifestDiagnostics.artifactValid = true;
      }
    }
  } else {
    manifestDiagnostics.reason = "manifest-not-found";
  }

  // 2. Installed loader and self-test
  /** @type {Record<string, unknown>} */
  const loaderDiagnostics = {
    loaderPath: null,
    loaded: false,
    artifact: targetArtifact,
    selfTestPassed: false,
    reason: null,
  };

  const possibleLoaderPaths = [
    join(packageRoot, "dist", "directory-snapshot-native.js"),
  ];
  const loaderFile = possibleLoaderPaths.find((p) => existsSync(p));

  if (loaderFile) {
    loaderDiagnostics.loaderPath = loaderFile;
    const probeRes = runBoundedCommand(
      nodePath,
      [
        "--input-type=module",
        "-e",
        `
      try {
        const mod = await import(${JSON.stringify(pathToFileURL(loaderFile).href)});
        if (typeof mod.loadDirectorySnapshotNative === "function") {
          const res = mod.loadDirectorySnapshotNative();
          if (res.ok) {
            process.stdout.write(JSON.stringify({
              ok: true,
              artifact: res.artifact,
              backend: res.addon.backend,
              abiVersion: res.addon.abiVersion,
              selfTestPassed: true
            }));
          } else {
            process.stdout.write(JSON.stringify({ ok: false, artifact: res.artifact, reason: res.reason }));
          }
        } else {
          process.stdout.write(JSON.stringify({ ok: false, reason: "loader-export-missing" }));
        }
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, reason: "import-failed" }));
      }
    `,
      ],
      { timeoutMs },
    );

    if (probeRes.status === 0 && probeRes.stdout.trim()) {
      try {
        const parsed = JSON.parse(probeRes.stdout.trim());
        loaderDiagnostics.loaded = parsed.ok === true && parsed.artifact === targetArtifact && parsed.backend === "native-addon-posix-openat-v1" && parsed.abiVersion === 1;
        loaderDiagnostics.selfTestPassed = parsed.selfTestPassed === true;
        loaderDiagnostics.reason = parsed.reason ?? null;
      } catch {
        loaderDiagnostics.reason = "probe-unparseable";
      }
    } else {
      loaderDiagnostics.reason = "probe-process-failed";
    }
  } else {
    loaderDiagnostics.reason = "loader-file-missing";
  }

  return {
    targetArtifact,
    manifest: manifestDiagnostics,
    loader: loaderDiagnostics,
  };
}

/**
 * Resolves explicit or packageRoot-relative qualification targets.
 *
 * @param {{
 *   packageRoot?: string,
 *   cli?: string,
 *   cliPath?: string,
 *   tfsb?: string,
 *   service?: string,
 *   servicePath?: string,
 *   tfsbStudioService?: string,
 *   node?: string,
 *   nodeRuntime?: string,
 *   nodePath?: string,
 *   kind?: "npm" | "nix",
 *   packageKind?: "npm" | "nix",
 * }} [options]
 * @returns {{
 *   packageRoot: string,
 *   cli: string,
 *   service: string,
 *   node: string,
 *   kind: "npm" | "nix",
 * }}
 */
export function resolveQualificationTargets(options = {}) {
  if (typeof options.packageRoot !== "string" || !options.packageRoot.trim()) {
    throw new Error("Installed qualification requires an explicit --package-root.");
  }
  const packageRoot = resolve(options.packageRoot);
  const node = options.node ?? options.nodeRuntime ?? options.nodePath ?? process.execPath;

  // Resolve CLI
  let cli = options.cli ?? options.cliPath ?? options.tfsb;
  if (!cli) {
    const candidates = [
      join(packageRoot, "bin", "tfsb"),
      join(packageRoot, "dist", "cli.js"),
      join(packageRoot, "node_modules", ".bin", "tfsb"),
    ];
    cli = candidates.find((c) => existsSync(c));
  }
  if (!cli) {
    throw new Error(`Could not resolve tfsb CLI executable at package root "${packageRoot}". Specify --cli.`);
  }

  // Resolve Service
  let service = options.service ?? options.servicePath ?? options.tfsbStudioService;
  if (!service) {
    const candidates = [
      join(packageRoot, "bin", "tfsb-studio-service"),
      join(packageRoot, "dist", "service-protocol", "server-cli.js"),
      join(packageRoot, "node_modules", ".bin", "tfsb-studio-service"),
    ];
    service = candidates.find((c) => existsSync(c));
  }
  if (!service) {
    throw new Error(
      `Could not resolve tfsb-studio-service executable at package root "${packageRoot}". Specify --service.`,
    );
  }

  // Resolve Kind
  let kind = options.kind ?? options.packageKind;
  if (!kind) {
    if (
      packageRoot.includes("/nix/store/") ||
      existsSync(join(packageRoot, "share", "tfsb-source-spike")) ||
      (existsSync(join(packageRoot, "bin", "tfsb")) && !existsSync(join(packageRoot, "package.json")))
    ) {
      kind = "nix";
    } else {
      kind = "npm";
    }
  }
  if (kind !== "npm" && kind !== "nix") {
    throw new Error(`Invalid package kind "${kind}". Expected "npm" or "nix".`);
  }

  return { packageRoot, cli, service, node, kind };
}

/**
 * Parses CLI arguments for qualify-installed-burst.
 *
 * @param {string[]} args
 * @returns {{
 *   packageRoot: string | null,
 *   cli: string | null,
 *   service: string | null,
 *   node: string | null,
 *   kind: "npm" | "nix" | null,
 *   workDir: string | null,
 *   timeoutMs: number,
 *   stdout: boolean,
 *   json: boolean,
 *   help?: boolean,
 * }}
 */
export function parseInstalledQualificationArgs(args) {
  /** @type {any} */
  const result = {
    packageRoot: null,
    cli: null,
    service: null,
    node: null,
    kind: null,
    workDir: null,
    timeoutMs: 15_000,
    stdout: true,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      result.help = true;
      return result;
    }

    /**
     * @param {string} name
     * @returns {string}
     */
    const parseVal = (name) => {
      if (arg.startsWith(`${name}=`)) {
        return arg.slice(name.length + 1);
      }
      if (arg === name) {
        i++;
        const val = args[i];
        if (i >= args.length || val === undefined || val.startsWith("-")) {
          throw new Error(`Missing value for argument "${name}".`);
        }
        return val;
      }
      throw new Error(`Internal argument parsing error for "${name}".`);
    };

    if (arg === "--package-root" || arg.startsWith("--package-root=")) {
      if (result.packageRoot !== null) throw new Error("Duplicate --package-root argument.");
      result.packageRoot = resolve(parseVal("--package-root"));
    } else if (
      arg === "--cli" ||
      arg.startsWith("--cli=") ||
      arg === "--cli-path" ||
      arg.startsWith("--cli-path=") ||
      arg === "--tfsb" ||
      arg.startsWith("--tfsb=")
    ) {
      if (result.cli !== null) throw new Error("Duplicate --cli argument.");
      const prefix = arg.startsWith("--cli-path") ? "--cli-path" : arg.startsWith("--tfsb") ? "--tfsb" : "--cli";
      result.cli = resolve(parseVal(prefix));
    } else if (
      arg === "--service" ||
      arg.startsWith("--service=") ||
      arg === "--service-path" ||
      arg.startsWith("--service-path=") ||
      arg === "--tfsb-studio-service" ||
      arg.startsWith("--tfsb-studio-service=")
    ) {
      if (result.service !== null) throw new Error("Duplicate --service argument.");
      const prefix = arg.startsWith("--service-path")
        ? "--service-path"
        : arg.startsWith("--tfsb-studio-service")
          ? "--tfsb-studio-service"
          : "--service";
      result.service = resolve(parseVal(prefix));
    } else if (
      arg === "--node" ||
      arg.startsWith("--node=") ||
      arg === "--node-runtime" ||
      arg.startsWith("--node-runtime=") ||
      arg === "--node-path" ||
      arg.startsWith("--node-path=")
    ) {
      if (result.node !== null) throw new Error("Duplicate --node argument.");
      const prefix = arg.startsWith("--node-runtime")
        ? "--node-runtime"
        : arg.startsWith("--node-path")
          ? "--node-path"
          : "--node";
      result.node = resolve(parseVal(prefix));
    } else if (
      arg === "--kind" ||
      arg.startsWith("--kind=") ||
      arg === "--package-kind" ||
      arg.startsWith("--package-kind=")
    ) {
      if (result.kind !== null) throw new Error("Duplicate --kind argument.");
      const prefix = arg.startsWith("--package-kind") ? "--package-kind" : "--kind";
      const val = parseVal(prefix);
      if (val !== "npm" && val !== "nix") {
        throw new Error(`Invalid value for --kind: "${val}". Expected "npm" or "nix".`);
      }
      result.kind = val;
    } else if (
      arg === "--work-dir" ||
      arg.startsWith("--work-dir=") ||
      arg === "--scratch" ||
      arg.startsWith("--scratch=")
    ) {
      if (result.workDir !== null) throw new Error("Duplicate --work-dir argument.");
      const prefix = arg.startsWith("--scratch") ? "--scratch" : "--work-dir";
      result.workDir = resolve(parseVal(prefix));
    } else if (
      arg === "--timeout" ||
      arg.startsWith("--timeout=") ||
      arg === "--timeout-ms" ||
      arg.startsWith("--timeout-ms=")
    ) {
      const prefix = arg.startsWith("--timeout-ms") ? "--timeout-ms" : "--timeout";
      const val = parseInt(parseVal(prefix), 10);
      if (isNaN(val) || val <= 0) throw new Error(`Invalid value for --timeout: "${val}".`);
      result.timeoutMs = val;
    } else if (arg === "--no-stdout") {
      result.stdout = false;
    } else if (arg === "--stdout") {
      result.stdout = true;
    } else if (arg === "--json") {
      result.json = true;
    } else {
      throw new Error(`Unexpected argument: "${arg}".`);
    }
  }

  return result;
}

/**
 * Full qualification pipeline for an installed Burst package (npm or Nix).
 *
 * @param {{
 *   packageRoot?: string,
 *   cli?: string,
 *   service?: string,
 *   node?: string,
 *   kind?: "npm" | "nix",
 *   workDir?: string,
 *   timeoutMs?: number,
 *   stdout?: boolean,
 * }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function qualifyInstalledBurst(options = {}) {
  /** @type {Parameters<typeof resolveQualificationTargets>[0]} */
  const targetOpts = {};
  if (options.packageRoot !== undefined) targetOpts.packageRoot = options.packageRoot;
  if (options.cli !== undefined) targetOpts.cli = options.cli;
  if (options.service !== undefined) targetOpts.service = options.service;
  if (options.node !== undefined) targetOpts.node = options.node;
  if (options.kind !== undefined) targetOpts.kind = options.kind;
  const targets = resolveQualificationTargets(targetOpts);
  const root = targets.packageRoot;
  const workDir = options.workDir
    ? resolve(options.workDir)
    : realpathSync(mkdtempSync(join(tmpdir(), "tfsb-installed-qual-")));
  const isManagedWorkDir = !options.workDir;

  try {
    mkdirSync(workDir, { recursive: true });
    const cliFixture = join(workDir, "fixture-cli");
    const serviceFixture = join(workDir, "fixture-service");
    mkdirSync(cliFixture, { recursive: true });
    mkdirSync(serviceFixture, { recursive: true });
    createTestFixtureProject(serviceFixture);

    /** @type {{ timeoutMs?: number, nodePath?: string }} */
    const subOpts = { nodePath: targets.node };
    if (options.timeoutMs !== undefined) subOpts.timeoutMs = options.timeoutMs;

    const loaderAndManifest = await qualifyInstalledLoaderAndManifest(root, subOpts);

    if (!loaderAndManifest.manifest.manifestValid || !loaderAndManifest.manifest.artifactValid || !loaderAndManifest.loader.loaded || !loaderAndManifest.loader.selfTestPassed) throw new Error("Installed native loader/manifest qualification failed");
    const installedBefore = takeDirectorySnapshot(root);
    const cli = await qualifyInstalledCli(targets.cli, cliFixture, subOpts);

    /** @type {{ cwd?: string, timeoutMs?: number, nodePath?: string }} */
    const serviceOpts = { cwd: dirname(serviceFixture), nodePath: targets.node };
    if (options.timeoutMs !== undefined) serviceOpts.timeoutMs = options.timeoutMs;

    const service = await qualifyInstalledService(targets.service, serviceFixture, serviceOpts);

    const installedChanges = compareDirectorySnapshots(installedBefore, takeDirectorySnapshot(root));
    if (!installedChanges) throw new Error("Installed package changed during qualification");
    const report = {
      installedTreeUnchanged: true,
      schemaVersion: 1,
      kind: targets.kind,
      packageRoot: root,
      targets: {
        cli: targets.cli,
        service: targets.service,
        node: targets.node,
        kind: targets.kind,
      },
      platform: {
        platform: process.platform,
        arch: process.arch,
        artifact: resolvePlatformArtifact(process.platform, process.arch),
      },
      loaderAndManifest,
      cli,
      service,
      qualified: true,
    };

    if (options.stdout !== false) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    return report;
  } finally {
    if (isManagedWorkDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && isMainScript(import.meta.url)) {
  const parsed = parseInstalledQualificationArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`Usage:
  qualify-installed-burst.mjs [options]

Options:
  --package-root <path>    Required root directory of the installed Burst package
  --cli <path>             Explicit path to the tfsb CLI executable or script
  --service <path>         Explicit path to the tfsb-studio-service executable or script
  --node <path>            Explicit path to the Node runtime binary (defaults to current process.execPath)
  --kind <npm|nix>         Package kind under test ("npm" or "nix", auto-detected if omitted)
  --work-dir <path>        Optional scratch directory for test execution (cleaned up if omitted)
  --timeout <ms>           Operation timeout in milliseconds (default: 15000)
  --no-stdout              Suppress JSON report output to stdout
  --help, -h               Show this help message
`);
    process.exit(0);
  }

  /** @type {Parameters<typeof qualifyInstalledBurst>[0]} */
  const qualOptions = {
    timeoutMs: parsed.timeoutMs,
    stdout: parsed.stdout,
  };
  if (parsed.packageRoot !== null) qualOptions.packageRoot = parsed.packageRoot;
  if (parsed.cli !== null) qualOptions.cli = parsed.cli;
  if (parsed.service !== null) qualOptions.service = parsed.service;
  if (parsed.node !== null) qualOptions.node = parsed.node;
  if (parsed.kind !== null) qualOptions.kind = parsed.kind;
  if (parsed.workDir !== null) qualOptions.workDir = parsed.workDir;

  qualifyInstalledBurst(qualOptions).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
