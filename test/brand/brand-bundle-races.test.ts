import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildProject,
  executeBrandBundle,
  planBrandBundle,
} from "../../src/index.js";
import { readRepoFile } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0, roots.length)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function setupProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-race-src-"));
  roots.push(root);

  await mkdir(join(root, ".tfsb", "assets"), { recursive: true });
  await mkdir(join(root, ".tfsb", "companions"), { recursive: true });

  const projectToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/project.toml");
  const brandToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
  const pkgToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand-package.toml");
  const assetDark = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-dark.toml");
  const assetLight = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml");
  const guidanceMd = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/GUIDANCE.md");

  await writeFile(join(root, ".tfsb", "project.toml"), projectToml);
  await writeFile(join(root, ".tfsb", "brand.toml"), brandToml);
  await writeFile(join(root, ".tfsb", "brand-package.toml"), pkgToml);
  await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-dark.toml"), assetDark);
  await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-light.toml"), assetLight);
  await writeFile(join(root, "GUIDANCE.md"), guidanceMd);
  await writeFile(join(root, ".tfsb", "companions", "GUIDANCE.md"), guidanceMd);

  const provJson = JSON.stringify({
    kind: "tfsb-import-provenance",
    schemaVersion: 2,
    records: [
      {
        type: "companion",
        canonicalPath: ".tfsb/companions/GUIDANCE.md",
        archive: {
          archiveDigestBasis: "tfsb-archive-bytes-v1",
          archiveDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          entryName: "companions/GUIDANCE.md",
          sourceBasis: "tfsb-archive-entry-bytes-v1",
          sourceDigest: "sha256:10a61401be21913c99086526840a27a24991815db9d7044ac1668787e737a9d3",
          archiveCanonicalBasis: "tfsb-companion-bytes-v1",
          archiveCanonicalDigest: "sha256:10a61401be21913c99086526840a27a24991815db9d7044ac1668787e737a9d3",
          canonicalBasis: "tfsb-companion-bytes-v1",
          canonicalState: "present",
          canonicalDigest: "sha256:10a61401be21913c99086526840a27a24991815db9d7044ac1668787e737a9d3",
          resolution: "aligned",
          toolVersion: "0.3.0",
        },
      },
    ],
  });
  await writeFile(join(root, ".tfsb", "provenance.json"), provJson);

  await buildProject(root);
  return root;
}

