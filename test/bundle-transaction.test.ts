import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bundleProject,
  executeBundle,
  planBundle,
} from "../src/index.js";
import { makeTempDir } from "./helpers.js";

function setupCanonicalProject(dir: string): void {
  mkdirSync(join(dir, ".tfsb", "assets"), { recursive: true });
  mkdirSync(join(dir, ".tfsb", "companions"), { recursive: true });
  const projectToml = `schema_version = 1
name = "test-project"

[build]
directory = "brand/dist"

[[install]]
asset = "logo"
destinations = ["static/logo.svg"]
`;
  writeFileSync(join(dir, ".tfsb", "project.toml"), projectToml, "utf8");

  const assetToml = `schema_version = 1
id = "logo"
filename = "logo.svg"

[canvas]
width = 10
height = 10
view_box = "0 0 10 10"

[accessibility]
title = "Logo"
title_id = "logo-t"
description = "Logo."
description_id = "logo-d"

[[elements]]
type = "path"
d = "M 0 0 H 10 V 10 H 0 Z"
`;
  writeFileSync(join(tempDirGlobal, ".tfsb", "assets", "logo.toml"), assetToml, "utf8");
}

let tempDirGlobal: string;

describe("bundle output safety and transaction", () => {
  beforeEach(() => {
    tempDirGlobal = makeTempDir("tfsb-bundle-tx-");
    setupCanonicalProject(tempDirGlobal);
  });

  afterEach(() => {
    rmSync(tempDirGlobal, { recursive: true, force: true });
  });

  it("rejects output paths that overlap protected directories or destinations", async () => {
    await expect(
      planBundle({ root: tempDirGlobal, output: ".tfsb/bundle.zip" }),
    ).rejects.toThrow(/cannot be inside or overlap '\.tfsb'/);

    await expect(
      planBundle({ root: tempDirGlobal, output: "brand/dist/bundle.zip" }),
    ).rejects.toThrow(/cannot be inside or overlap the build directory/);

    await expect(
      planBundle({ root: tempDirGlobal, output: "static/logo.svg/bundle.zip" }),
    ).rejects.toThrow(/overlaps install destination/);

    await expect(
      planBundle({ root: tempDirGlobal, output: "../escape.zip" }),
    ).rejects.toThrow(/escapes or equals the project root/);
  });

  it("rejects output paths that do not end in .zip", async () => {
    await expect(
      planBundle({ root: tempDirGlobal, output: "bundle.tar" }),
    ).rejects.toThrow(/must end in '\.zip'/);
  });

  it("fails if target exists without --force", async () => {
    writeFileSync(join(tempDirGlobal, "bundle.zip"), "existing content", "utf8");

    await expect(
      planBundle({ root: tempDirGlobal, output: "bundle.zip" }),
    ).rejects.toThrow(/Output file already exists; use --force/);
  });

  it("overwrites existing target when --force is supplied", async () => {
    writeFileSync(join(tempDirGlobal, "bundle.zip"), "existing content", "utf8");

    const plan = await planBundle({
      root: tempDirGlobal,
      output: "bundle.zip",
      force: true,
    });
    expect(plan.replaced).toBe(true);

    const result = await executeBundle(plan);
    expect(result.replaced).toBe(true);
    expect(result.written).toBe(true);

    // Prior content overwritten
    const content = readFileSync(join(tempDirGlobal, "bundle.zip"));
    expect(content.toString("utf8")).not.toBe("existing content");
  });

  it("refuses directory or symlink target even with --force", async () => {
    mkdirSync(join(tempDirGlobal, "dir.zip"), { recursive: true });
    await expect(
      planBundle({ root: tempDirGlobal, output: "dir.zip", force: true }),
    ).rejects.toThrow(/Output target is a directory/);

    writeFileSync(join(tempDirGlobal, "actual.txt"), "hello", "utf8");
    symlinkSync(join(tempDirGlobal, "actual.txt"), join(tempDirGlobal, "symlink.zip"));
    await expect(
      planBundle({ root: tempDirGlobal, output: "symlink.zip", force: true }),
    ).rejects.toThrow(/traverses a symlink|Output target is a symbolic link/);
  });

  it("dry-run writes no files", async () => {
    const result = await bundleProject({
      root: tempDirGlobal,
      output: "dry.zip",
      dryRun: true,
    });
    expect(result.written).toBe(false);
    expect(existsSync(join(tempDirGlobal, "dry.zip"))).toBe(false);
  });

  it("forged or mutated plan cannot execute", async () => {
    const plan = await planBundle({
      root: tempDirGlobal,
      output: "out.zip",
    });
    const fakePlan = { ...plan };
    await expect(executeBundle(fakePlan)).rejects.toThrow(/not authorized for execution/);
  });

  it("fails if target is created concurrently before commit", async () => {
    const plan = await planBundle({
      root: tempDirGlobal,
      output: "race.zip",
    });

    await expect(
      executeBundle(plan, {
        beforeCommit: () => {
          writeFileSync(join(tempDirGlobal, "race.zip"), "created concurrently", "utf8");
        },
      }),
    ).rejects.toThrow(/was created concurrently/);
  });

  it("fails if canonical project changed after planning", async () => {
    const plan = await planBundle({
      root: tempDirGlobal,
      output: "canonical-race.zip",
    });

    await expect(
      executeBundle(plan, {
        beforeSourceRevalidation: () => {
          writeFileSync(
            join(tempDirGlobal, ".tfsb", "assets", "logo.toml"),
            "schema_version = 1\nid = 'logo'\nfilename = 'logo.svg'\n[canvas]\nwidth = 99\nheight = 99\nview_box = '0 0 99 99'\n[accessibility]\ntitle = 'T'\ntitle_id = 't'\ndescription = 'D'\ndescription_id = 'd'\n[[elements]]\ntype = 'path'\nd = 'M 0 0 Z'\n",
            "utf8",
          );
        },
      }),
    ).rejects.toThrow(/Canonical project changed after bundle planning/);
  });

  it("restores previous target on failure after backup in --force mode", async () => {
    writeFileSync(join(tempDirGlobal, "restore.zip"), "original content to preserve", "utf8");

    const plan = await planBundle({
      root: tempDirGlobal,
      output: "restore.zip",
      force: true,
    });

    await expect(
      executeBundle(plan, {
        afterTargetBackup: () => {
          throw new Error("Simulated failure after target backup");
        },
      }),
    ).rejects.toThrow(/Simulated failure after target backup/);

    // Old target should be restored intact
    expect(readFileSync(join(tempDirGlobal, "restore.zip"), "utf8")).toBe("original content to preserve");
  });
});
