import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readCandidatePackageIdentity,
  parseQualificationArgs,
  validatePackageUnderTest,
  verifyInstalledPackageIdentity,
  verifyCliVersion,
  verifyFrozenTarball,
  isMainScript,
} from "../../tools/package-qualification-identity.mjs";
import * as studioQualifier from "../../tools/qualify-studio-service-package.mjs";
import * as sceneQualifier from "../../tools/qualify-scene-package.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Creates an isolated mock consumer directory with simulated node_modules
 * for identity and binding qualification tests.
 *
 * @param {(consumerRoot: string) => void | Promise<void>} fn
 */
async function withMockConsumer(fn: (consumerRoot: string) => void | Promise<void>): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "tfsb-test-consumer-"));
  try {
    await fn(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Creates an isolated scratch directory for mock package candidates or tarballs.
 *
 * @param {(dir: string) => void | Promise<void>} fn
 */
async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tfsb-test-temp-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Sets up a mock installed package inside consumerRoot/node_modules/<pkgName>
 * and creates corresponding node_modules/.bin symlinks.
 */
function setupMockInstalledPackage(
  consumerRoot: string,
  options: {
    packageName: string;
    version: string;
    bins?: Record<string, string>;
    binName?: string;
    cliVersionOutput?: string;
    corruptManifest?: boolean;
    omitManifest?: boolean;
    omitBinLink?: boolean;
    divergentBinTarget?: boolean;
    manifestBin?: unknown;
  }
): { packageRoot: string; binLinkPath: string; binRealPath: string } {
  const {
    packageName,
    version,
    bins = {
      tfsb: "./dist/cli.js",
      "tfsb-studio-service": "./dist/service-protocol/server-cli.js",
    },
    binName = "tfsb",
    cliVersionOutput = version,
    corruptManifest = false,
    omitManifest = false,
    omitBinLink = false,
    divergentBinTarget = false,
  } = options;

  const packageRoot = join(consumerRoot, "node_modules", ...packageName.split("/"));
  mkdirSync(packageRoot, { recursive: true });

  const effectiveManifestBin = options.manifestBin !== undefined ? options.manifestBin : bins;

  if (!omitManifest) {
    if (corruptManifest) {
      writeFileSync(join(packageRoot, "package.json"), "NOT_JSON_DATA{{{");
    } else {
      const manifest = {
        name: packageName,
        version,
        bin: effectiveManifestBin,
      };
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    }
  }

  // Create divergent target binary if requested (for hijack simulation)
  const divergentPath = resolve(consumerRoot, "unrelated-bin.js");
  writeFileSync(divergentPath, `#!/usr/bin/env node\nconsole.log("ROGUE");\n`);
  chmodSync(divergentPath, 0o755);

  const binDir = join(consumerRoot, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });

  let primaryBinLinkPath = "";
  let primaryBinRealPath = "";

  const binEntries = typeof effectiveManifestBin === "object" && effectiveManifestBin !== null
    ? Object.entries(effectiveManifestBin as Record<string, string>)
    : Object.entries(bins);

  for (const [name, relPath] of binEntries) {
    const binRealPath = resolve(packageRoot, relPath);
    mkdirSync(dirname(binRealPath), { recursive: true });
    const scriptContent = `#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log(${JSON.stringify(cliVersionOutput)}); } else { console.log("OK"); }\n`;
    writeFileSync(binRealPath, scriptContent);
    chmodSync(binRealPath, 0o755);

    const binLinkPath = join(binDir, name);
    if (name === binName) {
      primaryBinLinkPath = binLinkPath;
      primaryBinRealPath = binRealPath;
      if (!omitBinLink) {
        const linkTarget = divergentBinTarget ? divergentPath : binRealPath;
        symlinkSync(linkTarget, binLinkPath);
      }
    } else {
      symlinkSync(binRealPath, binLinkPath);
    }
  }

  return { packageRoot, binLinkPath: primaryBinLinkPath, binRealPath: primaryBinRealPath };
}

describe("Package qualification identity and candidate metadata derivation", () => {
  it("derives current candidate identity dynamically from root package.json", () => {
    const candidate = readCandidatePackageIdentity(REPO_ROOT);
    const authoritativeManifest = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(candidate.name).toBe("@knowledge-forge-ai/theme-forge-stellar-burst");
    expect(candidate.version).toBe(authoritativeManifest.version);
    expect(candidate.bin).toHaveProperty("tfsb");
    expect(candidate.bin).toHaveProperty("tfsb-studio-service");
    expect(candidate.dependencies).toHaveProperty("@xmldom/xmldom");
    expect(candidate.dependencies).toHaveProperty("fflate");
    expect(candidate.dependencies).toHaveProperty("smol-toml");
  });

  it("handles string-form bin in candidate package.json", async () => {
    await withTempDir((dir) => {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "@my-org/my-pkg",
          version: "1.0.0",
          bin: "./dist/main.js",
        })
      );
      const identity = readCandidatePackageIdentity(dir);
      expect(identity.name).toBe("@my-org/my-pkg");
      expect(identity.version).toBe("1.0.0");
      expect(identity.bin).toEqual({ "my-pkg": "./dist/main.js" });
    });
  });

  it("rejects candidate package.json missing required identity fields", async () => {
    await withTempDir((dir) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
      expect(() => readCandidatePackageIdentity(dir)).toThrow(/valid 'name' string/);

      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "foo" }));
      expect(() => readCandidatePackageIdentity(dir)).toThrow(/valid 'version' string/);

      writeFileSync(join(dir, "package.json"), "invalid json");
      expect(() => readCandidatePackageIdentity(dir)).toThrow(/Failed to parse candidate package\.json/);
    });
  });
});