describe("brand bundling race conditions and TOCTOU defense", () => {
  it("fails closed with COMPANION_SOURCE_CHANGED when companion file is modified after planning", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";

    const plan = await planBrandBundle({ root, output: outputPath });

    await expect(
      executeBrandBundle(plan, {
        beforeStageWrite: async () => {
          await writeFile(join(root, "GUIDANCE.md"), "# Modified Guidance\n");
        },
      }),
    ).rejects.toThrow(/COMPANION_SOURCE_CHANGED|Companion source.*changed/);

    expect(existsSync(join(root, outputPath))).toBe(false);
  });

  it("fails closed with COMPANION_SOURCE_CHANGED when companion file is deleted after planning", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";

    const plan = await planBrandBundle({ root, output: outputPath });

    await expect(
      executeBrandBundle(plan, {
        beforeStageWrite: async () => {
          await rm(join(root, "GUIDANCE.md"));
        },
      }),
    ).rejects.toThrow(/COMPANION_SOURCE_CHANGED|Companion source.*changed/);

    expect(existsSync(join(root, outputPath))).toBe(false);
  });

  it("fails closed with BUNDLE_TARGET_EXISTS when target is created concurrently before execution", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";

    const plan = await planBrandBundle({ root, output: outputPath, force: false });

    await expect(
      executeBrandBundle(plan, {
        beforeTargetRevalidation: async () => {
          await writeFile(join(root, outputPath), "concurrently created file");
        },
      }),
    ).rejects.toThrow(/BUNDLE_TARGET_EXISTS|Output target was created concurrently/);
  });

  it("fails closed with BUNDLE_TARGET_CHANGED when force-replacement target is modified during execution", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";
    await writeFile(join(root, outputPath), "initial content");

    const plan = await planBrandBundle({ root, output: outputPath, force: true });

    await expect(
      executeBrandBundle(plan, {
        beforeTargetRevalidation: async () => {
          await writeFile(join(root, outputPath), "tampered replacement content");
        },
      }),
    ).rejects.toThrow(/BUNDLE_TARGET_CHANGED|Output target was modified concurrently/);
  });

  it("fails closed when producer companion is modified after beforeCommit hook", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";

    const plan = await planBrandBundle({ root, output: outputPath });

    await expect(
      executeBrandBundle(plan, {
        beforeCommit: async () => {
          await writeFile(join(root, "GUIDANCE.md"), "# Post-Commit Hook Tamper\n");
        },
      }),
    ).rejects.toThrow(/COMPANION_SOURCE_CHANGED|Companion source.*changed/);

    expect(existsSync(join(root, outputPath))).toBe(false);
  });

  it("fails closed when target is mutated after beforeCommit hook", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";
    await writeFile(join(root, outputPath), "initial content");

    const plan = await planBrandBundle({ root, output: outputPath, force: true });

    await expect(
      executeBrandBundle(plan, {
        beforeCommit: async () => {
          await writeFile(join(root, outputPath), "concurrent tamper during commit");
        },
      }),
    ).rejects.toThrow(/BUNDLE_TARGET_CHANGED|Output target was modified concurrently/);
  });

  it("fails closed when canonical file is modified after beforeCommit hook", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";

    const plan = await planBrandBundle({ root, output: outputPath });

    await expect(
      executeBrandBundle(plan, {
        beforeCommit: async () => {
          await writeFile(join(root, ".tfsb", "brand.toml"), 'package = "tampered"\n');
        },
      }),
    ).rejects.toThrow(/CANONICAL_CHANGED_DURING_TRANSACTION|Canonical project changed/);

    expect(existsSync(join(root, outputPath))).toBe(false);
  });

  it("fails closed when an absent fallback companion appears after beforeCommit hook", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";
    // Delete the root GUIDANCE.md so it plans as absent fallback
    await rm(join(root, "GUIDANCE.md"));

    const plan = await planBrandBundle({ root, output: outputPath });

    await expect(
      executeBrandBundle(plan, {
        beforeCommit: async () => {
          await writeFile(join(root, "GUIDANCE.md"), "# Unannounced Appearance\n");
        },
      }),
    ).rejects.toThrow(/appeared after fallback planning|COMPANION_SOURCE_CHANGED/);

    expect(existsSync(join(root, outputPath))).toBe(false);
  });

  it("fails closed and protects unowned concurrent target when target appears during force execution", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";
    await writeFile(join(root, outputPath), "original target content");

    const plan = await planBrandBundle({ root, output: outputPath, force: true });

    await expect(
      executeBrandBundle(plan, {
        afterTargetBackup: async () => {
          // A concurrent process creates an unowned target after backup
          await writeFile(join(root, outputPath), "unowned concurrent target");
        },
      }),
    ).rejects.toThrow(/Concurrent target appeared during publication|BUNDLE_TRANSACTION_FAILED/);

    // The unowned concurrent target must NOT be deleted or overwritten
    expect(await readFile(join(root, outputPath), "utf8")).toBe("unowned concurrent target");
  });

  it("supports idempotent disposeBrandBundlePlan", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";

    const { disposeBrandBundlePlan } = await import("../../src/index.js");
    const plan = await planBrandBundle({ root, output: outputPath });

    await disposeBrandBundlePlan(plan);
    await disposeBrandBundlePlan(plan); // Idempotent call

    // Executing disposed plan fails closed
    await expect(executeBrandBundle(plan)).rejects.toThrow(/Brand bundle plan is not authorized|authentic private plan/);
  });

  it("fails closed with COMPANION_SOURCE_CHANGED on same-size in-place producer mutation", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";

    const plan = await planBrandBundle({ root, output: outputPath });

    await expect(
      executeBrandBundle(plan, {
        beforeStageWrite: async () => {
          const original = await readFile(join(root, "GUIDANCE.md"), "utf8");
          // Overwrite in-place with exact same length but different characters
          const mutated = original.replace("Guidance", "Buidance");
          expect(mutated.length).toBe(original.length);
          const handle = await open(join(root, "GUIDANCE.md"), "r+");
          try {
            await handle.write(Buffer.from(mutated, "utf8"), 0, mutated.length, 0);
          } finally {
            await handle.close();
          }
        },
      }),
    ).rejects.toThrow(/COMPANION_SOURCE_CHANGED|Companion source.*content changed|Companion source.*changed/);

    expect(existsSync(join(root, outputPath))).toBe(false);
  });

  it("fails closed on equal-length mutation after beforeCommit hook", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";

    const plan = await planBrandBundle({ root, output: outputPath });

    await expect(
      executeBrandBundle(plan, {
        beforeCommit: async () => {
          const original = await readFile(join(root, "GUIDANCE.md"), "utf8");
          const mutated = original.replace("Guidance", "Xuidance");
          expect(mutated.length).toBe(original.length);
          const handle = await open(join(root, "GUIDANCE.md"), "r+");
          try {
            await handle.write(Buffer.from(mutated, "utf8"), 0, mutated.length, 0);
          } finally {
            await handle.close();
          }
        },
      }),
    ).rejects.toThrow(/COMPANION_SOURCE_CHANGED|Companion source.*content changed|Companion source.*changed/);

    expect(existsSync(join(root, outputPath))).toBe(false);
  });

  it("fails closed on mtime/ctime drift with restored bytes", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";

    const plan = await planBrandBundle({ root, output: outputPath });

    await expect(
      executeBrandBundle(plan, {
        beforeStageWrite: async () => {
          const original = await readFile(join(root, "GUIDANCE.md"));
          // Mutate and then restore exact bytes, causing mtime/ctime to change
          await writeFile(join(root, "GUIDANCE.md"), "temporary tamper");
          await writeFile(join(root, "GUIDANCE.md"), original);
        },
      }),
    ).rejects.toThrow(/COMPANION_SOURCE_CHANGED|Companion source.*changed/);

    expect(existsSync(join(root, outputPath))).toBe(false);
  });

  it("fails closed on equal-byte delete and recreate (inode change)", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";

    const plan = await planBrandBundle({ root, output: outputPath });

    await expect(
      executeBrandBundle(plan, {
        beforeStageWrite: async () => {
          const original = await readFile(join(root, "GUIDANCE.md"));
          await rm(join(root, "GUIDANCE.md"));
          await writeFile(join(root, "GUIDANCE.md"), original);
        },
      }),
    ).rejects.toThrow(/COMPANION_SOURCE_CHANGED|Companion source.*changed/);

    expect(existsSync(join(root, outputPath))).toBe(false);
  });

  it("fails closed when producer companion is enlarged beyond 8 MiB during bundling", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";

    const plan = await planBrandBundle({ root, output: outputPath });

    await expect(
      executeBrandBundle(plan, {
        beforeStageWrite: async () => {
          const huge = Buffer.alloc(8.5 * 1024 * 1024);
          await writeFile(join(root, "GUIDANCE.md"), huge);
        },
      }),
    ).rejects.toThrow(/COMPANION_SOURCE_CHANGED|Companion source.*exceeds 8 MiB|Companion source.*changed/);

    expect(existsSync(join(root, outputPath))).toBe(false);
  });

  it("fails closed with ROOT_SYMLINK_ESCAPE when configured companion source traverses a symlink", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";

    await mkdir(join(root, "symdir"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(join(root, "GUIDANCE.md"), join(root, "symdir", "link-guidance.md"));

    // Mutate brand-package.toml to point source to symlink
    const pkgToml = (await readFile(join(root, ".tfsb", "brand-package.toml"), "utf8")).replace(
      'source = "GUIDANCE.md"',
      'source = "symdir/link-guidance.md"',
    );
    await writeFile(join(root, ".tfsb", "brand-package.toml"), pkgToml);

    await expect(planBrandBundle({ root, output: outputPath })).rejects.toThrow(/ROOT_SYMLINK_ESCAPE|traverses a symlink/);
  });

  it("fails closed and does NOT fall back to absent when source has permission error", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";
    const { chmod } = await import("node:fs/promises");

    // Make GUIDANCE.md unreadable (mode 000)
    await chmod(join(root, "GUIDANCE.md"), 0o000);

    try {
      await expect(planBrandBundle({ root, output: outputPath })).rejects.toThrow();
    } finally {
      await chmod(join(root, "GUIDANCE.md"), 0o644).catch(() => undefined);
    }
  });

  it("fails closed when absent fallback companion ancestor directory is replaced", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";

    // Setup an absent companion in a nested subfolder
    await mkdir(join(root, "docs", "brand"), { recursive: true });
    await rm(join(root, "GUIDANCE.md"));
    const pkgToml = (await readFile(join(root, ".tfsb", "brand-package.toml"), "utf8")).replace(
      'source = "GUIDANCE.md"',
      'source = "docs/brand/GUIDANCE.md"',
    );
    await writeFile(join(root, ".tfsb", "brand-package.toml"), pkgToml);

    const plan = await planBrandBundle({ root, output: outputPath });

    await expect(
      executeBrandBundle(plan, {
        beforeStageWrite: async () => {
          // Delete and recreate the ancestor directory
          await rm(join(root, "docs", "brand"), { recursive: true });
          await mkdir(join(root, "docs", "brand"), { recursive: true });
        },
      }),
    ).rejects.toThrow(/COMPANION_SOURCE_CHANGED|Companion source ancestor directory.*changed/);

    expect(existsSync(join(root, outputPath))).toBe(false);
  });

  it("fails closed when absent fallback companion ancestor directory becomes a symlink", async () => {
    const root = await setupProject();
    const outputPath = "bundle.zip";
    const { symlink } = await import("node:fs/promises");

    await mkdir(join(root, "docs", "brand"), { recursive: true });
    await mkdir(join(root, "other-dir"), { recursive: true });
    await rm(join(root, "GUIDANCE.md"));
    const pkgToml = (await readFile(join(root, ".tfsb", "brand-package.toml"), "utf8")).replace(
      'source = "GUIDANCE.md"',
      'source = "docs/brand/GUIDANCE.md"',
    );
    await writeFile(join(root, ".tfsb", "brand-package.toml"), pkgToml);

    const plan = await planBrandBundle({ root, output: outputPath });

    await expect(
      executeBrandBundle(plan, {
        beforeStageWrite: async () => {
          await rm(join(root, "docs", "brand"), { recursive: true });
          await symlink(join(root, "other-dir"), join(root, "docs", "brand"));
        },
      }),
    ).rejects.toThrow(/ROOT_SYMLINK_ESCAPE|COMPANION_SOURCE_CHANGED|traverses a symlink/);

    expect(existsSync(join(root, outputPath))).toBe(false);
  });

  it("fails closed when output parent directory is replaced before commit", async () => {
    const root = await setupProject();
    const outDir = join(root, "out");
    await mkdir(outDir);
    const outputPath = "out/bundle.zip";

    const plan = await planBrandBundle({ root, output: outputPath });

    await expect(
      executeBrandBundle(plan, {
        beforeCommit: async () => {
          await rm(outDir, { recursive: true });
          await mkdir(outDir);
        },
      }),
    ).rejects.toThrow(/BUNDLE_PARENT_INVALID|Output parent directory changed/);

    expect(existsSync(join(root, outputPath))).toBe(false);
  });

  it("handles repeated bundle planning without descriptor exhaustion", async () => {
    const root = await setupProject();
    const { disposeBrandBundlePlan } = await import("../../src/index.js");

    for (let i = 0; i < 50; i++) {
      const plan = await planBrandBundle({ root, output: `bundle-${i}.zip` });
      await disposeBrandBundlePlan(plan);
    }
  });
});
