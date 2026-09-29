import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SUPPORTED_ARTIFACTS,
  compareDirectorySnapshots,
  createTestFixtureProject,
  isSupportedArtifact,
  killProcessGroup,
  parseInstalledQualificationArgs,
  qualifyInstalledBurst,
  qualifyInstalledCli,
  qualifyInstalledLoaderAndManifest,
  qualifyInstalledService,
  resolvePlatformArtifact,
  resolveQualificationTargets,
  runBoundedCommand,
  takeDirectorySnapshot,
} from "../tools/qualify-installed-burst.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDirs: string[] = [];

function makeTemp(prefix = "tfsb-installed-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  testDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolvePlatformArtifact", () => {
  it("maps Linux arm64 to linux-arm64-gnu", () => {
    expect(resolvePlatformArtifact("linux", "arm64")).toBe("linux-arm64-gnu");
  });

  it("maps Linux x64 to linux-x64-gnu", () => {
    expect(resolvePlatformArtifact("linux", "x64")).toBe("linux-x64-gnu");
  });

  it("maps Darwin arm64 to darwin-arm64", () => {
    expect(resolvePlatformArtifact("darwin", "arm64")).toBe("darwin-arm64");
  });

  it("maps Darwin x64 to darwin-x64", () => {
    expect(resolvePlatformArtifact("darwin", "x64")).toBe("darwin-x64");
  });

  it("maps unsupported platforms to none", () => {
    expect(resolvePlatformArtifact("win32", "x64")).toBe("none");
    expect(resolvePlatformArtifact("freebsd", "x64")).toBe("none");
    expect(resolvePlatformArtifact("linux", "s390x")).toBe("none");
  });

  it("identifies supported artifacts", () => {
    for (const art of SUPPORTED_ARTIFACTS) {
      expect(isSupportedArtifact(art)).toBe(true);
    }
    expect(isSupportedArtifact("none")).toBe(false);
    expect(isSupportedArtifact("win32-x64")).toBe(false);
    expect(isSupportedArtifact("linux-riscv64")).toBe(false);
  });
});

describe("parseInstalledQualificationArgs", () => {
  it("parses empty args with defaults", () => {
    const parsed = parseInstalledQualificationArgs([]);
    expect(parsed.packageRoot).toBeNull();
    expect(parsed.cli).toBeNull();
    expect(parsed.service).toBeNull();
    expect(parsed.node).toBeNull();
    expect(parsed.kind).toBeNull();
    expect(parsed.workDir).toBeNull();
    expect(parsed.timeoutMs).toBe(15_000);
    expect(parsed.stdout).toBe(true);
  });

  it("parses explicit arguments with spaces", () => {
    const parsed = parseInstalledQualificationArgs([
      "--package-root",
      "/path/to/pkg",
      "--cli",
      "/path/to/cli",
      "--service",
      "/path/to/service",
      "--node",
      "/path/to/node",
      "--kind",
      "nix",
      "--work-dir",
      "/path/to/work",
      "--timeout",
      "25000",
      "--no-stdout",
    ]);
    expect(parsed.packageRoot).toBe(resolve("/path/to/pkg"));
    expect(parsed.cli).toBe(resolve("/path/to/cli"));
    expect(parsed.service).toBe(resolve("/path/to/service"));
    expect(parsed.node).toBe(resolve("/path/to/node"));
    expect(parsed.kind).toBe("nix");
    expect(parsed.workDir).toBe(resolve("/path/to/work"));
    expect(parsed.timeoutMs).toBe(25_000);
    expect(parsed.stdout).toBe(false);
  });

  it("parses arguments with equals syntax", () => {
    const parsed = parseInstalledQualificationArgs([
      "--package-root=/path/to/pkg",
      "--cli=/path/to/cli",
      "--service=/path/to/service",
      "--node-runtime=/path/to/node",
      "--package-kind=npm",
      "--scratch=/path/to/scratch",
      "--timeout-ms=30000",
      "--json",
    ]);
    expect(parsed.packageRoot).toBe(resolve("/path/to/pkg"));
    expect(parsed.cli).toBe(resolve("/path/to/cli"));
    expect(parsed.service).toBe(resolve("/path/to/service"));
    expect(parsed.node).toBe(resolve("/path/to/node"));
    expect(parsed.kind).toBe("npm");
    expect(parsed.workDir).toBe(resolve("/path/to/scratch"));
    expect(parsed.timeoutMs).toBe(30_000);
    expect(parsed.json).toBe(true);
  });

  it("handles --help", () => {
    const parsed = parseInstalledQualificationArgs(["--help"]);
    expect(parsed.help).toBe(true);
  });

  it("rejects duplicate arguments", () => {
    expect(() =>
      parseInstalledQualificationArgs(["--package-root", "/a", "--package-root", "/b"]),
    ).toThrow(/Duplicate --package-root/);
    expect(() =>
      parseInstalledQualificationArgs(["--cli", "/a", "--cli", "/b"]),
    ).toThrow(/Duplicate --cli/);
    expect(() =>
      parseInstalledQualificationArgs(["--service", "/a", "--service", "/b"]),
    ).toThrow(/Duplicate --service/);
    expect(() =>
      parseInstalledQualificationArgs(["--kind", "npm", "--kind", "nix"]),
    ).toThrow(/Duplicate --kind/);
  });

  it("rejects missing argument values", () => {
    expect(() => parseInstalledQualificationArgs(["--package-root"])).toThrow(/Missing value/);
    expect(() => parseInstalledQualificationArgs(["--cli"])).toThrow(/Missing value/);
    expect(() => parseInstalledQualificationArgs(["--service"])).toThrow(/Missing value/);
    expect(() => parseInstalledQualificationArgs(["--kind"])).toThrow(/Missing value/);
  });

  it("rejects invalid package kinds", () => {
    expect(() => parseInstalledQualificationArgs(["--kind", "tarball"])).toThrow(
      /Invalid value for --kind.*Expected "npm" or "nix"/,
    );
  });

  it("rejects unexpected arguments", () => {
    expect(() => parseInstalledQualificationArgs(["--unknown-flag"])).toThrow(/Unexpected argument/);
  });
});