describe("Installed package qualification and mismatch regressions", () => {
  const candidateIdentity = {
    name: "@knowledge-forge-ai/theme-forge-stellar-burst",
    version: "0.5.0",
    bin: {
      tfsb: "./dist/cli.js",
      "tfsb-studio-service": "./dist/service-protocol/server-cli.js",
    },
    dependencies: {
      "@xmldom/xmldom": "0.9.12",
      fflate: "0.8.3",
      "smol-toml": "1.8.0",
    },
    exports: {},
    raw: {},
  };

  it("qualifies valid 0.5.0 installed consumer metadata and bin bindings", async () => {
    await withMockConsumer((consumer) => {
      setupMockInstalledPackage(consumer, {
        packageName: candidateIdentity.name,
        version: "0.5.0",
        binName: "tfsb",
        cliVersionOutput: "0.5.0",
      });

      const result = verifyInstalledPackageIdentity(consumer, candidateIdentity);
      expect(result.installedManifest.name).toBe(candidateIdentity.name);
      expect(result.installedManifest.version).toBe("0.5.0");

      const cliVersion = verifyCliVersion(join(consumer, "node_modules/.bin/tfsb"), "0.5.0", consumer);
      expect(cliVersion).toBe("0.5.0");
    });
  });

  it("qualifies future versions dynamically without hardcoding 0.5.0 runtime expectations", async () => {
    const futureVersions = ["0.6.0", "1.0.0", "2.14.0"];
    for (const futureVersion of futureVersions) {
      const futureCandidate = {
        ...candidateIdentity,
        version: futureVersion,
      };

      await withMockConsumer((consumer) => {
        setupMockInstalledPackage(consumer, {
          packageName: futureCandidate.name,
          version: futureVersion,
          binName: "tfsb",
          cliVersionOutput: futureVersion,
        });

        const verified = verifyInstalledPackageIdentity(consumer, futureCandidate);
        expect(verified.installedManifest.version).toBe(futureVersion);

        const cliVersion = verifyCliVersion(join(consumer, "node_modules/.bin/tfsb"), futureVersion, consumer);
        expect(cliVersion).toBe(futureVersion);
      });
    }
  });

  it("detects and rejects candidate/installed version mismatches in both directions", async () => {
    // Candidate expects 0.6.0, installed has 0.5.0
    await withMockConsumer((consumer) => {
      setupMockInstalledPackage(consumer, {
        packageName: candidateIdentity.name,
        version: "0.5.0",
      });
      const futureCandidate = { ...candidateIdentity, version: "0.6.0" };
      expect(() => verifyInstalledPackageIdentity(consumer, futureCandidate)).toThrow(
        /Installed package version mismatch: expected "0\.6\.0", received "0\.5\.0"/
      );
    });

    // Candidate expects 0.5.0, installed has 0.6.0
    await withMockConsumer((consumer) => {
      setupMockInstalledPackage(consumer, {
        packageName: candidateIdentity.name,
        version: "0.6.0",
      });
      expect(() => verifyInstalledPackageIdentity(consumer, candidateIdentity)).toThrow(
        /Installed package version mismatch: expected "0\.5\.0", received "0\.6\.0"/
      );
    });
  });

  it("detects and rejects mismatching CLI version (stale 0.4.0 regression)", async () => {
    await withMockConsumer((consumer) => {
      const { binLinkPath } = setupMockInstalledPackage(consumer, {
        packageName: candidateIdentity.name,
        version: "0.5.0",
        cliVersionOutput: "0.4.0", // stale output
      });
      expect(() => verifyCliVersion(binLinkPath, "0.5.0", consumer)).toThrow(
        /Packed CLI version mismatch: expected "0\.5\.0", received "0\.4\.0"/
      );
    });
  });

  it("cannot accept an unrelated package name", async () => {
    // Package directory for candidate does not exist at all (unrelated package installed instead)
    await withMockConsumer((consumer) => {
      setupMockInstalledPackage(consumer, {
        packageName: "@unrelated-org/different-package",
        version: "0.5.0",
      });
      expect(() => verifyInstalledPackageIdentity(consumer, candidateIdentity)).toThrow(
        /Cannot accept unrelated package/
      );
    });

    // Package installed in expected location has wrong name
    await withMockConsumer((consumer) => {
      setupMockInstalledPackage(consumer, {
        packageName: candidateIdentity.name,
        version: "0.5.0",
      });
      const wrongNameCandidate = { ...candidateIdentity, name: "@knowledge-forge-ai/other-project" };
      expect(() => verifyInstalledPackageIdentity(consumer, wrongNameCandidate)).toThrow(
        /Cannot accept unrelated package/
      );
    });
  });

  it("detects missing or corrupted installed package metadata", async () => {
    // Missing package.json
    await withMockConsumer((consumer) => {
      setupMockInstalledPackage(consumer, {
        packageName: candidateIdentity.name,
        version: "0.5.0",
        omitManifest: true,
      });
      expect(() => verifyInstalledPackageIdentity(consumer, candidateIdentity)).toThrow(
        /Installed package not found/
      );
    });

    // Malformed package.json
    await withMockConsumer((consumer) => {
      setupMockInstalledPackage(consumer, {
        packageName: candidateIdentity.name,
        version: "0.5.0",
        corruptManifest: true,
      });
      expect(() => verifyInstalledPackageIdentity(consumer, candidateIdentity)).toThrow(
        /Installed package\.json .* is unreadable or malformed/
      );
    });
  });

  it("detects missing bin declaration or bin executable", async () => {
    // Missing bin field in manifest
    await withMockConsumer((consumer) => {
      setupMockInstalledPackage(consumer, {
        packageName: candidateIdentity.name,
        version: "0.5.0",
        manifestBin: {},
      });
      expect(() => verifyInstalledPackageIdentity(consumer, candidateIdentity)).toThrow(
        /Installed package\.json bin mismatch for "tfsb"/
      );
    });

    // Missing executable symlink in node_modules/.bin
    await withMockConsumer((consumer) => {
      setupMockInstalledPackage(consumer, {
        packageName: candidateIdentity.name,
        version: "0.5.0",
        omitBinLink: true,
      });
      expect(() => verifyInstalledPackageIdentity(consumer, candidateIdentity)).toThrow(
        /Installed bin executable missing/
      );
    });
  });

  it("detects exact resolved bin binding mismatch (symlink hijack regression)", async () => {
    await withMockConsumer((consumer) => {
      setupMockInstalledPackage(consumer, {
        packageName: candidateIdentity.name,
        version: "0.5.0",
        divergentBinTarget: true, // symlink resolves to rogue binary
      });
      expect(() => verifyInstalledPackageIdentity(consumer, candidateIdentity)).toThrow(
        /Installed bin binding mismatch for "tfsb".*Cannot accept unrelated package/
      );
    });
  });

  it("rejects independent stale artifacts despite a single root version source", async () => {
    // The old raster-packed-consumer and tfsb34-cross-feature assertions read
    // root package.json on both sides: TOOL_VERSION derives from that same file.
    // Such aliases cannot detect a stale installation. Exercise the installed
    // manifest and executable instead, without asserting alias equality again.
    const candidate = readCandidatePackageIdentity(REPO_ROOT);
    const staleVersion = `${candidate.version}-stale-fixture`;
    await withMockConsumer((consumer) => {
      setupMockInstalledPackage(consumer, {
        packageName: candidate.name,
        version: staleVersion,
      });
      expect(() => verifyInstalledPackageIdentity(consumer, candidate)).toThrow(
        `Installed package version mismatch: expected "${candidate.version}", received "${staleVersion}"`
      );
    });
    await withMockConsumer((consumer) => {
      const { binLinkPath } = setupMockInstalledPackage(consumer, {
        packageName: candidate.name,
        version: candidate.version,
        cliVersionOutput: staleVersion,
      });
      expect(verifyInstalledPackageIdentity(consumer, candidate).installedManifest.version).toBe(candidate.version);
      expect(() => verifyCliVersion(binLinkPath, candidate.version, consumer)).toThrow(
        `Packed CLI version mismatch: expected "${candidate.version}", received "${staleVersion}"`
      );
    });
  });
});

