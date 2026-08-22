import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { buildProject } from "../src/build.js";
import { importProject } from "../src/importer.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-root-"));
  roots.push(root);
  const svg = await readFile(
    join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1/theme-forge-terminal-nova-mark.svg"),
  );
  const archive = join(root, "mark.zip");
  await writeFile(
    archive,
    zipSync({ "mark.svg": svg }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }),
  );
  await importProject({ archive, root });
  return root;
}

describe("project path confinement", () => {
  it("rejects protected build trees and build/install overlap", async () => {
    const root = await project();
    const manifest = join(root, ".tfsb/project.toml");
    const original = await readFile(manifest, "utf8");
    await writeFile(manifest, original.replace('directory = "brand/dist"', 'directory = "src/generated"'));
    await expect(buildProject(root)).rejects.toMatchObject({
      diagnostic: { code: "ROOT_UNSAFE_BUILD_DIRECTORY" },
    });

    await writeFile(
      manifest,
      `${original}\n[[install]]\nasset = "mark"\ndestinations = ["brand/dist/mark.svg"]\n`,
    );
    await expect(buildProject(root)).rejects.toMatchObject({
      diagnostic: { code: "ROOT_PATH_OVERLAP" },
    });
  });

  it("rejects overlapping install destinations", async () => {
    const root = await project();
    const manifest = join(root, ".tfsb/project.toml");
    const original = await readFile(manifest, "utf8");
    await writeFile(
      manifest,
      `${original}\n[[install]]\nasset = "mark"\ndestinations = ["consumer", "consumer/mark.svg"]\n`,
    );
    await expect(buildProject(root)).rejects.toMatchObject({
      diagnostic: { code: "ROOT_PATH_OVERLAP" },
    });
  });

  it("rejects a symlink component before build mutation", async () => {
    const root = await project();
    const outside = await mkdtemp(join(tmpdir(), "tfsb-outside-"));
    roots.push(outside);
    const manifest = join(root, ".tfsb/project.toml");
    const original = await readFile(manifest, "utf8");
    await writeFile(manifest, original.replace('directory = "brand/dist"', 'directory = "generated/dist"'));
    await symlink(outside, join(root, "generated"));
    await expect(buildProject(root)).rejects.toMatchObject({
      diagnostic: { code: "ROOT_SYMLINK_ESCAPE" },
    });
    await expect(readFile(join(outside, "dist/.tfsb-build.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows install destinations inside protected source/docs trees but rejects them as wholesale build directories", async () => {
    const root = await project();
    const manifest = join(root, ".tfsb/project.toml");
    const original = await readFile(manifest, "utf8");

    // brand/dist is valid as build.directory; docs/src/assets/brand/foo.svg and docs/public/favicon.svg are valid install destinations
    await writeFile(
      manifest,
      `${original}\n[[install]]\nasset = "mark"\ndestinations = ["docs/src/assets/brand/theme-forge-terminal-nova-mark.svg", "docs/public/favicon.svg"]\n`,
    );
    await expect(buildProject(root)).resolves.toBeDefined();

    // src/assets/generated remains invalid specifically when used as build.directory
    await writeFile(
      manifest,
      original.replace('directory = "brand/dist"', 'directory = "src/assets/generated"'),
    );
    await expect(buildProject(root)).rejects.toMatchObject({
      diagnostic: { code: "ROOT_UNSAFE_BUILD_DIRECTORY" },
    });

    // docs/src/assets/brand remains invalid specifically when used as build.directory
    await writeFile(
      manifest,
      original.replace('directory = "brand/dist"', 'directory = "docs/src/assets/brand"'),
    );
    await expect(buildProject(root)).rejects.toMatchObject({
      diagnostic: { code: "ROOT_UNSAFE_BUILD_DIRECTORY" },
    });
  });
});