describe("resolveQualificationTargets", () => {
  it("rejects an omitted or empty installed package root", () => {
    expect(() => resolveQualificationTargets()).toThrow(/explicit --package-root/);
    expect(() => resolveQualificationTargets({ packageRoot: "" })).toThrow(/explicit --package-root/);
  });

  it("rejects an omitted root in the full qualification pipeline", async () => {
    await expect(qualifyInstalledBurst()).rejects.toThrow(/explicit --package-root/);
  });

  it("returns explicit targets directly", () => {
    const targets = resolveQualificationTargets({
      packageRoot: repositoryRoot,
      cli: join(repositoryRoot, "dist/cli.js"),
      service: join(repositoryRoot, "dist/service-protocol/server-cli.js"),
      node: process.execPath,
      kind: "nix",
    });
    expect(targets.packageRoot).toBe(repositoryRoot);
    expect(targets.cli).toBe(join(repositoryRoot, "dist/cli.js"));
    expect(targets.service).toBe(join(repositoryRoot, "dist/service-protocol/server-cli.js"));
    expect(targets.node).toBe(process.execPath);
    expect(targets.kind).toBe("nix");
  });

  it("resolves omitted executable paths from an explicit package root", () => {
    const targets = resolveQualificationTargets({ packageRoot: repositoryRoot });
    expect(targets.packageRoot).toBe(repositoryRoot);
    expect(existsSync(targets.cli)).toBe(true);
    expect(existsSync(targets.service)).toBe(true);
    expect(targets.kind).toBe("npm");
  });

  it("throws when targets cannot be resolved", () => {
    const emptyDir = makeTemp("empty-pkg-");
    expect(() => resolveQualificationTargets({ packageRoot: emptyDir })).toThrow(
      /Could not resolve tfsb CLI executable/,
    );
  });
});

