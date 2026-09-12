import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DiagnosticError } from "../src/diagnostics.js";
import {
  MAX_SCENE_FILE_BYTES,
  SCENE_FILE_INVALID,
  SCENE_FILE_LIMIT_EXCEEDED,
  SCENE_LINK_UNSUPPORTED,
  SCENE_PUBLISH_FAILED,
  SCENE_PUBLISH_INVALID_INPUT,
  SCENE_PUBLISH_TARGET_EXISTS,
  SCENE_PUBLISH_TARGET_INVALID,
  publishSceneSvg,
  readSceneFile,
  type ReadSceneFileHooks,
  type SceneSvgPublicationHooks,
} from "../src/scene-files.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tfsb-scene-files-")));
  roots.push(dir);
  return dir;
}

const sampleScene = {
  schema: "tfsb.vector-scene-v1",
  profile: "illustration",
  artboard: {
    width: 1440,
    height: 720,
    viewBox: [0, 0, 1440, 720],
  },
  elements: [
    {
      id: "rect-1",
      type: "rectangle",
      x: 10,
      y: 10,
      width: 100,
      height: 50,
      fill: "#ff00aa",
    },
  ],
};

const sampleSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#ff00aa"/></svg>';

describe("readSceneFile", () => {
  it("accepts exactly 8 MiB of regular-file JSON snapshot bytes", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "exact.json");
    await writeFile(filePath, "{}" + " ".repeat(MAX_SCENE_FILE_BYTES - 2));
    expect(await readSceneFile(filePath)).toEqual({});
  });

  it("reads and parses a valid scene JSON snapshot", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "scene.json");
    await writeFile(filePath, JSON.stringify(sampleScene, null, 2), "utf8");

    const result = await readSceneFile(filePath);
    expect(result).toEqual(sampleScene);
  });

  it("handles complex JSON with UTF-8 multibyte characters", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "unicode.json");
    const unicodeData = {
      title: "Stellar Burst ✨ — 星の爆発 — Étoile",
      tags: ["🚀", "日本語", "español", "üöä"],
      numbers: [1, -0.5, 3.14159, 1e5],
      nested: { active: true, nothing: null },
    };
    await writeFile(filePath, JSON.stringify(unicodeData), "utf8");

    const result = await readSceneFile(filePath);
    expect(result).toEqual(unicodeData);
  });

  it("successfully reads files within the 8 MiB limit", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "large.json");
    // Generate a payload around 1 MiB
    const largeObject = {
      data: "x".repeat(1024 * 1024),
    };
    await writeFile(filePath, JSON.stringify(largeObject), "utf8");

    const result = (await readSceneFile(filePath)) as typeof largeObject;
    expect(result.data.length).toBe(1024 * 1024);
  });

  it("strictly rejects files exceeding the 8 MiB bound", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "too-large.json");
    // Size strictly exceeding 8 MiB (8 * 1024 * 1024 + 1 bytes)
    const fileBuffer = Buffer.alloc(MAX_SCENE_FILE_BYTES + 1, 0x20); // spaces
    fileBuffer[0] = 0x7b; // '{'
    fileBuffer[fileBuffer.length - 1] = 0x7d; // '}'
    await writeFile(filePath, fileBuffer);

    await expect(readSceneFile(filePath)).rejects.toMatchObject({
      diagnostic: {
        code: SCENE_FILE_LIMIT_EXCEEDED,
      },
    });
  });

  it("rejects non-existent file path", async () => {
    const dir = await createTempDir();
    const nonExistent = join(dir, "absent.json");

    await expect(readSceneFile(nonExistent)).rejects.toMatchObject({
      diagnostic: {
        code: SCENE_FILE_INVALID,
      },
    });
  });

  it("rejects empty path or null byte in path", async () => {
    await expect(readSceneFile("")).rejects.toMatchObject({
      diagnostic: {
        code: SCENE_FILE_INVALID,
      },
    });
    await expect(readSceneFile("some\0path.json")).rejects.toMatchObject({
      diagnostic: {
        code: SCENE_FILE_INVALID,
      },
    });
  });

  it("rejects if path is a directory", async () => {
    const dir = await createTempDir();
    const subDir = join(dir, "sub");
    await mkdir(subDir);

    await expect(readSceneFile(subDir)).rejects.toMatchObject({
      diagnostic: {
        code: SCENE_FILE_INVALID,
      },
    });
  });

  it("rejects if the target file is a symlink", async () => {
    const dir = await createTempDir();
    const realFile = join(dir, "real.json");
    await writeFile(realFile, JSON.stringify(sampleScene), "utf8");

    const symlinkFile = join(dir, "linked.json");
    await symlink(realFile, symlinkFile);

    await expect(readSceneFile(symlinkFile)).rejects.toMatchObject({
      diagnostic: {
        code: SCENE_FILE_INVALID,
      },
    });
  });

  it("rejects if an ancestor parent component is a symlink", async () => {
    const dir = await createTempDir();
    const realParent = join(dir, "real-parent");
    await mkdir(realParent);
    const targetFile = join(realParent, "file.json");
    await writeFile(targetFile, JSON.stringify(sampleScene), "utf8");

    const symlinkParent = join(dir, "link-parent");
    await symlink(realParent, symlinkParent);

    const linkPath = join(symlinkParent, "file.json");
    await expect(readSceneFile(linkPath)).rejects.toMatchObject({
      diagnostic: {
        code: SCENE_FILE_INVALID,
      },
    });
  });

  it("rejects broken symlinks", async () => {
    const dir = await createTempDir();
    const brokenLink = join(dir, "broken.json");
    await symlink(join(dir, "non-existent.json"), brokenLink);

    await expect(readSceneFile(brokenLink)).rejects.toMatchObject({
      diagnostic: {
        code: SCENE_FILE_INVALID,
      },
    });
  });

  it("rejects malformed JSON", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "malformed.json");
    await writeFile(filePath, "{ not valid json: }", "utf8");

    await expect(readSceneFile(filePath)).rejects.toMatchObject({
      diagnostic: {
        code: SCENE_FILE_INVALID,
      },
    });
  });

  it("rejects invalid UTF-8 bytes", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "invalid-utf8.json");
    // 0xFF 0xFE are invalid UTF-8 byte sequences
    await writeFile(filePath, Buffer.from([0xff, 0xfe, 0x30, 0x31]));

    await expect(readSceneFile(filePath)).rejects.toMatchObject({
      diagnostic: {
        code: SCENE_FILE_INVALID,
      },
    });
  });

  it("detects snapshot race condition if file changes during reading", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "scene.json");
    await writeFile(filePath, JSON.stringify(sampleScene), "utf8");

    const hooks: ReadSceneFileHooks = {
      afterRead: async () => {
        // Concurrently modify the file on disk
        await writeFile(filePath, JSON.stringify({ modified: true }), "utf8");
      },
    };

    await expect(readSceneFile(filePath, hooks)).rejects.toMatchObject({
      diagnostic: {
        code: SCENE_FILE_INVALID,
      },
    });
  });

  it("detects snapshot race condition if file is replaced by symlink during reading", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "scene.json");
    const otherPath = join(dir, "other.json");
    await writeFile(filePath, JSON.stringify(sampleScene), "utf8");
    await writeFile(otherPath, JSON.stringify({ other: true }), "utf8");

    const hooks: ReadSceneFileHooks = {
      afterRead: async () => {
        await rm(filePath);
        await symlink(otherPath, filePath);
      },
    };

    await expect(readSceneFile(filePath, hooks)).rejects.toMatchObject({
      diagnostic: {
        code: SCENE_FILE_INVALID,
      },
    });
  });

  it("ensures error messages are path-redacted (no raw paths leaked)", async () => {
    const dir = await createTempDir();
    const missingPath = join(dir, "secret-user-path", "scene.json");

    try {
      await readSceneFile(missingPath);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DiagnosticError);
      const diag = (err as DiagnosticError).diagnostic;
      expect(diag.message).not.toContain(missingPath);
      expect(diag.message).not.toContain("secret-user-path");
      expect(diag.location).toBeUndefined();
    }
  });
});

