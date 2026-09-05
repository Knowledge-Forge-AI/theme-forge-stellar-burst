import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDirectorySnapshot,
  closeDirectorySnapshot,
  discoverDirectorySources,
  parseSourceMap,
  revalidateDirectoryDiscovery,
  type SourceMapV1,
} from "../src/index.js";
import { firstCode, makeTempDir, unwrap } from "./helpers.js";

const roots: string[] = [];
function root(): string { const value = makeTempDir("tfsb-directory-"); roots.push(value); mkdirSync(join(value, "icons")); return value; }
function map(identity = "basename"): SourceMapV1 {
  return unwrap(parseSourceMap(`schema_version = 1
source_root = "."

[[collection]]
id = "icons"
name = "Icons"
root = "icons"
identity = "${identity}"
prefix = ""
include_paths = []
include_trees = ["."]
exclude_paths = []
exclude_trees = []
`));
}
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe("read-only directory discovery", () => {
  it("returns deterministic relative DTOs and detects ordinary source changes", async () => {
    const source = root();
    mkdirSync(join(source, "icons", ".hidden"));
    writeFileSync(join(source, "icons", "a.svg"), '<svg><title>Private accessibility prose</title><path d="M 0 0 H 10"/></svg>\n');
    writeFileSync(join(source, "icons", ".hidden", "b.svg"), "<svg/>\n");
    const first = unwrap(await discoverDirectorySources(source, map()));
    const second = unwrap(await discoverDirectorySources(source, map()));
    expect(first.inventoryDigest).toBe(second.inventoryDigest);
    expect(first.files.map((file) => file.sourcePath)).toEqual(["icons/.hidden/b.svg", "icons/a.svg"]);
    expect(first.authenticated).toBe(false);
    expect(JSON.stringify(first)).not.toContain(source);
    expect(JSON.stringify(first)).not.toContain("<svg");
    expect(JSON.stringify(first)).not.toContain("Private accessibility prose");
    expect(JSON.stringify(first)).not.toContain("M 0 0 H 10");
    expect(JSON.stringify(first)).not.toMatch(/\b(?:dev|ino|mtime|ctime|HOME)\b/);
    expect(unwrap(await revalidateDirectoryDiscovery(source, map(), first))).toMatchObject({
      authenticated: false,
      portableContentUnchanged: true,
    });
    writeFileSync(join(source, "icons", "a.svg"), "<svg>changed</svg>\n");
    expect(firstCode(await revalidateDirectoryDiscovery(source, map(), first))).toBe("DIRECTORY_SOURCE_CHANGED");
  });

  it("enforces selected count at 128 and one over", async () => {
    const source = root();
    for (let index = 0; index < 128; index += 1) writeFileSync(join(source, "icons", `asset-${index}.svg`), "x");
    expect(unwrap(await discoverDirectorySources(source, map())).files).toHaveLength(128);
    writeFileSync(join(source, "icons", "asset-over.svg"), "x");
    expect(firstCode(await discoverDirectorySources(source, map()))).toBe("RESOURCE_LIMIT_EXCEEDED");
  });

  it("enforces per-file and selected aggregate byte limits at limit and one over", async () => {
    const one = root();
    writeFileSync(join(one, "icons", "exact.svg"), "");
    truncateSync(join(one, "icons", "exact.svg"), 8 * 1024 * 1024);
    expect(unwrap(await discoverDirectorySources(one, map())).files[0]?.byteCount).toBe(8 * 1024 * 1024);
    truncateSync(join(one, "icons", "exact.svg"), 8 * 1024 * 1024 + 1);
    expect(firstCode(await discoverDirectorySources(one, map()))).toBe("RESOURCE_LIMIT_EXCEEDED");

    const aggregate = root();
    for (const name of ["a", "b", "c", "d"]) {
      writeFileSync(join(aggregate, "icons", `${name}.svg`), "");
      truncateSync(join(aggregate, "icons", `${name}.svg`), 8 * 1024 * 1024);
    }
    expect(unwrap(await discoverDirectorySources(aggregate, map())).files.reduce((sum, file) => sum + file.byteCount, 0)).toBe(32 * 1024 * 1024);
    writeFileSync(join(aggregate, "icons", "e.svg"), "x");
    expect(firstCode(await discoverDirectorySources(aggregate, map()))).toBe("RESOURCE_LIMIT_EXCEEDED");
  });

  it("rejects traversed symlinks and selected hard links", async () => {
    const symlinked = root();
    writeFileSync(join(symlinked, "target.svg"), "x");
    symlinkSync(join(symlinked, "target.svg"), join(symlinked, "icons", "linked.svg"));
    expect(firstCode(await discoverDirectorySources(symlinked, map()))).toBe("DIRECTORY_TRAVERSED_SYMLINK");

    const hardlinked = root();
    writeFileSync(join(hardlinked, "icons", "a.svg"), "x");
    linkSync(join(hardlinked, "icons", "a.svg"), join(hardlinked, "outside-link"));
    expect(firstCode(await discoverDirectorySources(hardlinked, map()))).toBe("DIRECTORY_HARD_LINK");
  });

  it("honors exact exclusions and rejects a selected non-lowercase SVG suffix", async () => {
    const excluded = root();
    writeFileSync(join(excluded, "target.svg"), "x");
    symlinkSync(join(excluded, "target.svg"), join(excluded, "icons", "ignored.svg"));
    const excludedMap = unwrap(parseSourceMap(`schema_version = 1
source_root = "."
[[collection]]
id = "icons"
name = "Icons"
root = "icons"
identity = "basename"
prefix = ""
include_paths = []
include_trees = ["."]
exclude_paths = ["ignored.svg"]
exclude_trees = []
`));
    expect(unwrap(await discoverDirectorySources(excluded, excludedMap)).files).toEqual([]);

    const nonLowercase = root();
    writeFileSync(join(nonLowercase, "icons", "upper.SVG"), "x");
    expect(firstCode(await discoverDirectorySources(nonLowercase, map()))).toBe("SOURCE_MAP_INVALID_SVG_PATH");
  });

  it("retains the confined parent inventory for exact path selectors", async () => {
    const source = root();
    mkdirSync(join(source, "icons", "nested"));
    writeFileSync(join(source, "icons", "nested", "exact.svg"), "x");
    writeFileSync(join(source, "icons", "unselected.svg"), "x");
    const exactMap = unwrap(parseSourceMap(`schema_version = 1
source_root = "."
[[collection]]
id = "icons"
name = "Icons"
root = "icons"
identity = "basename"
prefix = ""
include_paths = ["nested/exact.svg"]
include_trees = []
exclude_paths = []
exclude_trees = []
`));
    const result = unwrap(await discoverDirectorySources(source, exactMap));
    expect(result.files.map((file) => file.sourcePath)).toEqual(["icons/nested/exact.svg"]);
    expect(result.directories).toEqual([
      { path: "icons", kind: "directory", children: [{ name: "nested", kind: "directory" }, { name: "unselected.svg", kind: "file" }] },
      { path: "icons/nested", kind: "directory", children: [{ name: "exact.svg", kind: "file" }] },
    ]);
  });

  it.skipIf(process.platform === "win32")("rejects traversed special files", async () => {
    const source = root();
    execFileSync("mkfifo", [join(source, "icons", "pipe")]);
    expect(firstCode(await discoverDirectorySources(source, map()))).toBe("DIRECTORY_SPECIAL_FILE");
  });

  it("keeps read-only discovery separate from mutation-grade capability", async () => {
    const source = root();
    const physicalSource = realpathSync(source);
    const result = await createDirectorySnapshot(physicalSource, map());
    expect(JSON.stringify(result)).not.toContain(source);
    if (result.ok) {
      expect(result.value).toMatchObject({ authenticated: true, backend: "native-addon-posix-openat-v1" });
      closeDirectorySnapshot(result.value);
    } else {
      expect(firstCode(result)).toBe("DIRECTORY_SNAPSHOT_UNSUPPORTED");
      expect(result).not.toHaveProperty("value");
    }
  });
});
