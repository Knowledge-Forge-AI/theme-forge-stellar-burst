import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { buildProject } from "../src/build.js";
import { checkProject } from "../src/check.js";
import { importProject, planImport } from "../src/importer.js";
import { installProject } from "../src/install.js";
import { listProject } from "../src/list.js";
import { parseAssetToml, parseSvg } from "../src/index.js";
import { unwrap } from "./helpers.js";

const FIXTURE = join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureArchive(root: string): Promise<string> {
  const files: Record<string, Uint8Array> = {};
  for (const name of await readdir(FIXTURE)) files[name] = await readFile(join(FIXTURE, name));
  const path = join(root, "terminal-nova.zip");
  await writeFile(
    path,
    zipSync(files, { level: 6, mtime: new Date("1980-01-02T00:00:00Z") }),
  );
  return path;
}

async function initializedProject(): Promise<{ root: string; archive: string }> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-project-"));
  roots.push(root);
  const archive = await fixtureArchive(root);
  await importProject({ archive, root });
  return { root, archive };
}

async function configureInstall(
  root: string,
  asset: string,
  destinations: readonly string[],
): Promise<void> {
  const path = join(root, ".tfsb/project.toml");
  const current = await readFile(path, "utf8");
  await writeFile(
    path,
    `${current}\n[[install]]\nasset = "${asset}"\ndestinations = [\n${destinations
      .map((destination) => `  "${destination}",`)
      .join("\n")}\n]\n`,
  );
}

async function directoryBytes(path: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      (await readdir(path)).sort().map(async (name) => [name, (await readFile(join(path, name))).toString("hex")]),
    ),
  );
}