describe("publishSceneSvg", () => {
  it("atomically publishes SVG with mode 0o600 and no temp residue", async () => {
    const dir = await createTempDir();
    const outputPath = join(dir, "output.svg");

    const result = await publishSceneSvg(outputPath, sampleSvg);
    expect(result).toEqual({
      published: true,
      targetPath: outputPath,
      cleanupResidue: null,
      dryRun: false,
    });

    const handle = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = await handle.stat();
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(await handle.readFile("utf8")).toBe(sampleSvg);
    } finally {
      await handle.close();
    }

    const remaining = await readdir(dir);
    expect(remaining).toEqual(["output.svg"]);
  });

  describe("dryRun mode", () => {
    it("validates paths without writing files or creating residue", async () => {
      const dir = await createTempDir();
      const outputPath = join(dir, "dry.svg");

      const result = await publishSceneSvg(outputPath, sampleSvg, true);
      expect(result).toEqual({
        published: false,
        targetPath: outputPath,
        cleanupResidue: null,
        dryRun: true,
      });

      await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      const remaining = await readdir(dir);
      expect(remaining).toEqual([]);
    });

    it("dryRun fails if target already exists", async () => {
      const dir = await createTempDir();
      const outputPath = join(dir, "exists.svg");
      await writeFile(outputPath, "prior", "utf8");

      await expect(publishSceneSvg(outputPath, sampleSvg, true)).rejects.toMatchObject({
        diagnostic: {
          code: SCENE_PUBLISH_TARGET_EXISTS,
        },
      });
    });

    it("dryRun fails if parent component is a symlink", async () => {
      const dir = await createTempDir();
      const realParent = join(dir, "real");
      await mkdir(realParent);
      const linkParent = join(dir, "link");
      await symlink(realParent, linkParent);

      const outputPath = join(linkParent, "dry.svg");
      await expect(publishSceneSvg(outputPath, sampleSvg, true)).rejects.toMatchObject({
        diagnostic: {
          code: SCENE_PUBLISH_TARGET_INVALID,
        },
      });
    });
  });

  describe("absent-only & no overwrite guarantees", () => {
    it("rejects existing regular file target and preserves prior content", async () => {
      const dir = await createTempDir();
      const outputPath = join(dir, "existing.svg");
      await writeFile(outputPath, "original content", "utf8");

      await expect(publishSceneSvg(outputPath, sampleSvg)).rejects.toMatchObject({
        diagnostic: {
          code: SCENE_PUBLISH_TARGET_EXISTS,
        },
      });

      const content = await readFile(outputPath, "utf8");
      expect(content).toBe("original content");
    });

    it("rejects existing directory target", async () => {
      const dir = await createTempDir();
      const outputPath = join(dir, "sub-dir");
      await mkdir(outputPath);

      await expect(publishSceneSvg(outputPath, sampleSvg)).rejects.toMatchObject({
        diagnostic: {
          code: SCENE_PUBLISH_TARGET_EXISTS,
        },
      });
    });

    it("rejects existing symlink target", async () => {
      const dir = await createTempDir();
      const realOther = join(dir, "other.svg");
      await writeFile(realOther, "other", "utf8");
      const outputPath = join(dir, "link.svg");
      await symlink(realOther, outputPath);

      await expect(publishSceneSvg(outputPath, sampleSvg)).rejects.toMatchObject({
        diagnostic: {
          code: SCENE_PUBLISH_TARGET_EXISTS,
        },
      });
      expect(await readFile(realOther, "utf8")).toBe("other");
    });

    it("rejects broken symlink target", async () => {
      const dir = await createTempDir();
      const outputPath = join(dir, "broken.svg");
      await symlink(join(dir, "non-existent.svg"), outputPath);

      await expect(publishSceneSvg(outputPath, sampleSvg)).rejects.toMatchObject({
        diagnostic: {
          code: SCENE_PUBLISH_TARGET_EXISTS,
        },
      });
    });

    it("rejects if target appears concurrently before hard-link publication", async () => {
      const dir = await createTempDir();
      const outputPath = join(dir, "racer.svg");

      const hooks: SceneSvgPublicationHooks = {
        beforeTargetRevalidation: async () => {
          await writeFile(outputPath, "race winner", "utf8");
        },
      };

      await expect(publishSceneSvg(outputPath, sampleSvg, false, hooks)).rejects.toMatchObject({
        diagnostic: {
          code: SCENE_PUBLISH_TARGET_EXISTS,
        },
      });
      expect(await readFile(outputPath, "utf8")).toBe("race winner");
    });

    it("rejects if hardlink link() returns EEXIST race condition", async () => {
      const dir = await createTempDir();
      const outputPath = join(dir, "link-race.svg");

      const hooks: SceneSvgPublicationHooks = {
        linkOverride: async () => {
          const err: NodeJS.ErrnoException = new Error("target exists");
          err.code = "EEXIST";
          throw err;
        },
      };

      await expect(publishSceneSvg(outputPath, sampleSvg, false, hooks)).rejects.toMatchObject({
        diagnostic: {
          code: SCENE_PUBLISH_TARGET_EXISTS,
        },
      });
    });
  });

  describe("symlink rejection in parent components", () => {
    it("rejects if an ancestor parent directory component is a symlink", async () => {
      const dir = await createTempDir();
      const realParent = join(dir, "real");
      await mkdir(realParent);
      const linkParent = join(dir, "link");
      await symlink(realParent, linkParent);

      const outputPath = join(linkParent, "scene.svg");
      await expect(publishSceneSvg(outputPath, sampleSvg)).rejects.toMatchObject({
        diagnostic: {
          code: SCENE_PUBLISH_TARGET_INVALID,
        },
      });
    });

    it("rejects if parent directory does not exist", async () => {
      const dir = await createTempDir();
      const outputPath = join(dir, "non-existent", "scene.svg");

      await expect(publishSceneSvg(outputPath, sampleSvg)).rejects.toMatchObject({
        diagnostic: {
          code: SCENE_PUBLISH_TARGET_INVALID,
        },
      });
    });
  });

  describe("input validation", () => {
    it("rejects empty output path or null byte in path", async () => {
      await expect(publishSceneSvg("", sampleSvg)).rejects.toMatchObject({
        diagnostic: {
          code: SCENE_PUBLISH_TARGET_INVALID,
        },
      });
      await expect(publishSceneSvg("out\0put.svg", sampleSvg)).rejects.toMatchObject({
        diagnostic: {
          code: SCENE_PUBLISH_TARGET_INVALID,
        },
      });
    });

    it("rejects non-string SVG input", async () => {
      const dir = await createTempDir();
      const outputPath = join(dir, "test.svg");
      await expect(publishSceneSvg(outputPath, null as unknown as string)).rejects.toMatchObject({
        diagnostic: {
          code: SCENE_PUBLISH_INVALID_INPUT,
        },
      });
    });
  });

  describe("pre-publication failures & owned cleanup", () => {
    const prePublicationBoundaries: (keyof SceneSvgPublicationHooks)[] = [
      "beforeCreate",
      "afterCreate",
      "beforeWrite",
      "afterWrite",
      "beforeTempSync",
      "beforeTempClose",
      "beforeParentRevalidation",
      "beforeTargetRevalidation",
      "beforeLink",
    ];

    it.each(prePublicationBoundaries)(
      "cleans exact temp staging file and publishes no bytes when %s fails",
      async (boundary) => {
        const dir = await createTempDir();
        const outputPath = join(dir, "failed.svg");
        const hooks: SceneSvgPublicationHooks = {
          [boundary]: () => {
            throw new Error(`Injected error at ${boundary}`);
          },
        };

        await expect(publishSceneSvg(outputPath, sampleSvg, false, hooks)).rejects.toMatchObject({
          diagnostic: {
            code: SCENE_PUBLISH_FAILED,
          },
        });

        await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(dir)).toEqual([]);
      },
    );
  });

  describe("post-publication failures & residue retention (no deleting target)", () => {
    const postPublicationBoundaries: (keyof SceneSvgPublicationHooks)[] = [
      "afterLink",
      "beforeParentSync",
      "beforeTempRemoval",
      "afterTempRemoval",
      "beforeFinalParentSync",
    ];

    it.each(postPublicationBoundaries)(
      "retains the complete published target and reports residue when %s fails",
      async (boundary) => {
        const dir = await createTempDir();
        const outputPath = join(dir, "published-with-residue.svg");
        const hooks: SceneSvgPublicationHooks = {
          [boundary]: () => {
            throw new Error(`Injected failure at ${boundary}`);
          },
        };

        await expect(publishSceneSvg(outputPath, sampleSvg, false, hooks)).rejects.toThrow(
          /residue:/,
        );

        // The target MUST be retained! It must NOT be unlinked/deleted!
        expect(await readFile(outputPath, "utf8")).toBe(sampleSvg);
      },
    );
  });

  describe("link unsupported diagnostic", () => {
    it.each(["EXDEV", "ENOSYS", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK"] as const)(
      "diagnoses %s as SCENE_LINK_UNSUPPORTED without leaving temp residue",
      async (errorCode) => {
        const dir = await createTempDir();
        const outputPath = join(dir, "unsupported.svg");

        const hooks: SceneSvgPublicationHooks = {
          linkOverride: async () => {
            const err: NodeJS.ErrnoException = new Error("Hard link failed");
            err.code = errorCode;
            throw err;
          },
        };

        await expect(publishSceneSvg(outputPath, sampleSvg, false, hooks)).rejects.toMatchObject({
          diagnostic: {
            code: SCENE_LINK_UNSUPPORTED,
          },
        });

        // Temp file cleaned up, target not published
        await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(dir)).toEqual([]);
      },
    );
  });

  describe("path-redacted errors", () => {
    it("never includes absolute target or temp paths in diagnostics or residue reports", async () => {
      const dir = await createTempDir();
      const secretOutput = join(dir, "sensitive-dir", "out.svg");

      try {
        await publishSceneSvg(secretOutput, sampleSvg);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(DiagnosticError);
        const diag = (err as DiagnosticError).diagnostic;
        expect(diag.message).not.toContain(secretOutput);
        expect(diag.message).not.toContain("sensitive-dir");
        expect(diag.location).toBeUndefined();
      }

      const validOutput = join(dir, "out.svg");
      try {
        await publishSceneSvg(validOutput, sampleSvg, false, {
          afterLink: () => {
            throw new Error("post link");
          },
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(DiagnosticError);
        const diag = (err as DiagnosticError).diagnostic;
        expect(diag.message).toMatch(/residue:/);
        expect(diag.message).not.toContain(dir);
        expect(diag.location).toBeUndefined();
      }
    });
  });
});
