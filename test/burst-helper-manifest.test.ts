import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AddonCompatibilityError,
  canonicalJson,
  computeManifestDigest,
  DIRECTORY_SNAPSHOT_BACKEND,
  DIRECTORY_SNAPSHOT_BACKEND_ABI,
  ForeignTargetError,
  IncompleteResourceError,
  ManifestDigestMismatchError,
  PathSecurityError,
  produceBurstHelperManifest,
  resolveTargetArtifact,
  RuntimeSecurityError,
  SCHEMA,
  SCHEMA_VERSION,
  SERVICE_ENTRYPOINT,
  sha256,
  TamperedResourceError,
  TARGET_MAP,
  TrustAnchorError,
  validateBurstHelperManifest,
} from "../tools/burst-helper-manifest.mjs";

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir && existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures
      }
    }
  }
});

function createTempDir(prefix = "tfsb-helper-test-"): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  cleanupDirs.push(dir);
  return dir;
}

interface FixtureOptions {
  targets?: string[];
  pkgVersion?: string;
  pkgName?: string;
  abiVersion?: number;
  backend?: string;
}

function createPackageFixture(options: FixtureOptions = {}): { root: string; targets: string[] } {
  const root = createTempDir("tfsb-burst-pkg-");
  const targets = options.targets ?? ["darwin-arm64", "linux-arm64-gnu", "linux-x64-gnu", "darwin-x64"];
  const pkgVersion = options.pkgVersion ?? "0.5.0";
  const pkgName = options.pkgName ?? "@knowledge-forge-ai/theme-forge-stellar-burst";
  const abiVersion = options.abiVersion ?? DIRECTORY_SNAPSHOT_BACKEND_ABI;
  const backend = options.backend ?? DIRECTORY_SNAPSHOT_BACKEND;

  // 1. package.json
  const pkgJson = {
    name: pkgName,
    version: pkgVersion,
    type: "module",
    engines: { node: ">=22" },
    bin: {
      tfsb: "./dist/cli.js",
      "tfsb-studio-service": "./dist/service-protocol/server-cli.js",
    },
  };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkgJson, null, 2)}\n`, { mode: 0o644 });

  // 2. dist/
  mkdirSync(join(root, "dist/service-protocol"), { recursive: true });
  writeFileSync(join(root, "dist/cli.js"), "#!/usr/bin/env node\nconsole.log('tfsb cli');\n", { mode: 0o755 });
  writeFileSync(
    join(root, "dist/service-protocol/server-cli.js"),
    "#!/usr/bin/env node\n// tfsb studio service entrypoint\nprocess.stdin.resume();\n",
    { mode: 0o755 }
  );

  // 3. native/
  for (const targetArtifact of targets) {
    const prebuildDir = join(root, `native/directory-snapshot/prebuilds/${targetArtifact}`);
    mkdirSync(prebuildDir, { recursive: true });
    const nodeBinary = Buffer.from(`/* fake-addon-binary-${targetArtifact} */\x00\x01\x02\x03`);
    const nodePath = join(prebuildDir, "native-addon-posix-openat-v1.node");
    writeFileSync(nodePath, nodeBinary, { mode: 0o755 });

    const nativeManifest = {
      schemaVersion: 1,
      backend,
      abiVersion,
      artifact: targetArtifact,
      artifactSha256: sha256(nodeBinary),
      artifactBytes: nodeBinary.length,
    };
    writeFileSync(join(prebuildDir, "manifest.json"), `${JSON.stringify(nativeManifest, null, 2)}\n`, { mode: 0o644 });
  }

  // 4. protocol/tfsb-studio-v1
  const protoDir = join(root, "protocol/tfsb-studio-v1");
  mkdirSync(protoDir, { recursive: true });

  const protocolFiles: Record<string, string> = {
    "inventory.json": JSON.stringify({ schema: "inventory-1.0", version: "1.0" }),
    "requests.schema.json": JSON.stringify({ schema: "requests-1.0", type: "object" }),
    "results.schema.json": JSON.stringify({ schema: "results-1.0", type: "object" }),
    "inventory-1.1.json": JSON.stringify({ schema: "inventory-1.1", version: "1.1" }),
    "requests-1.1.schema.json": JSON.stringify({ schema: "requests-1.1", type: "object" }),
    "results-1.1.schema.json": JSON.stringify({ schema: "results-1.1", type: "object" }),
    "inventory-1.2.json": JSON.stringify({ schema: "inventory-1.2", version: "1.2" }),
    "requests-1.2.schema.json": JSON.stringify({ schema: "requests-1.2", type: "object" }),
    "results-1.2.schema.json": JSON.stringify({ schema: "results-1.2", type: "object" }),
    "envelope.schema.json": JSON.stringify({ schema: "envelope-v1", type: "object" }),
    "README.md": "# Studio Protocol v1\nMaintained protocol schemas.\n",
  };

  for (const [filename, content] of Object.entries(protocolFiles)) {
    writeFileSync(join(protoDir, filename), `${content}\n`, { mode: 0o644 });
  }

  // 5. Notices
  writeFileSync(join(root, "NOTICE"), "Copyright 2026 Theme Forge Authors\n", { mode: 0o644 });
  writeFileSync(join(root, "COMMERCIAL-LICENSE.md"), "# Commercial License\nTerms apply.\n", { mode: 0o644 });

  return { root, targets };
}

describe("TFSB71P2-H Burst helper manifest handoff", () => {
  describe("Target mapping and preservation", () => {
    it("maps aarch64-darwin to darwin-arm64", () => {
      expect(resolveTargetArtifact("aarch64-darwin")).toBe("darwin-arm64");
      expect(TARGET_MAP["aarch64-darwin"]).toBe("darwin-arm64");
    });

    it("maps aarch64-linux to linux-arm64-gnu", () => {
      expect(resolveTargetArtifact("aarch64-linux")).toBe("linux-arm64-gnu");
      expect(TARGET_MAP["aarch64-linux"]).toBe("linux-arm64-gnu");
    });

    it("maps x86_64-linux to linux-x64-gnu", () => {
      expect(resolveTargetArtifact("x86_64-linux")).toBe("linux-x64-gnu");
      expect(TARGET_MAP["x86_64-linux"]).toBe("linux-x64-gnu");
    });

    it("preserves darwin-x64 across target forms", () => {
      expect(resolveTargetArtifact("darwin-x64")).toBe("darwin-x64");
      expect(resolveTargetArtifact("x86_64-darwin")).toBe("darwin-x64");
      expect(TARGET_MAP["darwin-x64"]).toBe("darwin-x64");
      expect(TARGET_MAP["x86_64-darwin"]).toBe("darwin-x64");
    });

    it("rejects foreign and unsupported targets", () => {
      expect(() => resolveTargetArtifact("windows-x64")).toThrow(ForeignTargetError);
      expect(() => resolveTargetArtifact("arm-unknown-linux-gnueabihf")).toThrow(ForeignTargetError);
      expect(() => resolveTargetArtifact("freebsd-x64")).toThrow(ForeignTargetError);
      expect(() => resolveTargetArtifact("")).toThrow(ForeignTargetError);
    });
  });

  describe("Producer manifest generation", () => {
    it("produces a valid canonical manifest for a clean fixture", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({
        packageRoot: root,
        target: "aarch64-darwin",
      });

      expect(manifest.schema).toBe(SCHEMA);
      expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
      expect(manifest.target).toBe("aarch64-darwin");
      expect(manifest.targetArtifact).toBe("darwin-arm64");
      expect(manifest.package.name).toBe("@knowledge-forge-ai/theme-forge-stellar-burst");
      expect(manifest.package.version).toBe("0.5.0");
      expect(manifest.service.entrypoint).toBe(SERVICE_ENTRYPOINT);
      expect(manifest.native.backend).toBe(DIRECTORY_SNAPSHOT_BACKEND);
      expect(manifest.native.abi).toBe(DIRECTORY_SNAPSHOT_BACKEND_ABI);
      expect(manifest.native.artifact).toBe("darwin-arm64");
      expect(manifest.runtime.engine).toBe(">=22");
      expect(manifest.protocol.supportedVersions).toEqual(["1.0", "1.1", "1.2"]);

      // Verify manifestDigest is self-consistent
      const expectedDigest = computeManifestDigest(manifest);
      expect(manifest.manifestDigest).toBe(expectedDigest);

      // Verify file inventory is non-empty and sorted
      expect(manifest.files.length).toBeGreaterThan(5);
      const paths = manifest.files.map((f: { path: string }) => f.path);
      const sortedPaths = [...paths].sort();
      expect(paths).toEqual(sortedPaths);
    });

    it("produces deterministic output across multiple invocations", async () => {
      const { root } = createPackageFixture();
      const manifest1 = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-linux" });
      const manifest2 = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-linux" });

      expect(canonicalJson(manifest1)).toBe(canonicalJson(manifest2));
      expect(manifest1.manifestDigest).toBe(manifest2.manifestDigest);
    });

    it("binds an explicit Node runtime binary when specified without PATH fallback", async () => {
      const { root } = createPackageFixture();
      const fakeNodeDir = createTempDir("fake-node-");
      const fakeNode = join(fakeNodeDir, "node");
      writeFileSync(fakeNode, "#!/bin/sh\necho 'v22.23.2'\n", { mode: 0o755 });

      const manifest = await produceBurstHelperManifest({
        packageRoot: root,
        target: "x86_64-linux",
        runtime: fakeNode,
      });

      expect(manifest.runtime.nodePath).toBe(fakeNode);
      expect(manifest.runtime.sha256).toBe(sha256(Buffer.from("#!/bin/sh\necho 'v22.23.2'\n")));
      expect(manifest.runtime.mode).toBe(0o755);
    });
  });

  describe("Authenticated Validator — Trust Anchor & Digest Verification", () => {
    it("successfully validates a package against an externally authenticated expected digest", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({
        packageRoot: root,
        target: "aarch64-darwin",
        writeTo: true,
      });

      const validated = await validateBurstHelperManifest({
        packageRoot: root,
        target: "aarch64-darwin",
        expectedManifestDigest: manifest.manifestDigest,
      });

      expect(validated.ok).toBe(true);
      expect(validated.manifestDigest).toBe(manifest.manifestDigest);
      expect(validated.targetArtifact).toBe("darwin-arm64");
      expect(validated.service.entrypointPath).toBe(resolve(root, SERVICE_ENTRYPOINT));
      expect(validated.native.addonPath).toBe(resolve(root, "native/directory-snapshot/prebuilds/darwin-arm64/native-addon-posix-openat-v1.node"));
      expect(validated.native.abi).toBe(1);
      expect(validated.protocol.protocolDir).toBe(resolve(root, "protocol/tfsb-studio-v1"));
    });

    it("rejects validation when expectedManifestDigest is omitted (manifest is inventory, not trust anchor)", async () => {
      const { root } = createPackageFixture();
      await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin", writeTo: true });

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          // @ts-expect-error Testing missing expectedManifestDigest
          expectedManifestDigest: undefined,
        })
      ).rejects.toThrow(TrustAnchorError);

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: "",
        })
      ).rejects.toThrow(TrustAnchorError);
    });

    it("rejects validation when expectedManifestDigest does not match the manifest's digest", async () => {
      const { root } = createPackageFixture();
      await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin", writeTo: true });
      const wrongDigest = "0".repeat(64);

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: wrongDigest,
        })
      ).rejects.toThrow(ManifestDigestMismatchError);
    });

    it("rejects validation when manifest content is tampered to falsify its self-digest", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin" });

      // Tamper manifest by mutating a field while keeping original manifestDigest
      const tampered = { ...manifest, package: { ...manifest.package, version: "9.9.9" } };

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: manifest.manifestDigest,
          manifest: tampered,
        })
      ).rejects.toThrow(TamperedResourceError);
    });
  });

  describe("Tampering Detection", () => {
    it("rejects tampering of service entrypoint bytes", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin", writeTo: true });

      // Mutate service entrypoint on disk
      writeFileSync(join(root, SERVICE_ENTRYPOINT), "// Tampered payload!\n");

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: manifest.manifestDigest,
        })
      ).rejects.toThrow(TamperedResourceError);
    });

    it("rejects tampering of native addon binary bytes", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin", writeTo: true });

      // Mutate native addon on disk
      const addonPath = join(root, "native/directory-snapshot/prebuilds/darwin-arm64/native-addon-posix-openat-v1.node");
      writeFileSync(addonPath, Buffer.from("TAMPERED_ADDON_BYTES"));

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: manifest.manifestDigest,
        })
      ).rejects.toThrow(TamperedResourceError);
    });

    it("rejects tampering of protocol schemas", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin", writeTo: true });

      // Mutate protocol schema
      writeFileSync(join(root, "protocol/tfsb-studio-v1/requests.schema.json"), '{"tampered":true}\n');

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: manifest.manifestDigest,
        })
      ).rejects.toThrow(TamperedResourceError);
    });

    it("rejects file mode/permission modification on disk", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin", writeTo: true });

      // Modify mode of service entrypoint (e.g. remove executable bit)
      chmodSync(join(root, SERVICE_ENTRYPOINT), 0o600);

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: manifest.manifestDigest,
        })
      ).rejects.toThrow(TamperedResourceError);
    });
  });

  describe("Foreign Target Rejection", () => {
    it("rejects validation when requesting an unmapped foreign target", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin", writeTo: true });

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "windows-x64",
          expectedManifestDigest: manifest.manifestDigest,
        })
      ).rejects.toThrow(ForeignTargetError);
    });

    it("rejects validation when manifest target does not match caller requested target", async () => {
      const { root } = createPackageFixture();
      const manifestDarwin = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin", writeTo: true });

      // Caller asks for x86_64-linux but provides aarch64-darwin manifest
      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "x86_64-linux",
          expectedManifestDigest: manifestDarwin.manifestDigest,
        })
      ).rejects.toThrow(ForeignTargetError);
    });
  });

  describe("Incomplete Resources Rejection", () => {
    it("rejects when service entrypoint is missing", async () => {
      const { root } = createPackageFixture();
      rmSync(join(root, SERVICE_ENTRYPOINT));

      await expect(
        produceBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
        })
      ).rejects.toThrow(IncompleteResourceError);
    });

    it("rejects when native addon binary for target is missing", async () => {
      const { root } = createPackageFixture();
      rmSync(join(root, "native/directory-snapshot/prebuilds/darwin-arm64/native-addon-posix-openat-v1.node"));

      await expect(
        produceBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
        })
      ).rejects.toThrow(IncompleteResourceError);
    });

    it("rejects when native prebuild manifest is missing", async () => {
      const { root } = createPackageFixture();
      rmSync(join(root, "native/directory-snapshot/prebuilds/darwin-arm64/manifest.json"));

      await expect(
        produceBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
        })
      ).rejects.toThrow(IncompleteResourceError);
    });

    it("rejects when a required protocol schema is missing", async () => {
      const { root } = createPackageFixture();
      rmSync(join(root, "protocol/tfsb-studio-v1/inventory-1.2.json"));

      await expect(
        produceBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
        })
      ).rejects.toThrow(IncompleteResourceError);
    });

    it("rejects when package.json is missing", async () => {
      const { root } = createPackageFixture();
      rmSync(join(root, "package.json"));

      await expect(
        produceBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
        })
      ).rejects.toThrow(IncompleteResourceError);
    });

    it("rejects validation when an inventory file has been deleted from disk", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin", writeTo: true });

      // Delete a file that was in inventory
      rmSync(join(root, "NOTICE"));

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: manifest.manifestDigest,
        })
      ).rejects.toThrow(IncompleteResourceError);
    });
  });

  describe("Directory Traversal and Symlink Escape Rejection", () => {
    it("rejects symlink escaping the package root", async () => {
      const { root } = createPackageFixture();
      const outsideDir = createTempDir("outside-root-");
      const outsideFile = join(outsideDir, "secret.txt");
      writeFileSync(outsideFile, "secret");

      // Create escaping symlink inside package root
      symlinkSync(outsideFile, join(root, "dist/escaping-symlink.js"));

      await expect(
        produceBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
        })
      ).rejects.toThrow(PathSecurityError);
    });

    it("rejects directory traversal attempts in manifest file list during validation", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin" });

      // Inject a traversal entry into manifest
      manifest.files.push({
        path: "../outside.txt",
        mode: 0o644,
        sha256: "a".repeat(64),
        size: 10,
      });
      manifest.manifestDigest = computeManifestDigest(manifest);

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: manifest.manifestDigest,
          manifest,
        })
      ).rejects.toThrow(PathSecurityError);
    });
  });

  describe("PATH Fallback Prohibition", () => {
    it("rejects bare command 'node' without explicit absolute path", async () => {
      const { root } = createPackageFixture();

      await expect(
        produceBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          runtime: "node",
        })
      ).rejects.toThrow(RuntimeSecurityError);
    });

    it("rejects relative runtime path requiring ambient resolution", async () => {
      const { root } = createPackageFixture();

      await expect(
        produceBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          runtime: "./node",
        })
      ).rejects.toThrow(RuntimeSecurityError);
    });

    it("rejects non-executable runtime path", async () => {
      const { root } = createPackageFixture();
      const fakeDir = createTempDir("fake-node-noexec-");
      const fakeNode = join(fakeDir, "node");
      writeFileSync(fakeNode, "not executable", { mode: 0o644 });

      await expect(
        produceBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          runtime: fakeNode,
        })
      ).rejects.toThrow(RuntimeSecurityError);
    });
  });

  describe("Native ABI and Backend Enforcement", () => {
    it("rejects package with ABI mismatch (e.g. ABI 2 instead of 1)", async () => {
      const { root } = createPackageFixture({ abiVersion: 2 });

      await expect(
        produceBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
        })
      ).rejects.toThrow(AddonCompatibilityError);
    });

    it("rejects package with backend mismatch", async () => {
      const { root } = createPackageFixture({ backend: "unsupported-posix-backend" });

      await expect(
        produceBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
        })
      ).rejects.toThrow(AddonCompatibilityError);
    });
  });

  describe("Inventory and Authenticated Component Cross-Validation", () => {
    it("rejects when service entrypoint is missing from declared inventory", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin" });

      manifest.files = manifest.files.filter((f) => f.path !== SERVICE_ENTRYPOINT);
      manifest.totals.fileCount = manifest.files.length;
      manifest.totals.bytes = manifest.files.reduce((sum, f) => sum + f.size, 0);
      manifest.totals.inventoryDigest = sha256(Buffer.from(canonicalJson(manifest.files)));
      manifest.manifestDigest = computeManifestDigest(manifest);

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: manifest.manifestDigest,
          manifest,
        })
      ).rejects.toThrow(IncompleteResourceError);
    });

    it("rejects when service entrypoint digest contradicts manifest service metadata", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin" });

      manifest.service.sha256 = "0".repeat(64);
      manifest.manifestDigest = computeManifestDigest(manifest);

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: manifest.manifestDigest,
          manifest,
        })
      ).rejects.toThrow(TamperedResourceError);
    });

    it("rejects when native addon binary is missing from declared inventory", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin" });

      manifest.files = manifest.files.filter((f) => f.path !== manifest.native.path);
      manifest.totals.fileCount = manifest.files.length;
      manifest.totals.bytes = manifest.files.reduce((sum, f) => sum + f.size, 0);
      manifest.totals.inventoryDigest = sha256(Buffer.from(canonicalJson(manifest.files)));
      manifest.manifestDigest = computeManifestDigest(manifest);

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: manifest.manifestDigest,
          manifest,
        })
      ).rejects.toThrow(IncompleteResourceError);
    });

    it("rejects when native addon metadata contradicts inventory entry", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin" });

      manifest.native.sha256 = "1".repeat(64);
      manifest.manifestDigest = computeManifestDigest(manifest);

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: manifest.manifestDigest,
          manifest,
        })
      ).rejects.toThrow(TamperedResourceError);
    });

    it("rejects when a required protocol schema is missing from declared inventory", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin" });

      manifest.files = manifest.files.filter((f) => f.path !== "protocol/tfsb-studio-v1/inventory-1.2.json");
      manifest.totals.fileCount = manifest.files.length;
      manifest.totals.bytes = manifest.files.reduce((sum, f) => sum + f.size, 0);
      manifest.totals.inventoryDigest = sha256(Buffer.from(canonicalJson(manifest.files)));
      manifest.manifestDigest = computeManifestDigest(manifest);

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: manifest.manifestDigest,
          manifest,
        })
      ).rejects.toThrow(IncompleteResourceError);
    });
  });

  describe("Runtime Version and Hash Enforcement", () => {
    it("rejects when supplied runtime binary hash does not match manifest runtime digest", async () => {
      const { root } = createPackageFixture();
      const nodeDir1 = createTempDir("fake-node-1-");
      const nodeDir2 = createTempDir("fake-node-2-");
      const node1 = join(nodeDir1, "node");
      const node2 = join(nodeDir2, "node");
      writeFileSync(node1, "#!/bin/sh\necho 'node1'\n", { mode: 0o755 });
      writeFileSync(node2, "#!/bin/sh\necho 'node2'\n", { mode: 0o755 });

      const manifest = await produceBurstHelperManifest({
        packageRoot: root,
        target: "aarch64-darwin",
        runtime: node1,
      });

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: manifest.manifestDigest,
          manifest,
          runtime: node2,
        })
      ).rejects.toThrow(TamperedResourceError);
    });

    it("rejects when supplied runtime version does not match manifest runtime version", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({
        packageRoot: root,
        target: "aarch64-darwin",
        runtime: { version: "v22.2.0" },
      });

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: manifest.manifestDigest,
          manifest,
          runtime: { version: "v20.0.0" },
        })
      ).rejects.toThrow(TamperedResourceError);
    });
  });

  describe("Target and Artifact Consistency", () => {
    it("rejects when manifest native artifact contradicts requested target artifact", async () => {
      const { root } = createPackageFixture();
      const manifest = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin" });

      manifest.native.artifact = "linux-x64-gnu";
      manifest.manifestDigest = computeManifestDigest(manifest);

      await expect(
        validateBurstHelperManifest({
          packageRoot: root,
          target: "aarch64-darwin",
          expectedManifestDigest: manifest.manifestDigest,
          manifest,
        })
      ).rejects.toThrow(ForeignTargetError);
    });
  });
});



describe("closed helper runtime dependencies", () => {
  it("rejects hoisted dependencies and authenticates package-local dependency bytes", async () => {
    const { root } = createPackageFixture();
    const pkgPath = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.dependencies = { "dependency-fixture": "1.0.0" };
    writeFileSync(pkgPath, JSON.stringify(pkg));
    await expect(produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin" })).rejects.toThrow("Runtime dependency missing");
    const dependency = join(root, "node_modules/dependency-fixture");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, "package.json"), '{"name":"dependency-fixture","version":"1.0.0"}');
    writeFileSync(join(dependency, "index.js"), "export const value = 1;");
    const manifest = await produceBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin" });
    expect(manifest.files.some(f => f.path === "node_modules/dependency-fixture/index.js")).toBe(true);
    writeFileSync(join(dependency, "index.js"), "export const value = 2;");
    await expect(validateBurstHelperManifest({ packageRoot: root, target: "aarch64-darwin", manifest, expectedManifestDigest: manifest.manifestDigest })).rejects.toThrow("Runtime dependency");
  });
});
