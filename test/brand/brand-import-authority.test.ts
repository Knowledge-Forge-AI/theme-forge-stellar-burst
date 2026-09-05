import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import {
  BRAND_BUNDLE_MANIFEST_FILENAME,
  BUNDLE_MANIFEST_FILENAME,
  executeBrandImport,
  importBrandProject,
  planBrandImport,
  type BrandImportPlan,
} from "../../src/index.js";
import { readRepoFile } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0, roots.length)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createGoldenArchive(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "tfsb-authority-test-"));
  roots.push(tmp);
  const archivePath = join(tmp, "core-fixture.zip");

  const manifestJson = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/tfsb-manifest.json");
  const brandManifestJson = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/tfsb-brand-manifest.json");
  const pkgToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/brand/brand-package.toml");
  const brandToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/brand/brand.toml");
  const darkSvg = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/assets/fixture-mark-on-dark.svg");
  const lightSvg = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/assets/fixture-mark-on-light.svg");
  const guidanceMd = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/companions/GUIDANCE.md");

  const zipData = {
    [BUNDLE_MANIFEST_FILENAME]: [Buffer.from(manifestJson, "utf8"), { level: 0 }],
    [BRAND_BUNDLE_MANIFEST_FILENAME]: [Buffer.from(brandManifestJson, "utf8"), { level: 0 }],
    "brand/brand-package.toml": [Buffer.from(pkgToml, "utf8"), { level: 0 }],
    "brand/brand.toml": [Buffer.from(brandToml, "utf8"), { level: 0 }],
    "assets/fixture-mark-on-dark.svg": [Buffer.from(darkSvg, "utf8"), { level: 0 }],
    "assets/fixture-mark-on-light.svg": [Buffer.from(lightSvg, "utf8"), { level: 0 }],
    "companions/GUIDANCE.md": [Buffer.from(guidanceMd, "utf8"), { level: 0 }],
  };

  const zipBytes = zipSync(zipData as any);
  await writeFile(archivePath, zipBytes);
  return archivePath;
}

