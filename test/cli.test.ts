import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { TOOL_VERSION } from "../src/version.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureProject(): Promise<{ root: string; archive: string }> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-cli-"));
  roots.push(root);
  const svg = await readFile(
    join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1/theme-forge-terminal-nova-mark.svg"),
  );
  const archive = join(root, "mark.zip");
  await writeFile(
    archive,
    zipSync(
      { "theme-forge-terminal-nova-mark.svg": svg },
      { level: 0, mtime: new Date("1980-01-02T00:00:00Z") },
    ),
  );
  return { root, archive };
}

async function fullFixtureProject(): Promise<{ root: string; archive: string }> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-cli-full-"));
  roots.push(root);
  const fixture = join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1");
  const files: Record<string, Uint8Array> = {};
  for (const name of (await readdir(fixture)).sort()) {
    files[name] = await readFile(join(fixture, name));
  }
  const archive = join(root, "terminal-nova.zip");
  await writeFile(
    archive,
    zipSync(files, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }),
  );
  return { root, archive };
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("tfsb CLI", () => {
  it("prints help and the authoritative package version without requiring a project", async () => {
    for (const flag of ["--help", "-h"]) {
      const help = capture();
      expect(await runCli([flag], "/not/a/project", help.io)).toBe(0);
      expect(help.stdout()).toContain("Usage:");
      expect(help.stdout()).toContain("tfsb import");
      expect(help.stdout()).toContain("tfsb reconcile");
      expect(help.stdout()).toContain("tfsb build");
      expect(help.stdout()).toContain("tfsb install");
      expect(help.stdout()).toContain("tfsb check");
      expect(help.stdout()).toContain("tfsb list");
      expect(help.stdout()).toContain("--select <entry>");
      expect(help.stdout()).toContain("--dry-run");
      expect(help.stderr()).toBe("");
    }
    for (const flag of ["--version", "-v"]) {
      const version = capture();
      expect(await runCli([flag], "/not/a/project", version.io)).toBe(0);
      expect(version.stdout()).toBe(`${TOOL_VERSION}\n`);
      expect(version.stderr()).toBe("");
    }
  });

  it("runs import, discovered-root build, clean check, and list", async () => {
    const { root, archive } = await fixtureProject();
    const dryRun = capture();
    expect(
      await runCli(["import", archive, "--root", root, "--schema", "1", "--dry-run"], root, dryRun.io),
    ).toBe(0);
    expect(dryRun.stdout()).toContain("  .tfsb/project.toml\n");
    expect(dryRun.stdout()).not.toContain("schema_version = 1");
    await expect(access(join(root, ".tfsb"))).rejects.toMatchObject({ code: "ENOENT" });
    const imported = capture();
    expect(await runCli(["import", archive, "--root", root, "--schema", "1"], root, imported.io)).toBe(0);
    expect(imported.stdout()).toContain("Imported: 1 asset(s)");

    const nested = join(root, "nested/path");
    await mkdir(nested, { recursive: true });
    const built = capture();
    expect(await runCli(["build"], nested, built.io)).toBe(0);
    expect(built.stdout()).toContain("Built: 1 SVG(s)");

    const checked = capture();
    expect(await runCli(["check"], nested, checked.io)).toBe(0);
    expect(checked.stdout()).toContain("canonical: valid\nsource: clean\nbuild: clean\ninstall: clean");

    const before = await readFile(join(root, ".tfsb/project.toml"), "utf8");
    const listed = capture();
    expect(await runCli(["list", "--root", root], nested, listed.io)).toBe(0);
    expect(listed.stdout()).toContain("theme-forge-terminal-nova-mark");
    expect(listed.stdout()).toContain("install: (none)");
    expect(await readFile(join(root, ".tfsb/project.toml"), "utf8")).toBe(before);
  });

  it("returns stable usage errors and check exit code 2 for valid drift", async () => {
    const usage = capture();
    expect(await runCli(["build", "extra"], process.cwd(), usage.io)).toBe(1);
    expect(usage.stderr()).toContain("USAGE_ERROR: build does not accept positional arguments.");

    const { root, archive } = await fixtureProject();
    expect(await runCli(["import", archive, "--root", root, "--schema", "1"], root, capture().io)).toBe(0);
    const drift = capture();
    expect(await runCli(["check", "--root", root], root, drift.io)).toBe(2);
    expect(drift.stdout()).toContain("source: changed");
    expect(drift.stdout()).toContain("build: drift");
  });

  it("keeps a six-asset import dry-run concise", async () => {
    const { root, archive } = await fullFixtureProject();
    const dryRun = capture();
    expect(await runCli(["import", archive, "--root", root, "--schema", "1", "--dry-run"], root, dryRun.io)).toBe(0);
    expect(dryRun.stdout().split("\n").filter(Boolean)).toHaveLength(8);
    expect(dryRun.stdout()).toContain("Import dry-run: 6 asset(s) (schema 1)\n");
    expect(dryRun.stdout()).toContain("  .tfsb/assets/favicon.toml\n");
    expect(dryRun.stdout()).toContain("  .tfsb/assets/theme-forge-terminal-nova-stacked.toml\n");
    expect(dryRun.stdout()).not.toContain("schema_version = 1");
    expect(dryRun.stdout()).not.toContain("[[element]]");
  });

  it("names missing, extra, and different build paths in check output", async () => {
    const { root, archive } = await fullFixtureProject();
    expect(await runCli(["import", archive, "--root", root, "--schema", "1"], root, capture().io)).toBe(0);
    expect(await runCli(["build", "--root", root], root, capture().io)).toBe(0);
    await rm(join(root, "brand/dist/favicon.svg"));
    await writeFile(join(root, "brand/dist/theme-forge-terminal-nova-mark.svg"), "tampered");
    await writeFile(join(root, "brand/dist/unexpected.svg"), "unexpected");

    const drift = capture();
    expect(await runCli(["check", "--root", root], root, drift.io)).toBe(2);
    expect(drift.stdout()).toContain("missing: favicon.svg");
    expect(drift.stdout()).toContain("extra: unexpected.svg");
    expect(drift.stdout()).toContain("different: theme-forge-terminal-nova-mark.svg");
  });

  it("reports an actionable error for an unknown command", async () => {
    const unknown = capture();
    expect(await runCli(["unknown"], "/not/a/project", unknown.io)).toBe(1);
    expect(unknown.stdout()).toBe("");
    expect(unknown.stderr()).toContain("USAGE_ERROR: Unknown command 'unknown'.");
    expect(unknown.stderr()).toContain("Usage:");
  });

  it("reports invalid canonical input as exit 1 rather than drift", async () => {
    const { root, archive } = await fixtureProject();
    expect(await runCli(["import", archive, "--root", root, "--schema", "1"], root, capture().io)).toBe(0);
    await writeFile(join(root, ".tfsb/project.toml"), "schema_version = [");
    const checked = capture();
    expect(await runCli(["check", "--root", root], root, checked.io)).toBe(1);
    expect(checked.stderr()).toContain("TOML_SYNTAX");
    expect(checked.stdout()).toBe("");
  });

  it("supports provenance import and deterministic reconcile exit behavior", async () => {
    const { root, archive } = await fixtureProject();
    const imported = capture();
    expect(await runCli(["import", archive, "--root", root, "--schema", "1", "--record-provenance"], root, imported.io)).toBe(0);
    await access(join(root, ".tfsb/provenance.json"));

    const clean = capture();
    expect(await runCli(["reconcile", archive, "--root", root], root, clean.io)).toBe(0);
    expect(clean.stdout()).toContain("theme-forge-terminal-nova-mark: UNCHANGED");
    expect(clean.stdout()).toContain("mutation none");
    expect(clean.stdout()).not.toContain(root);
    expect(clean.stderr()).not.toContain(root);

    const conflictUsage = capture();
    expect(await runCli(["reconcile", archive, "--root", root, "--dry-run", "--apply"], root, conflictUsage.io)).toBe(1);
    expect(conflictUsage.stderr()).toContain("--dry-run and --apply conflict");

    // Modify canonical file to create human canonical edit (pending drift)
    const tomlPath = join(root, ".tfsb/assets/theme-forge-terminal-nova-mark.toml");
    await writeFile(tomlPath, (await readFile(tomlPath, "utf8")).replace("Terminal Nova mark", "human canonical mark"));

    const pending = capture();
    expect(await runCli(["reconcile", archive, "--root", root], root, pending.io)).toBe(2);
    expect(pending.stdout()).toContain("theme-forge-terminal-nova-mark: CANONICAL_EDITED");
    expect(pending.stdout()).toContain("mutation none");

    // Blocked apply when conflict exists
    const candidateSvg = await readFile(join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1/favicon.svg"));
    const conflictArchive = join(root, "conflict.zip");
    await writeFile(
      conflictArchive,
      zipSync(
        { "theme-forge-terminal-nova-mark.svg": candidateSvg },
        { level: 0, mtime: new Date("1980-01-02T00:00:00Z") },
      ),
    );

    const blockedApply = capture();
    expect(await runCli(["reconcile", conflictArchive, "--root", root, "--apply"], root, blockedApply.io)).toBe(2);
    expect(blockedApply.stdout()).toContain("theme-forge-terminal-nova-mark: CONFLICT");
    expect(blockedApply.stdout()).toContain("mutation none");

    // Successful apply with resolution
    const resolvedApply = capture();
    expect(await runCli([
      "reconcile", conflictArchive, "--root", root, "--apply",
      "--resolve", "theme-forge-terminal-nova-mark=archive",
    ], root, resolvedApply.io)).toBe(0);
    expect(resolvedApply.stdout()).toContain("theme-forge-terminal-nova-mark: CONFLICT");
    expect(resolvedApply.stdout()).toContain("accept explicit archive resolution");
    expect(resolvedApply.stdout()).toContain("mutation applied");
  });

  it("supports bundle command with dry-run, output, selection, and force", async () => {
    const { root, archive } = await fullFixtureProject();
    expect(await runCli(["import", archive, "--root", root, "--schema", "1"], root, capture().io)).toBe(0);

    // Bundle dry-run
    const dryRun = capture();
    expect(await runCli(["bundle", "--root", root, "--output", "dist.zip", "--dry-run"], root, dryRun.io)).toBe(0);
    expect(dryRun.stdout()).toContain("Bundle dry-run: dist.zip");
    expect(dryRun.stdout()).toContain("6 asset(s)");
    expect(dryRun.stdout()).toContain("tfsb-manifest.json");

    // Real bundle write
    const bundled = capture();
    expect(await runCli(["bundle", "--root", root, "--output", "dist.zip"], root, bundled.io)).toBe(0);
    expect(bundled.stdout()).toContain("Bundled: dist.zip");
    await access(join(root, "dist.zip"));

    // Existing bundle without force fails
    const exists = capture();
    expect(await runCli(["bundle", "--root", root, "--output", "dist.zip"], root, exists.io)).toBe(1);
    expect(exists.stderr()).toContain("BUNDLE_TARGET_EXISTS");

    // Existing bundle with force succeeds
    const forced = capture();
    expect(await runCli(["bundle", "--root", root, "--output", "dist.zip", "--force"], root, forced.io)).toBe(0);
    expect(forced.stdout()).toContain("Bundled (replaced existing): dist.zip");

    // Import with --manifest into new root
    const newRoot = await mkdtemp(join(tmpdir(), "tfsb-cli-manifest-"));
    roots.push(newRoot);
    const manifestImport = capture();
    expect(
      await runCli(
        ["import", join(root, "dist.zip"), "--root", newRoot, "--schema", "1", "--manifest", "--record-provenance"],
        newRoot,
        manifestImport.io,
      ),
    ).toBe(0);
    expect(manifestImport.stdout()).toContain("Imported: 6 asset(s)");
    await access(join(newRoot, ".tfsb/provenance.json"));
  });
});