describe("TFSB2 import/build/install/check/list integration", () => {
  it("transactionally imports all six fixture SVGs and preserves normalized models", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-project-"));
    roots.push(root);
    const archive = await fixtureArchive(root);
    const firstDryRun = await planImport({ archive, root, dryRun: true });
    const secondDryRun = await planImport({ archive, root, dryRun: true });
    expect([...secondDryRun.files]).toEqual([...firstDryRun.files]);
    await expect(access(join(root, ".tfsb"))).rejects.toMatchObject({ code: "ENOENT" });

    const imported = await importProject({ archive, root });
    expect(imported.assets).toHaveLength(6);
    expect(await readdir(join(root, ".tfsb"))).toEqual(["assets", "project.toml"]);
    expect(await readdir(join(root, ".tfsb/assets"))).toHaveLength(6);
    for (const asset of imported.assets) {
      const originalName = `${asset.id}.svg`;
      const original = unwrap(parseSvg(await readFile(join(FIXTURE, originalName), "utf8")));
      const parsed = unwrap(
        parseAssetToml(await readFile(join(root, `.tfsb/assets/${asset.id}.toml`), "utf8")),
      );
      expect(parsed.svg).toEqual(original);
    }
  });

  it("builds deterministically, detects drift layers, installs, and lists inventory", async () => {
    const { root } = await initializedProject();
    const asset = "theme-forge-terminal-nova-mark";
    await configureInstall(root, asset, ["consumer/mark.svg", "consumer/mark-copy.svg"]);

    const dry = await buildProject(root, true);
    expect(dry.outputs).toHaveLength(6);
    await expect(access(join(root, "brand/dist"))).rejects.toMatchObject({ code: "ENOENT" });
    await buildProject(root);
    const first = await directoryBytes(join(root, "brand/dist"));
    await buildProject(root);
    expect(await directoryBytes(join(root, "brand/dist"))).toEqual(first);

    await writeFile(join(root, "brand/dist/extra.svg"), "extra");
    expect((await checkProject(root)).build.extra).toEqual(["extra.svg"]);
    await buildProject(root);
    expect((await checkProject(root)).build.extra).toEqual([]);
    await rm(join(root, `brand/dist/${asset}.svg`));
    expect((await checkProject(root)).build.missing).toEqual([`${asset}.svg`]);
    await buildProject(root);

    const projectPath = join(root, ".tfsb/project.toml");
    const projectToml = await readFile(projectPath, "utf8");
    await writeFile(projectPath, projectToml.replace(/^name = .*$/m, 'name = "Edited project name"'));
    const sourceDrift = await checkProject(root);
    expect(sourceDrift.sourceChanged).toBe(true);
    expect(sourceDrift.build.different).toEqual([]);
    await buildProject(root);

    const beforeInstall = await checkProject(root);
    expect(beforeInstall.sourceChanged).toBe(false);
    expect(beforeInstall.install.missing).toHaveLength(2);
    expect(beforeInstall.drift).toBe(true);

    const installDry = await installProject(root, true);
    expect(installDry.items).toHaveLength(2);
    await expect(access(join(root, "consumer"))).rejects.toMatchObject({ code: "ENOENT" });
    await installProject(root);
    expect((await checkProject(root)).drift).toBe(false);

    const inventory = await listProject(root);
    expect(inventory.assets.find((item) => item.id === asset)).toMatchObject({
      buildPath: `brand/dist/${asset}.svg`,
      destinations: ["consumer/mark.svg", "consumer/mark-copy.svg"],
    });

    await writeFile(join(root, "consumer/mark.svg"), "tampered");
    const installDrift = await checkProject(root);
    expect(installDrift.install.different).toEqual([join(root, "consumer/mark.svg")]);
    expect(installDrift.build.different).toEqual([]);

    await installProject(root);
    await writeFile(join(root, `brand/dist/${asset}.svg`), "tampered");
    const buildDrift = await checkProject(root);
    expect(buildDrift.build.different).toEqual([`${asset}.svg`]);
    expect(buildDrift.install.different).toEqual([]);
  });

  it("rejects unowned output and restores an owned build after replacement failure", async () => {
    const { root } = await initializedProject();
    await mkdir(join(root, "brand/dist"), { recursive: true });
    await writeFile(join(root, "brand/dist/user.txt"), "user content");
    await expect(buildProject(root)).rejects.toMatchObject({
      diagnostic: { code: "BUILD_UNOWNED_DIRECTORY" },
    });
    await rm(join(root, "brand"), { recursive: true });
    await buildProject(root);
    await writeFile(join(root, "brand/dist/extra.txt"), "prior extra");
    const prior = await directoryBytes(join(root, "brand/dist"));
    await expect(
      buildProject(root, false, {
        afterBackup: () => {
          throw new Error("simulated replacement failure");
        },
      }),
    ).rejects.toThrow("simulated replacement failure");
    expect(await directoryBytes(join(root, "brand/dist"))).toEqual(prior);
  });

  it("keeps generated build ownership after relocating the whole project", async () => {
    const { root } = await initializedProject();
    await buildProject(root);
    expect((await checkProject(root)).drift).toBe(false);

    const relocationParent = await mkdtemp(join(tmpdir(), "tfsb-relocation-"));
    roots.push(relocationParent);
    const relocatedRoot = join(relocationParent, "renamed-project");
    await cp(root, relocatedRoot, { recursive: true });

    expect((await checkProject(relocatedRoot)).drift).toBe(false);
    await buildProject(relocatedRoot);
    expect((await checkProject(relocatedRoot)).drift).toBe(false);

    const receipt = JSON.parse(
      await readFile(join(relocatedRoot, "brand/dist/.tfsb-build.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      kind: "tfsb-build-v3",
      schemaVersion: 3,
      buildDirectory: "brand/dist",
    });
    expect(receipt).not.toHaveProperty("projectRootHash");
  });

  it("rejects a valid receipt copied into a differently configured build path", async () => {
    const { root } = await initializedProject();
    await buildProject(root);
    const projectPath = join(root, ".tfsb/project.toml");
    const projectToml = await readFile(projectPath, "utf8");
    await writeFile(
      projectPath,
      projectToml.replace('directory = "brand/dist"', 'directory = "other/dist"'),
    );
    await mkdir(join(root, "other/dist"), { recursive: true });
    await copyFile(
      join(root, "brand/dist/.tfsb-build.json"),
      join(root, "other/dist/.tfsb-build.json"),
    );

    await expect(buildProject(root)).rejects.toMatchObject({
      diagnostic: { code: "BUILD_UNOWNED_DIRECTORY" },
    });
  });

  it("rolls back destination replacements and blocks stale builds", async () => {
    const { root } = await initializedProject();
    const asset = "theme-forge-terminal-nova-mark";
    await configureInstall(root, asset, ["consumer/a.svg", "consumer/b.svg"]);
    await buildProject(root);
    await mkdir(join(root, "consumer"));
    await writeFile(join(root, "consumer/a.svg"), "old-a");
    await writeFile(join(root, "consumer/b.svg"), "old-b");
    await expect(
      installProject(root, false, {
        beforeReplace: (index) => {
          if (index === 1) throw new Error("simulated install failure");
        },
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "INSTALL_FAILED_ROLLED_BACK" } });
    expect(await readFile(join(root, "consumer/a.svg"), "utf8")).toBe("old-a");
    expect(await readFile(join(root, "consumer/b.svg"), "utf8")).toBe("old-b");

    await expect(
      installProject(root, false, {
        beforeReplace: (index) => {
          if (index === 1) throw new Error("simulated install failure");
        },
        beforeRollback: (index) => {
          if (index === 0) throw new Error("simulated rollback failure");
        },
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "INSTALL_FAILED_PARTIAL" } });

    await writeFile(join(root, `brand/dist/${asset}.svg`), "stale");
    await expect(installProject(root)).rejects.toMatchObject({
      diagnostic: { code: "INSTALL_STALE_BUILD" },
    });
  });

  it("reports backup cleanup failure without rolling back a successful install", async () => {
    const { root } = await initializedProject();
    const asset = "theme-forge-terminal-nova-mark";
    await configureInstall(root, asset, ["consumer/a.svg", "consumer/b.svg"]);
    await buildProject(root);
    await mkdir(join(root, "consumer"));
    await writeFile(join(root, "consumer/a.svg"), "old-a");
    await writeFile(join(root, "consumer/b.svg"), "old-b");

    await expect(
      installProject(root, false, {
        beforeCleanup: (index) => {
          if (index === 1) throw new Error("simulated cleanup failure");
        },
      }),
    ).rejects.toMatchObject({
      diagnostic: { code: "INSTALL_BACKUP_CLEANUP_FAILED" },
    });
    const expected = await readFile(join(root, `brand/dist/${asset}.svg`));
    expect(await readFile(join(root, "consumer/a.svg"))).toEqual(expected);
    expect(await readFile(join(root, "consumer/b.svg"))).toEqual(expected);
  });

  it("supports a valid project with zero install destinations", async () => {
    const { root } = await initializedProject();
    await buildProject(root);
    const plan = await installProject(root);
    expect(plan.items).toEqual([]);
    expect((await checkProject(root)).drift).toBe(false);
  });

  it("fails a colliding import before creating canonical state", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-project-"));
    roots.push(root);
    const source = await readFile(join(FIXTURE, "theme-forge-terminal-nova-mark.svg"));
    const archive = join(root, "collision.zip");
    await writeFile(
      archive,
      zipSync(
        { "light/mark.svg": source, "dark/mark.svg": source },
        { level: 0, mtime: new Date("1980-01-02T00:00:00Z") },
      ),
    );
    await expect(importProject({ archive, root })).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_COLLISION" },
    });
    await expect(access(join(root, ".tfsb"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("models Terminal Nova production placement topology with multiple, single, and zero destinations, plus legal companion", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-tftn-topology-"));
    roots.push(root);
    const PROD_FIXTURE = join(process.cwd(), "test/fixtures/tftn-production-v1");
    const brandReadmeBytes = await readFile(join(PROD_FIXTURE, "brand-README.md"));
    const files: Record<string, Uint8Array> = {
      "README.md": brandReadmeBytes,
    };
    for (const name of await readdir(PROD_FIXTURE)) {
      if (name.endsWith(".svg")) {
        files[name] = await readFile(join(PROD_FIXTURE, name));
      }
    }
    const archive = join(root, "tftn-prod.zip");
    await writeFile(archive, zipSync(files, { level: 6, mtime: new Date("1980-01-02T00:00:00Z") }));
    const plan = await importProject({ archive, root, companions: ["README.md"] });
    expect(plan.assets).toHaveLength(10);
    expect(plan.companions).toHaveLength(1);
    expect(await readFile(join(root, ".tfsb/companions/README.md"))).toEqual(brandReadmeBytes);

    const manifestPath = join(root, ".tfsb/project.toml");
    const manifest = `schema_version = 1
name = "theme-forge-terminal-nova"

[build]
directory = "brand/dist"

[[install]]
asset = "theme-forge-terminal-nova-mark-on-light"
destinations = ["docs/src/assets/brand/theme-forge-terminal-nova-mark-on-light.svg"]

[[install]]
asset = "theme-forge-terminal-nova-mark-on-dark"
destinations = ["docs/src/assets/brand/theme-forge-terminal-nova-mark-on-dark.svg"]

[[install]]
asset = "theme-forge-terminal-nova-horizontal-on-light"
destinations = ["docs/src/assets/brand/theme-forge-terminal-nova-horizontal-on-light.svg"]

[[install]]
asset = "theme-forge-terminal-nova-horizontal-on-dark"
destinations = ["docs/src/assets/brand/theme-forge-terminal-nova-horizontal-on-dark.svg"]

[[install]]
asset = "theme-forge-terminal-nova-stacked-on-light"
destinations = ["docs/src/assets/brand/theme-forge-terminal-nova-stacked-on-light.svg"]

[[install]]
asset = "theme-forge-terminal-nova-stacked-on-dark"
destinations = ["docs/src/assets/brand/theme-forge-terminal-nova-stacked-on-dark.svg"]

[[install]]
asset = "favicon-on-light"
destinations = [
  "docs/public/favicon-on-light.svg",
  "docs/public/favicon.svg"
]

[[install]]
asset = "favicon-on-dark"
destinations = ["docs/public/favicon-on-dark.svg"]

[[companion]]
file = "README.md"
destinations = ["README-BRAND.md"]
`;
    await writeFile(manifestPath, manifest);

    await buildProject(root);
    expect(await readdir(join(root, "brand/dist"))).toHaveLength(11); // 10 SVGs + .tfsb-build.json

    const installPlan = await installProject(root);
    expect(installPlan.items).toHaveLength(10); // 6 brand + 2 light favicons + 1 dark favicon + 1 companion
    expect(await readFile(join(root, "README-BRAND.md"))).toEqual(brandReadmeBytes);

    const checkResult = await checkProject(root);
    expect(checkResult.drift).toBe(false);
    expect(checkResult.install.missing).toHaveLength(0);
    expect(checkResult.install.different).toHaveLength(0);

    const inventory = await listProject(root);
    expect(inventory.assets).toHaveLength(10);
    expect(inventory.companions).toHaveLength(1);
    expect(inventory.companions[0]?.file).toBe("README.md");
    expect(inventory.companions[0]?.destinations).toEqual(["README-BRAND.md"]);
    const monoDark = inventory.assets.find((a) => a.id === "mark-monochrome-dark");
    expect(monoDark?.destinations).toEqual([]);
    const favLight = inventory.assets.find((a) => a.id === "favicon-on-light");
    expect(favLight?.destinations).toEqual([
      "docs/public/favicon-on-light.svg",
      "docs/public/favicon.svg",
    ]);

    // Modifying README-BRAND.md causes exact companion drift
    await writeFile(join(root, "README-BRAND.md"), "drifted content");
    const driftCheck = await checkProject(root);
    expect(driftCheck.drift).toBe(true);
    expect(driftCheck.install.different).toEqual([join(root, "README-BRAND.md")]);

    // Reinstalling restores clean state and exact bytes
    await installProject(root);
    expect(await readFile(join(root, "README-BRAND.md"))).toEqual(brandReadmeBytes);
    expect((await checkProject(root)).drift).toBe(false);
  });

  it("handles mixed archive with non-SVG members, ignoring them by default and rejecting unsupported companion or select", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-mixed-"));
    roots.push(root);
    const PROD_FIXTURE = join(process.cwd(), "test/fixtures/tftn-production-v1");
    const files: Record<string, Uint8Array> = {
      "README.md": await readFile(join(PROD_FIXTURE, "brand-README.md")),
      "tools/generate.py": Buffer.from("print('hello')\n", "utf8"),
    };
    for (const name of await readdir(PROD_FIXTURE)) {
      if (name.endsWith(".svg")) {
        files[`brand/dist/${name}`] = await readFile(join(PROD_FIXTURE, name));
      }
    }
    const archive = join(root, "mixed.zip");
    await writeFile(archive, zipSync(files, { level: 6, mtime: new Date("1980-01-02T00:00:00Z") }));

    // Default import extracts all 10 SVGs and ignores non-SVG members
    const plan = await importProject({ archive, root });
    expect(plan.assets).toHaveLength(10);

    // Explicit select of non-SVG fails
    const root2 = await mkdtemp(join(tmpdir(), "tfsb-mixed-select-"));
    roots.push(root2);
    await expect(
      importProject({ archive, root: root2, selections: ["tools/generate.py"] }),
    ).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_SELECTION_UNSUPPORTED" },
    });

    // Explicit companion selection of unsupported script fails
    const root3 = await mkdtemp(join(tmpdir(), "tfsb-mixed-companion-"));
    roots.push(root3);
    await expect(
      importProject({ archive, root: root3, companions: ["tools/generate.py"] }),
    ).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_COMPANION_UNSUPPORTED" },
    });
  });

  it("preserves exact bytes across BOM, CRLF, and non-ASCII companions from archive through install", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-exact-bytes-"));
    roots.push(root);
    const PROD_FIXTURE = join(process.cwd(), "test/fixtures/tftn-production-v1");

    // Construct companion content with UTF-8 BOM, CRLF line endings, and non-ASCII Unicode
    const bomPrefix = Buffer.from([0xef, 0xbb, 0xbf]);
    const textBody = Buffer.from(
      "# Legal & Brand Notice\r\n\r\n" +
      "Copyright © 2026 Samuel Leighton Lair — Knowledge Forge AI™\r\n" +
      "Brand mark: Nova Ingot 🚀\r\n" +
      "Internationalization: 日本語 / Français / Español / 中文\r\n",
      "utf8",
    );
    const exactCompanionBytes = Buffer.concat([bomPrefix, textBody]);

    const files: Record<string, Uint8Array> = {
      "NOTICE.txt": exactCompanionBytes,
    };
    for (const name of await readdir(PROD_FIXTURE)) {
      if (name.endsWith(".svg")) {
        files[name] = await readFile(join(PROD_FIXTURE, name));
      }
    }
    const archive = join(root, "exact-bytes.zip");
    await writeFile(archive, zipSync(files, { level: 6, mtime: new Date("1980-01-02T00:00:00Z") }));

    // Import with companion
    const plan = await importProject({ archive, root, companions: ["NOTICE.txt"] });
    expect(plan.companions).toHaveLength(1);
    expect(plan.companions[0]?.filename).toBe("NOTICE.txt");

    // Check canonical file matches exact bytes (including BOM and CRLF)
    const canonicalBytes = await readFile(join(root, ".tfsb/companions/NOTICE.txt"));
    expect(canonicalBytes).toEqual(exactCompanionBytes);

    // Configure and install
    const manifestPath = join(root, ".tfsb/project.toml");
    const manifest = await readFile(manifestPath, "utf8");
    await writeFile(
      manifestPath,
      `${manifest}\n[[companion]]\nfile = "NOTICE.txt"\ndestinations = ["legal/NOTICE-INSTALLED.txt"]\n`,
    );

    await buildProject(root);
    await installProject(root);

    // Check installed file matches exact bytes (including BOM and CRLF)
    const installedBytes = await readFile(join(root, "legal/NOTICE-INSTALLED.txt"));
    expect(installedBytes).toEqual(exactCompanionBytes);

    // Verify check is clean
    const checkClean = await checkProject(root);
    expect(checkClean.drift).toBe(false);

    // Tamper with installed file by stripping BOM
    await writeFile(join(root, "legal/NOTICE-INSTALLED.txt"), textBody);
    const checkDrift = await checkProject(root);
    expect(checkDrift.drift).toBe(true);
    expect(checkDrift.install.different).toEqual([join(root, "legal/NOTICE-INSTALLED.txt")]);

    // Reinstall restores exact bytes with BOM
    await installProject(root);
    expect(await readFile(join(root, "legal/NOTICE-INSTALLED.txt"))).toEqual(exactCompanionBytes);
    expect((await checkProject(root)).drift).toBe(false);
  });
});