describe("directory snapshot and fixture helpers", () => {
  it("creates a test fixture project with valid assets", () => {
    const dir = makeTemp("fixture-proj-");
    createTestFixtureProject(dir);
    expect(existsSync(join(dir, ".tfsb/project.toml"))).toBe(true);
    expect(existsSync(join(dir, ".tfsb/assets/alpha.toml"))).toBe(true);
    expect(existsSync(join(dir, ".tfsb/assets/beta.toml"))).toBe(true);
  });

  it("takes and compares identical directory snapshots", () => {
    const dir = makeTemp("snapshot-test-");
    createTestFixtureProject(dir);
    const snap1 = takeDirectorySnapshot(dir);
    const snap2 = takeDirectorySnapshot(dir);
    expect(compareDirectorySnapshots(snap1, snap2)).toBe(true);
  });

  it("detects modifications in directory snapshots", () => {
    const dir = makeTemp("snapshot-mod-");
    createTestFixtureProject(dir);
    const before = takeDirectorySnapshot(dir);
    writeFileSync(join(dir, ".tfsb/assets/alpha.toml"), 'schema_version = 1\nid = "alpha"\n');
    const after = takeDirectorySnapshot(dir);
    expect(compareDirectorySnapshots(before, after)).toBe(false);
  });

  it("detects added or deleted files in directory snapshots", () => {
    const dir = makeTemp("snapshot-diff-");
    createTestFixtureProject(dir);
    const before = takeDirectorySnapshot(dir);
    writeFileSync(join(dir, "extra.txt"), "extra file");
    const after = takeDirectorySnapshot(dir);
    expect(compareDirectorySnapshots(before, after)).toBe(false);
    rmSync(join(dir, "extra.txt"));
    expect(compareDirectorySnapshots(before, takeDirectorySnapshot(dir))).toBe(true);
  });
});

describe("runBoundedCommand and process group management", () => {
  it("executes commands cleanly and captures bounded stdout", () => {
    const res = runBoundedCommand(process.execPath, ["-e", 'console.log("hello-burst")']);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("hello-burst");
    expect(res.stderr).toBe("");
  });

  it("captures non-zero exit code and stderr", () => {
    const res = runBoundedCommand(process.execPath, [
      "-e",
      'console.error("fatal-error"); process.exit(42);',
    ]);
    expect(res.status).toBe(42);
    expect(res.stderr).toContain("fatal-error");
  });

  it("enforces finite timeouts on hanging processes", () => {
    const start = Date.now();
    const res = runBoundedCommand(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000);"],
      { timeoutMs: 500 },
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(res.status).not.toBe(0);
  });

  it("safely handles killProcessGroup on null/terminated children", () => {
    expect(() => killProcessGroup(null)).not.toThrow();
    expect(() => killProcessGroup({ killed: true })).not.toThrow();
    expect(() => killProcessGroup({ exitCode: 0 })).not.toThrow();
  });
});

