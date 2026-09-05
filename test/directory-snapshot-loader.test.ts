import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const roots: string[] = [];
const artifact = process.platform === "linux" ? "linux-x64-gnu" : `darwin-${process.arch}`;
const builtAddon = join(repositoryRoot, "native/directory-snapshot/prebuilds", artifact, "native-addon-posix-openat-v1.node");

function fixture(mode: "present" | "missing" | "corrupt"): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tfsb-loader-"));
  roots.push(root);
  mkdirSync(join(root, "dist"));
  cpSync(join(repositoryRoot, "dist/directory-snapshot-native.js"), join(root, "dist/directory-snapshot-native.js"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  if (mode !== "missing") {
    const directory = join(root, "native/directory-snapshot/prebuilds", artifact);
    mkdirSync(directory, { recursive: true });
    const target = join(directory, "native-addon-posix-openat-v1.node");
    if (mode === "present") cpSync(builtAddon, target);
    else writeFileSync(target, "not a native addon");
  }
  return root;
}

function probe(root: string): Record<string, unknown> {
  const loader = join(root, "dist/directory-snapshot-native.js");
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const loaded = await import(${JSON.stringify(`file://${loader}`)});
    const result = loaded.loadDirectorySnapshotNative();
    process.stdout.write(JSON.stringify(result.ok
      ? { ok: true, artifact: result.artifact, backend: result.addon.backend, abiVersion: result.addon.abiVersion }
      : result));
  `], { encoding: "utf8" });
  return JSON.parse(output) as Record<string, unknown>;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("deterministic native artifact loader", () => {
  it.runIf(existsSync(builtAddon))("loads only the exact current artifact and verifies its identity", () => {
    expect(probe(fixture("present"))).toEqual({
      ok: true,
      artifact,
      backend: "native-addon-posix-openat-v1",
      abiVersion: 1,
    });
  });

  it.each(["missing", "corrupt"] as const)("fails closed for a %s artifact without leaking its path", (mode) => {
    const root = fixture(mode);
    const result = probe(root);
    expect(result).toEqual({ ok: false, artifact, reason: "artifact-missing-or-corrupt" });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toMatch(/(?:Users|home|private|\.node)/i);
  });
});
