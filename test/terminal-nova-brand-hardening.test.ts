import { readFile, rm, mkdtemp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  TERMINAL_NOVA_ASSETS,
  generateTerminalNovaBrandProject,
  loadProductModules,
  sha256Hex,
} from "../tools/qualify-terminal-nova-brand.mjs";

const scratchDirs: string[] = [];

afterEach(async () => {
  for (const directory of scratchDirs.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixtureAssetMap() {
  const fixtureRoot = resolve("test/fixtures/tftn-production-v1");
  const entries: Record<string, { bytes: Uint8Array; sha256: string }> = {};
  for (const asset of TERMINAL_NOVA_ASSETS) {
    const bytes = await readFile(join(fixtureRoot, asset.filename));
    entries[asset.id] = { bytes, sha256: sha256Hex(bytes) };
  }
  return { entries, readme: await readFile(join(fixtureRoot, "brand-README.md")) };
}

describe("TFSB48 Terminal Nova portable brand behavior", () => {
  it("keeps the ten-asset contract and explicit destination ownership visible", () => {
    expect(TERMINAL_NOVA_ASSETS).toHaveLength(10);
    expect(new Set(TERMINAL_NOVA_ASSETS.map((asset) => asset.id)).size).toBe(10);
    expect(TERMINAL_NOVA_ASSETS.filter((asset) => asset.destinations.length === 0)).toHaveLength(2);
    expect(TERMINAL_NOVA_ASSETS.flatMap((asset) => asset.destinations)).toHaveLength(9);
  });

  it("checks a generated project from the committed portable fixture without a private checkout", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "tfsb48-portable-project-"));
    scratchDirs.push(scratch);
    const fixture = await fixtureAssetMap();
    await generateTerminalNovaBrandProject(join(scratch, "project"), fixture.entries, fixture.readme);

    const product = await loadProductModules();
    const buildPlan = await product.planBuild(join(scratch, "project"));
    await product.executeBuild(buildPlan);
    const result = await product.checkProject(join(scratch, "project"));
    expect(result.valid).toBe(true);
    expect(result.build.missing).toHaveLength(0);
    expect(result.build.extra).toHaveLength(0);
    expect(result.build.different).toHaveLength(0);
    expect(result.brand?.valid).toBe(true);
    expect(result.brand?.qa?.semanticFail).toBe(0);
    expect(result.brand?.qa?.semanticError).toBe(0);
  }, 60_000);

  it("does not use a HOME-derived canonical source when invoked without explicit arguments", () => {
    const script = resolve("tools/qualify-terminal-nova-brand.mjs");
    const childEnv = { ...process.env };
    delete childEnv.TFSB_TERMINAL_NOVA_SOURCE;
    let output = "";
    try {
      execFileSync(process.execPath, [script], { cwd: resolve("."), env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      throw new Error("operator CLI unexpectedly succeeded without explicit arguments");
    } catch (error) {
      const failure = error as { stdout?: string };
      output = String(failure.stdout ?? "");
    }
    const result = JSON.parse(output) as { status: string; blockers: string[] };
    expect(result.status).toBe("unavailable");
    expect(result.blockers).toContain("TFSB_SOURCE_REQUIRED");
    expect(output).not.toMatch(/\/Users\/|\/var\/folders\//u);
  });
});