describe("Narrow argument validation for --package-under-test", () => {
  it("preserves default pack behavior when no arguments are passed", () => {
    const parsed = parseQualificationArgs([]);
    expect(parsed.packageUnderTest).toBeNull();
  });

  it("parses valid --package-under-test with existing .tgz file", async () => {
    await withTempDir((dir) => {
      const tarball = join(dir, "package-0.5.0.tgz");
      writeFileSync(tarball, "mock-tarball-bytes");

      const parsedPositional = parseQualificationArgs(["--package-under-test", tarball]);
      expect(parsedPositional.packageUnderTest).toBe(tarball);

      const parsedEquals = parseQualificationArgs([`--package-under-test=${tarball}`]);
      expect(parsedEquals.packageUnderTest).toBe(tarball);
    });
  });

  it("rejects --package-under-test when file does not exist", () => {
    expect(() => parseQualificationArgs(["--package-under-test", "/nonexistent/path/pkg.tgz"])).toThrow(
      /Package archive under test not found/
    );
  });

  it("rejects non-.tgz extensions", async () => {
    await withTempDir((dir) => {
      const zipPath = join(dir, "package.zip");
      writeFileSync(zipPath, "mock");
      expect(() => parseQualificationArgs(["--package-under-test", zipPath])).toThrow(
        /expected a \.tgz file/
      );

      const jsPath = join(dir, "package.js");
      writeFileSync(jsPath, "mock");
      expect(() => parseQualificationArgs([`--package-under-test=${jsPath}`])).toThrow(
        /expected a \.tgz file/
      );
    });
  });

  it("rejects missing value for --package-under-test", () => {
    expect(() => parseQualificationArgs(["--package-under-test"])).toThrow(
      /Missing value for --package-under-test/
    );
    expect(() => parseQualificationArgs(["--package-under-test", "--other-flag"])).toThrow(
      /Missing value for --package-under-test/
    );
  });

  it("rejects duplicate --package-under-test arguments", async () => {
    await withTempDir((dir) => {
      const tarball = join(dir, "pkg.tgz");
      writeFileSync(tarball, "mock");
      expect(() => parseQualificationArgs(["--package-under-test", tarball, "--package-under-test", tarball])).toThrow(
        /Duplicate --package-under-test argument/
      );
    });
  });

  it("rejects unexpected arguments and unknown flags", () => {
    expect(() => parseQualificationArgs(["--bogus"])).toThrow(/Unexpected argument: "--bogus"/);
    expect(() => parseQualificationArgs(["random-arg"])).toThrow(/Unexpected argument: "random-arg"/);
  });

  it("validates frozen tarball byte digest comparison against packed bytes", async () => {
    await withTempDir((dir) => {
      const packA = join(dir, "pack-a.tgz");
      const packB = join(dir, "pack-b.tgz");
      const packC = join(dir, "pack-c.tgz");

      writeFileSync(packA, "identical-bytes");
      writeFileSync(packB, "identical-bytes");
      writeFileSync(packC, "different-bytes");

      expect(() => verifyFrozenTarball(packA, packB)).not.toThrow();
      expect(() => verifyFrozenTarball(packA, packC)).toThrow(
        "Frozen artifact differs from qualified package bytes."
      );
    });
  });
});

