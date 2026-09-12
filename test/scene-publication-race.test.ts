import { mkdtemp, mkdir, rename, symlink, readFile, writeFile, readdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { publishSceneSvg } from "../src/scene-files.js";

/**
 * TFSB61A Adversarial parent replacement race test.
 *
 * Contract & Product Limitation Characterization:
 * Pre-link stat and revalidation checks detect parent directory replacement (such as
 * substitution with a symlink or an altered directory inode) that occurs before the
 * hard-link commit step.
 *
 * Product-wide limitation: pure Node.js lacks handle-relative link primitives
 * for creation and publication. Path-based checks detect observed parent
 * modifications up to the link call, but cannot eliminate the kernel-level TOCTOU
 * window between the final stat check and the OS link() syscall in an adversarial
 * environment. Hostile-parent safety against concurrent kernel races is not claimed
 * without handle-relative filesystem primitives.
 */

it("does not overwrite or follow a final symlink created at the commit boundary", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scene-target-race-")));
  try {
    const victim = join(root, "victim.svg"), target = join(root, "out.svg");
    await writeFile(victim, "original");
    await expect(publishSceneSvg(target, "new", false, {
      beforeLink: () => symlink(victim, target),
    })).rejects.toMatchObject({ diagnostic: { code: "SCENE_PUBLISH_TARGET_EXISTS" } });
    expect(await readFile(victim, "utf8")).toBe("original");
    expect((await readdir(root)).sort()).toEqual(["out.svg", "victim.svg"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("publishes a valid long target basename without exceeding the staging name limit", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scene-long-name-")));
  try {
    const name = "a".repeat(230) + ".svg";
    await publishSceneSvg(join(root, name), "<svg/>\n");
    expect(await readdir(root)).toEqual([name]);
    expect(await readFile(join(root, name), "utf8")).toBe("<svg/>\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("detects and rejects parent replaced by a symlink during revalidation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scene-parent-race-reval-")));
  try {
    const parent = join(root, "parent");
    const moved = join(root, "moved");
    await mkdir(parent);
    let rejected = false;
    try {
      await publishSceneSvg(join(parent, "out.svg"), "<svg/>\n", false, {
        beforeParentRevalidation: async () => {
          await rename(parent, moved);
          await symlink(moved, parent);
        },
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    await expect(readFile(join(moved, "out.svg"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("detects and rejects parent replaced by a symlink before link commit", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scene-parent-race-link-")));
  try {
    const parent = join(root, "parent");
    const moved = join(root, "moved");
    await mkdir(parent);
    let rejected = false;
    try {
      await publishSceneSvg(join(parent, "out.svg"), "<svg/>\n", false, {
        beforeLink: async () => {
          await rename(parent, moved);
          await symlink(moved, parent);
        },
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    await expect(readFile(join(moved, "out.svg"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