describe("installed CLI qualification behavior", () => {
  const cliScript = join(repositoryRoot, "dist/cli.js");

  it.runIf(existsSync(cliScript))(
    "verifies CLI version, help, deterministic SVG, and prior-output preservation",
    async () => {
      const fixtureDir = makeTemp("cli-qual-");
      const report = await qualifyInstalledCli(cliScript, fixtureDir, {
        timeoutMs: 20_000,
        nodePath: process.execPath,
      });

      expect(report.help).toBe(true);
      expect(report.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(report.deterministicSvg).toBe(true);
      expect(report.svgDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(report.malformedRejection).toBe(true);
      expect(report.priorOutputPreserved).toBe(true);

      const builtSvg = join(fixtureDir, "cli-project/dist/alpha.svg");
      expect(existsSync(builtSvg)).toBe(true);
      const digest = createHash("sha256").update(readFileSync(builtSvg)).digest("hex");
      expect(digest).toBe(report.svgDigest);
    },
  );
});

describe("installed Studio Service qualification (1.0, 1.1, 1.2)", () => {
  const serviceScript = join(repositoryRoot, "dist/service-protocol/server-cli.js");

  it.runIf(existsSync(serviceScript))(
    "exercises exact lifecycle for 1.0, 1.1, 1.2 and asserts fixture unchanged",
    async () => {
      const fixtureDir = makeTemp("service-qual-");
      createTestFixtureProject(fixtureDir);

      const report = await qualifyInstalledService(serviceScript, fixtureDir, {
        timeoutMs: 15_000,
        nodePath: process.execPath,
      });

      expect(report.fixtureUnchanged).toBe(true);
      for (const version of ["1.0", "1.1", "1.2"]) {
        const vResult = report.versions[version] as any;
        expect(vResult).toBeDefined();
        expect(vResult.version).toBe(version);
        expect(vResult.initialized).toBe(true);
        expect(vResult.projectOpen).toBe(true);
        expect(vResult.assetList).toBe(true);
        expect(vResult.assetGet).toBe(true);
        expect(vResult.shutdown).toBe(true);
        expect(vResult.exitZero).toBe(true);
      }
    },
  );
});

describe("installed loader and manifest diagnostics", () => {
  it("reports target diagnostics accurately", async () => {
    const report = await qualifyInstalledLoaderAndManifest(repositoryRoot, {
      timeoutMs: 10_000,
      nodePath: process.execPath,
    });

    const target = resolvePlatformArtifact(process.platform, process.arch);
    expect(report.targetArtifact).toBe(target);
    expect(report.manifest).toBeDefined();
    expect(report.loader).toBeDefined();

    if (report.manifest.manifestFound) {
      expect(report.manifest.manifestValid).toBe(true);
    }
  });
});

describe("full qualification rejects missing/corrupt installed loader without checkout fallback", () => {
  const cliScript = join(repositoryRoot, "dist/cli.js");
  const serviceScript = join(repositoryRoot, "dist/service-protocol/server-cli.js");

  it("rejects full qualification when the installed loader is missing", async () => {
    const pkgDir = makeTemp("pkg-missing-loader-");

    await expect(
      qualifyInstalledBurst({
        packageRoot: pkgDir,
        cli: cliScript,
        service: serviceScript,
        stdout: false,
      }),
    ).rejects.toThrow(/qualification failed/i);
  });

  it("rejects full qualification when the native prebuild is missing without checkout fallback", async () => {
    const pkgDir = makeTemp("pkg-no-addon-");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    const realLoader = join(repositoryRoot, "dist/directory-snapshot-native.js");
    if (existsSync(realLoader)) {
      writeFileSync(join(pkgDir, "dist/directory-snapshot-native.js"), readFileSync(realLoader));
    } else {
      writeFileSync(
        join(pkgDir, "dist/directory-snapshot-native.js"),
        `export function loadDirectorySnapshotNative() {
  return { ok: false, artifact: "none", reason: "artifact-missing-or-corrupt" };
}`,
      );
    }

    await expect(
      qualifyInstalledBurst({
        packageRoot: pkgDir,
        cli: cliScript,
        service: serviceScript,
        stdout: false,
      }),
    ).rejects.toThrow(/qualification failed/i);
  });

  it("rejects full qualification when the installed native addon or manifest is corrupt", async () => {
    const pkgDir = makeTemp("pkg-corrupt-addon-");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    const realLoader = join(repositoryRoot, "dist/directory-snapshot-native.js");
    if (existsSync(realLoader)) {
      writeFileSync(join(pkgDir, "dist/directory-snapshot-native.js"), readFileSync(realLoader));
    } else {
      writeFileSync(
        join(pkgDir, "dist/directory-snapshot-native.js"),
        `export function loadDirectorySnapshotNative() {
  return { ok: false, artifact: "none", reason: "artifact-missing-or-corrupt" };
}`,
      );
    }

    const targetArtifact = resolvePlatformArtifact(process.platform, process.arch);
    const prebuildDir = join(pkgDir, "native/directory-snapshot/prebuilds", targetArtifact);
    mkdirSync(prebuildDir, { recursive: true });
    writeFileSync(
      join(prebuildDir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        backend: "native-addon-posix-openat-v1",
        abiVersion: 1,
        artifact: targetArtifact,
        artifactBytes: 9999,
        artifactSha256: "0000000000000000000000000000000000000000000000000000000000000000",
      }),
    );
    writeFileSync(join(prebuildDir, "native-addon-posix-openat-v1.node"), "corrupt-binary-payload");

    await expect(
      qualifyInstalledBurst({
        packageRoot: pkgDir,
        cli: cliScript,
        service: serviceScript,
        stdout: false,
      }),
    ).rejects.toThrow(/qualification failed/i);
  });
});