describe("Side-effect-free helper imports and qualifier entrypoint exports", () => {
  it("imports helpers and qualification modules without spawning installations or scratch side effects", () => {
    expect(typeof readCandidatePackageIdentity).toBe("function");
    expect(typeof parseQualificationArgs).toBe("function");
    expect(typeof validatePackageUnderTest).toBe("function");
    expect(typeof verifyInstalledPackageIdentity).toBe("function");
    expect(typeof verifyCliVersion).toBe("function");
    expect(typeof verifyFrozenTarball).toBe("function");
    expect(typeof isMainScript).toBe("function");

    expect(typeof studioQualifier.qualifyStudioServicePackage).toBe("function");
    expect(typeof studioQualifier.probeCli).toBe("function");
    expect(typeof studioQualifier.probeService).toBe("function");
    expect(typeof studioQualifier.probeDegradedNative).toBe("function");

    expect(typeof sceneQualifier.qualifyScenePackage).toBe("function");
  });

  it("accurately reports isMainScript for non-main module execution", () => {
    expect(isMainScript(import.meta.url)).toBe(false);
  });

  it("derives packageVersion dynamically in scene qualifier report rather than stale 0.4.0", () => {
    const candidate = readCandidatePackageIdentity(REPO_ROOT);
    const scratch = mkdtempSync(join(realpathSync(tmpdir()), "tfsb-scene-report-test-"));
    const workDir = join(scratch, "work");
    try {
      const report = sceneQualifier.qualifyScenePackage({
        destination: workDir,
        repositoryRoot: REPO_ROOT,
        stdout: false,
      }) as { schema: string; packageVersion: string };
      expect(report.schema).toBe("tfsb.scene-package-qualification-v1");
      expect(report.packageVersion).toBe(candidate.version);
      expect(report.packageVersion).not.toBe("0.4.0");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