describe("brand import authority & archive hardening", () => {
  it("ignores public plan.files modifications and rejects forged plans", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-auth-target-"));
    roots.push(targetRoot);

    const plan = await planBrandImport({ archive: archivePath, root: targetRoot });

    // Plan should be frozen
    expect(Object.isFrozen(plan)).toBe(true);

    // Attempting to execute a cloned/forged plan fails closed
    const forgedPlan: BrandImportPlan = { ...plan };
    await expect(executeBrandImport(forgedPlan)).rejects.toThrow(/Brand import apply requires an authentic private plan/);

    // Valid plan executes cleanly using authentic private internals
    await executeBrandImport(plan);
    expect(existsSync(join(targetRoot, ".tfsb", "brand.toml"))).toBe(true);
  });

  it("fails closed when staged files are corrupted before promotion", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-stage-corrupt-"));
    roots.push(targetRoot);

    const plan = await planBrandImport({ archive: archivePath, root: targetRoot });

    // Corrupt a staged file in afterStageWrite hook
    await expect(
      executeBrandImport(plan, {
        afterStageWrite: async () => {
          // Find any stage directory
          const entries = await import("node:fs/promises").then((fs) => fs.readdir(targetRoot));
          const stageDir = entries.find((e) => e.startsWith(".tfsb-stage-"));
          if (stageDir) {
            await writeFile(join(targetRoot, stageDir, "brand.toml"), "corrupted = true\n");
          }
        },
      }),
    ).rejects.toThrow(/content has been modified or corrupted/);

    // Verify target directory has zero residue
    expect(existsSync(join(targetRoot, ".tfsb"))).toBe(false);
    const remaining = await import("node:fs/promises").then((fs) => fs.readdir(targetRoot));
    expect(remaining.filter((r) => r.startsWith(".tfsb"))).toEqual([]);
  });

  it("fails closed when archive is modified between plan and execute", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-archive-swap-"));
    roots.push(targetRoot);

    const plan = await planBrandImport({ archive: archivePath, root: targetRoot });

    // Mutate archive before stage creation
    await expect(
      executeBrandImport(plan, {
        beforeStageCreate: async () => {
          await writeFile(archivePath, Buffer.from("corrupted zip content"));
        },
      }),
    ).rejects.toThrow();

    expect(existsSync(join(targetRoot, ".tfsb"))).toBe(false);
  });

  it("rejects ZIP64 archives with ARCHIVE_INVALID_ZIP", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "tfsb-zip64-"));
    roots.push(tmp);
    const archivePath = join(tmp, "zip64.zip");

    // Construct a minimal buffer with ZIP64 sentinel 0xFFFF in EOCD
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
    eocd.writeUInt16LE(0xffff, 4);     // disk number sentinel
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(0xffff, 8);     // disk entries sentinel
    eocd.writeUInt16LE(0xffff, 10);    // total entries sentinel
    eocd.writeUInt32LE(0, 12);
    eocd.writeUInt32LE(0, 16);
    eocd.writeUInt16LE(0, 20);

    await writeFile(archivePath, eocd);

    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-zip64-target-"));
    roots.push(targetRoot);

    await expect(
      planBrandImport({ archive: archivePath, root: targetRoot }),
    ).rejects.toThrow(/ZIP64 archives are not supported/);
  });

  it("enforces 100:1 decompression ratio limit", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "tfsb-ratio-"));
    roots.push(tmp);
    const archivePath = join(tmp, "ratio-bomb.zip");

    // 10000 zero bytes compressed to ~10 bytes (ratio > 100:1)
    const compressedZeroes = Buffer.alloc(10000);
    const zipBytes = zipSync({
      [BUNDLE_MANIFEST_FILENAME]: [Buffer.from("{}"), { level: 0 }],
      [BRAND_BUNDLE_MANIFEST_FILENAME]: [Buffer.from("{}"), { level: 0 }],
      "bomb.txt": [compressedZeroes, { level: 9 }],
    });

    await writeFile(archivePath, zipBytes);
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-ratio-target-"));
    roots.push(targetRoot);

    await expect(
      planBrandImport({ archive: archivePath, root: targetRoot }),
    ).rejects.toThrow(/exceeds archive limits/);
  });

  it("rejects ZIP directory entries with ARCHIVE_UNSAFE_TYPE", async () => {
    const golden = await createGoldenArchive();
    const goldenBytes = await readFile(golden);

    // Create a zip with an explicit directory entry
    const zipWithDir = zipSync({
      [BUNDLE_MANIFEST_FILENAME]: [Buffer.from("{}"), { level: 0 }],
      "assets/": [Buffer.alloc(0), { level: 0 }],
    });

    const tmp = await mkdtemp(join(tmpdir(), "tfsb-dir-entry-"));
    roots.push(tmp);
    const archivePath = join(tmp, "dir-entry.zip");
    await writeFile(archivePath, zipWithDir);

    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-dir-target-"));
    roots.push(targetRoot);

    await expect(
      planBrandImport({ archive: archivePath, root: targetRoot }),
    ).rejects.toThrow(/Directory entry.*is not allowed/);
  });

  it("rejects non-NFC normalized entry names in ZIP", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "tfsb-nfc-"));
    roots.push(tmp);
    const archivePath = join(tmp, "nfd-entry.zip");

    // "e\u0301" is NFD for "é"
    const nfdName = "assets/test-e\u0301.svg";
    const zipBytes = zipSync({
      [BUNDLE_MANIFEST_FILENAME]: [Buffer.from("{}"), { level: 0 }],
      [nfdName]: [Buffer.from("<svg></svg>"), { level: 0 }],
    });

    await writeFile(archivePath, zipBytes);
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-nfc-target-"));
    roots.push(targetRoot);

    await expect(
      planBrandImport({ archive: archivePath, root: targetRoot }),
    ).rejects.toThrow(/canonical NFC form/);
  });

  it("rejects ZIP archives when local header name mismatches central directory name", async () => {
    const golden = await createGoldenArchive();
    const goldenBytes = Buffer.from(await readFile(golden));

    // Tamper with the first local header's filename bytes in place
    // The first entry is tfsb-manifest.json at offset 30
    const localNameOffset = 30; // after 30-byte local header
    // Change first char 't' -> 'x'
    if (goldenBytes.toString("utf8", localNameOffset, localNameOffset + 4) === "tfsb") {
      goldenBytes[localNameOffset] = "x".charCodeAt(0);
    }

    const tmp = await mkdtemp(join(tmpdir(), "tfsb-local-mismatch-"));
    roots.push(tmp);
    const archivePath = join(tmp, "mismatched-local.zip");
    await writeFile(archivePath, goldenBytes);

    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-local-target-"));
    roots.push(targetRoot);

    await expect(
      planBrandImport({ archive: archivePath, root: targetRoot }),
    ).rejects.toThrow(/ZIP local header name.*does not match central directory name/);
  });

  it("ensures public plan mutation cannot affect transaction execution", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-isolation-"));
    roots.push(targetRoot);

    const plan = await planBrandImport({ archive: archivePath, root: targetRoot });

    // Plan and all child properties should be frozen
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.project)).toBe(true);
    expect(Object.isFrozen(plan.brandModel)).toBe(true);
    expect(Object.isFrozen(plan.packageModel)).toBe(true);
    expect(Object.isFrozen(plan.brandManifest)).toBe(true);
    expect(Object.isFrozen(plan.assets)).toBe(true);
    expect(Object.isFrozen(plan.companions)).toBe(true);
    expect(Object.isFrozen(plan.files)).toBe(true);

    // Execute plan and verify it succeeds
    await executeBrandImport(plan);
    expect(existsSync(join(targetRoot, ".tfsb", "brand.toml"))).toBe(true);
  });

  it("staged tree validation fails closed if staged provenance.json is tampered", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-staged-prov-"));
    roots.push(targetRoot);

    const plan = await planBrandImport({ archive: archivePath, root: targetRoot });

    await expect(
      executeBrandImport(plan, {
        afterStageWrite: async () => {
          const entries = await import("node:fs/promises").then((fs) => fs.readdir(targetRoot));
          const stageDir = entries.find((e) => e.startsWith(".tfsb-stage-"));
          if (stageDir) {
            await writeFile(join(targetRoot, stageDir, "provenance.json"), JSON.stringify({ kind: "tfsb-import-provenance", schemaVersion: 1 }));
          }
        },
      }),
    ).rejects.toThrow(/modified or corrupted|failed schema-2 validation/);

    expect(existsSync(join(targetRoot, ".tfsb"))).toBe(false);
  });

  it("staged tree validation fails closed if staged TOML file contains invalid UTF-8", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-staged-utf8-"));
    roots.push(targetRoot);

    const plan = await planBrandImport({ archive: archivePath, root: targetRoot });

    await expect(
      executeBrandImport(plan, {
        afterStageWrite: async () => {
          const entries = await import("node:fs/promises").then((fs) => fs.readdir(targetRoot));
          const stageDir = entries.find((e) => e.startsWith(".tfsb-stage-"));
          if (stageDir) {
            // Write invalid UTF-8 byte sequence
            await writeFile(join(targetRoot, stageDir, "brand.toml"), Buffer.from([0xff, 0xfe, 0x80]));
          }
        },
      }),
    ).rejects.toThrow(/modified or corrupted|not valid UTF-8/);

    expect(existsSync(join(targetRoot, ".tfsb"))).toBe(false);
  });

  it("supports idempotent disposeBrandImportPlan and prevents handle leaks", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-dispose-target-"));
    roots.push(targetRoot);

    const { disposeBrandImportPlan } = await import("../../src/index.js");
    const plan = await planBrandImport({ archive: archivePath, root: targetRoot });

    await disposeBrandImportPlan(plan);
    await disposeBrandImportPlan(plan); // Idempotent call

    // Executing disposed plan fails closed
    await expect(executeBrandImport(plan)).rejects.toThrow(/authentic private plan/);

    // Loop of 50 plans without leaks
    for (let i = 0; i < 50; i++) {
      const loopTarget = join(targetRoot, `sub-${i}`);
      await mkdir(loopTarget, { recursive: true });
      const p = await planBrandImport({ archive: archivePath, root: loopTarget });
      await disposeBrandImportPlan(p);
    }
  });

  it("staged tree validation fails closed if staged asset is tampered in beforePromotion hook", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-promo-asset-"));
    roots.push(targetRoot);

    const plan = await planBrandImport({ archive: archivePath, root: targetRoot });

    await expect(
      executeBrandImport(plan, {
        beforePromotion: async () => {
          const entries = await import("node:fs/promises").then((fs) => fs.readdir(targetRoot));
          const stageDir = entries.find((e) => e.startsWith(".tfsb-stage-"));
          if (stageDir) {
            await writeFile(join(targetRoot, stageDir, "assets", "fixture-mark-on-dark.toml"), "invalid = true\n");
          }
        },
      }),
    ).rejects.toThrow(/modified or corrupted|IMPORT_TRANSACTION_FAILED/);

    expect(existsSync(join(targetRoot, ".tfsb"))).toBe(false);
  });

  it("staged tree validation fails closed if staged brand.toml is tampered in beforePromotion hook", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-promo-brand-"));
    roots.push(targetRoot);

    const plan = await planBrandImport({ archive: archivePath, root: targetRoot });

    await expect(
      executeBrandImport(plan, {
        beforePromotion: async () => {
          const entries = await import("node:fs/promises").then((fs) => fs.readdir(targetRoot));
          const stageDir = entries.find((e) => e.startsWith(".tfsb-stage-"));
          if (stageDir) {
            await writeFile(join(targetRoot, stageDir, "brand.toml"), "schema = \"tampered\"\n");
          }
        },
      }),
    ).rejects.toThrow(/modified or corrupted|IMPORT_TRANSACTION_FAILED/);

    expect(existsSync(join(targetRoot, ".tfsb"))).toBe(false);
  });

  it("staged tree validation fails closed if staged file is replaced by symlink in beforePromotion hook", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-promo-sym-"));
    roots.push(targetRoot);

    const plan = await planBrandImport({ archive: archivePath, root: targetRoot });
    const { symlink } = await import("node:fs/promises");

    await expect(
      executeBrandImport(plan, {
        beforePromotion: async () => {
          const entries = await import("node:fs/promises").then((fs) => fs.readdir(targetRoot));
          const stageDir = entries.find((e) => e.startsWith(".tfsb-stage-"));
          if (stageDir) {
            const filePath = join(targetRoot, stageDir, "brand.toml");
            await rm(filePath);
            await symlink("/dev/null", filePath);
          }
        },
      }),
    ).rejects.toThrow(/IMPORT_UNSAFE_TYPE|symbolic link/);

    expect(existsSync(join(targetRoot, ".tfsb"))).toBe(false);
  });

  it("fails closed if archive is tampered in beforePromotion hook", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-promo-arch-"));
    roots.push(targetRoot);

    const plan = await planBrandImport({ archive: archivePath, root: targetRoot });

    await expect(
      executeBrandImport(plan, {
        beforePromotion: async () => {
          await writeFile(archivePath, Buffer.from("tampered archive content in beforePromotion"));
        },
      }),
    ).rejects.toThrow(/ARCHIVE_CHANGED_DURING_PLAN|Archive was replaced or mutated|Archive changed between planning/);

    expect(existsSync(join(targetRoot, ".tfsb"))).toBe(false);
  });

  it("fails closed if staged directory is altered or replaced during validation", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-promo-dir-"));
    roots.push(targetRoot);

    const plan = await planBrandImport({ archive: archivePath, root: targetRoot });

    await expect(
      executeBrandImport(plan, {
        beforePromotion: async () => {
          const entries = await import("node:fs/promises").then((fs) => fs.readdir(targetRoot));
          const stageDir = entries.find((e) => e.startsWith(".tfsb-stage-"));
          if (stageDir) {
            // Add extra unowned file to assets directory
            await writeFile(join(targetRoot, stageDir, "assets", "unowned.toml"), "unowned = true\n");
          }
        },
      }),
    ).rejects.toThrow(/IMPORT_TRANSACTION_FAILED|IMPORT_UNSAFE_TYPE|Staged file count|unsafe permissions/);

    expect(existsSync(join(targetRoot, ".tfsb"))).toBe(false);
  });

  it("guarantees public BrandImportPlan has no Map, no raw byte buffers, and is deeply frozen", async () => {
    const archivePath = await createGoldenArchive();
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-plan-shape-"));
    roots.push(targetRoot);

    const plan = await planBrandImport({ archive: archivePath, root: targetRoot });

    // 1. files is an Array of BrandImportFileSummary, NOT a Map
    expect(Array.isArray(plan.files)).toBe(true);
    expect(plan.files instanceof Map).toBe(false);
    expect(plan.files.length).toBeGreaterThan(0);
    for (const f of plan.files) {
      expect(typeof f.path).toBe("string");
      expect(typeof f.size).toBe("number");
      expect(typeof f.sha256).toBe("string");
      expect((f as any).bytes).toBeUndefined();
    }

    // 2. companions is an Array of BrandImportCompanionSummary, NOT containing bytes
    expect(Array.isArray(plan.companions)).toBe(true);
    expect(plan.companions.length).toBeGreaterThan(0);
    for (const c of plan.companions) {
      expect(typeof c.id).toBe("string");
      expect(typeof c.filename).toBe("string");
      expect(typeof c.size).toBe("number");
      expect(typeof c.digest).toBe("string");
      expect((c as any).bytes).toBeUndefined();
    }

    // 3. No reachable Map or Uint8Array on the entire public plan tree
    function verifyNoMapOrBytes(obj: any, path = "plan"): void {
      if (obj === null || typeof obj !== "object") return;
      expect(obj instanceof Map, `Found Map at ${path}`).toBe(false);
      expect(obj instanceof Uint8Array, `Found Uint8Array at ${path}`).toBe(false);
      expect(Buffer.isBuffer(obj), `Found Buffer at ${path}`).toBe(false);
      expect(Object.isFrozen(obj), `Object at ${path} is not frozen`).toBe(true);
      for (const [k, v] of Object.entries(obj)) {
        verifyNoMapOrBytes(v, `${path}.${k}`);
      }
    }
    verifyNoMapOrBytes(plan);

    // 4. Nested mutation attempts fail (frozen)
    expect(() => { (plan as any).root = "tampered"; }).toThrow(TypeError);
    expect(() => { (plan.project as any).name = "tampered"; }).toThrow(TypeError);
    expect(() => { (plan.files as any).push({ path: "fake", size: 0, sha256: "000" }); }).toThrow(TypeError);
    expect(() => { (plan.companions as any).push({ id: "fake", filename: "fake", size: 0, digest: "000" }); }).toThrow(TypeError);

    // 5. Execution uses authentic private state and succeeds
    await executeBrandImport(plan);
    expect(existsSync(join(targetRoot, ".tfsb", "brand.toml"))).toBe(true);
  });
});
