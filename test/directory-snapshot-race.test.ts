import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDirectorySnapshot,
  closeDirectorySnapshot,
  discoverDirectorySources,
  getDirectorySnapshotCapability,
  parseSourceMap,
  qualifyDirectorySnapshotPlatform,
  revalidateDirectoryDiscovery,
  type DirectoryDiscoveryResult,
  type SourceMapV1,
} from "../src/index.js";
import { firstCode, makeTempDir, unwrap } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const sourceMap = unwrap(parseSourceMap(`schema_version = 1
source_root = "."
[[collection]]
id = "icons"
name = "Icons"
root = "icons"
identity = "basename"
prefix = ""
include_paths = []
include_trees = ["."]
exclude_paths = []
exclude_trees = []
`));

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function naiveParentPathRead(root: string, afterParentCheck: () => void, beforeParentRecheck: () => void): string {
  const parent = join(root, "icons");
  const parentBefore = lstatSync(parent);
  afterParentCheck();
  const path = join(parent, "asset.svg");
  const pathBefore = lstatSync(path);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedBefore = fstatSync(descriptor);
    if (!sameIdentity(pathBefore, openedBefore)) throw new Error("leaf identity changed");
    const bytes = readFileSync(descriptor, "utf8");
    const openedAfter = fstatSync(descriptor);
    if (!sameIdentity(openedBefore, openedAfter)) throw new Error("descriptor identity changed");
    beforeParentRecheck();
    if (!sameIdentity(parentBefore, lstatSync(parent))) throw new Error("parent identity changed");
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

describe("directory mutation-grade platform qualification", () => {
  it("reports the native capability without erasing the unsupported shape", async () => {
    const root = makeTempDir("tfsb-qualification-");
    roots.push(root);
    mkdirSync(`${root}/icons`);
    const physicalRoot = realpathSync(root);
    const qualification = unwrap(await qualifyDirectorySnapshotPlatform(physicalRoot));
    const capability = getDirectorySnapshotCapability(physicalRoot);
    expect(qualification.supported).toBe(capability.supported);
    if (capability.supported) {
      expect(qualification).toMatchObject({
        supported: true,
        backend: "native-addon-posix-openat-v1",
        rootHandleOpened: true,
        handleRelativeDirectoryOpen: true,
        handleRelativeFileOpen: true,
        handleRelativeStat: true,
        noFollowLeafOpen: true,
        descriptorIdentityCheck: true,
      });
    } else {
      expect(capability).toMatchObject({
        supported: false,
        code: "DIRECTORY_SNAPSHOT_UNSUPPORTED",
        missingPrimitive: "handle-relative-openat-equivalent",
      });
    }
  });

  it("either authenticates with the exact backend or fails closed without leaking paths", async () => {
    const root = makeTempDir("tfsb-failclosed-");
    roots.push(root);
    mkdirSync(join(root, "icons"));
    const physicalRoot = realpathSync(root);
    const result = await createDirectorySnapshot(physicalRoot, sourceMap);
    expect(JSON.stringify(result)).not.toContain(root);
    if (result.ok) {
      expect(result.value).toMatchObject({ authenticated: true, backend: "native-addon-posix-openat-v1" });
      closeDirectorySnapshot(result.value);
    } else {
      expect(firstCode(result)).toBe("DIRECTORY_SNAPSHOT_UNSUPPORTED");
      expect(result).not.toHaveProperty("value");
    }
  });

  it("demonstrates that an intermediate swap-back defeats path-based parent and leaf checks", () => {
    const root = makeTempDir("tfsb-parent-race-");
    roots.push(root);
    mkdirSync(join(root, "icons"));
    mkdirSync(join(root, "alternate"));
    writeFileSync(join(root, "icons", "asset.svg"), "original");
    writeFileSync(join(root, "alternate", "asset.svg"), "substituted");
    const observed = naiveParentPathRead(root, () => {
      renameSync(join(root, "icons"), join(root, "holding"));
      renameSync(join(root, "alternate"), join(root, "icons"));
    }, () => {
      renameSync(join(root, "icons"), join(root, "alternate"));
      renameSync(join(root, "holding"), join(root, "icons"));
    });
    expect(observed).toBe("substituted");
    expect(readFileSync(join(root, "icons", "asset.svg"), "utf8")).toBe("original");
  });

  it("shows leaf no-follow and descriptor checks are useful but do not anchor parent traversal", () => {
    const root = makeTempDir("tfsb-leaf-evidence-");
    roots.push(root);
    mkdirSync(join(root, "icons"));
    writeFileSync(join(root, "target.svg"), "x");
    symlinkSync(join(root, "target.svg"), join(root, "icons", "linked.svg"));
    expect(() => openSync(join(root, "icons", "linked.svg"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))).toThrow();

    const mutable = join(root, "icons", "mutable.svg");
    writeFileSync(mutable, "x");
    const descriptor = openSync(mutable, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(descriptor);
      truncateSync(mutable, 2);
      expect(sameIdentity(before, fstatSync(descriptor))).toBe(true);
      expect(fstatSync(descriptor).size).not.toBe(before.size);
    } finally {
      closeSync(descriptor);
    }
  });

  it("detects root replacement across discovery revalidation", async () => {
    const parent = makeTempDir("tfsb-root-race-");
    roots.push(parent);
    const rootA = join(parent, "source");
    const rootB = join(parent, "alternate");
    mkdirSync(join(rootA, "icons"), { recursive: true });
    mkdirSync(join(rootB, "icons"), { recursive: true });
    writeFileSync(join(rootA, "icons", "asset.svg"), "from-a");
    writeFileSync(join(rootB, "icons", "asset.svg"), "from-b");

    const first = unwrap(await discoverDirectorySources(rootA, sourceMap));
    renameSync(rootA, join(parent, "original"));
    renameSync(rootB, rootA);

    expect(firstCode(await revalidateDirectoryDiscovery(rootA, sourceMap, first))).toBe("DIRECTORY_SOURCE_CHANGED");
  });

  it("detects intermediate directory replacement across discovery revalidation", async () => {
    const root = makeTempDir("tfsb-intermediate-race-");
    roots.push(root);
    mkdirSync(join(root, "icons"));
    mkdirSync(join(root, "alternate"));
    writeFileSync(join(root, "icons", "asset.svg"), "original");
    writeFileSync(join(root, "alternate", "asset.svg"), "replaced");

    const first = unwrap(await discoverDirectorySources(root, sourceMap));
    renameSync(join(root, "icons"), join(root, "holding"));
    renameSync(join(root, "alternate"), join(root, "icons"));

    expect(firstCode(await revalidateDirectoryDiscovery(root, sourceMap, first))).toBe("DIRECTORY_SOURCE_CHANGED");
  });

  it("detects final-file symlink swap during discovery", async () => {
    const root = makeTempDir("tfsb-symlink-swap-");
    roots.push(root);
    mkdirSync(join(root, "icons"));
    writeFileSync(join(root, "target.svg"), "x");
    symlinkSync(join(root, "target.svg"), join(root, "icons", "asset.svg"));

    expect(firstCode(await discoverDirectorySources(root, sourceMap))).toBe("DIRECTORY_TRAVERSED_SYMLINK");
  });

  it("detects truncate or extend across discovery revalidation", async () => {
    const root = makeTempDir("tfsb-truncate-race-");
    roots.push(root);
    mkdirSync(join(root, "icons"));
    const path = join(root, "icons", "asset.svg");
    writeFileSync(path, "short content");

    const first = unwrap(await discoverDirectorySources(root, sourceMap));
    truncateSync(path, 2);

    expect(firstCode(await revalidateDirectoryDiscovery(root, sourceMap, first))).toBe("DIRECTORY_SOURCE_CHANGED");
  });

  it("keeps equal-byte recreation visibly unauthenticated", async () => {
    const root = makeTempDir("tfsb-recreate-");
    roots.push(root);
    mkdirSync(join(root, "icons"));
    const path = join(root, "icons", "asset.svg");
    writeFileSync(path, "same bytes");
    const first = unwrap(await discoverDirectorySources(root, sourceMap));
    unlinkSync(path);
    writeFileSync(path, "same bytes");
    expect(unwrap(await revalidateDirectoryDiscovery(root, sourceMap, first))).toMatchObject({
      authenticated: false,
      portableContentUnchanged: true,
    });
  });

  it("detects selected-view insertion, deletion, and source-map changes in portable revalidation", async () => {
    const root = makeTempDir("tfsb-revalidation-");
    roots.push(root);
    mkdirSync(join(root, "icons"));
    const asset = join(root, "icons", "asset.svg");
    writeFileSync(asset, "x");
    const first: DirectoryDiscoveryResult = unwrap(await discoverDirectorySources(root, sourceMap));
    const inserted = join(root, "icons", "inserted.svg");
    writeFileSync(inserted, "x");
    expect(firstCode(await revalidateDirectoryDiscovery(root, sourceMap, first))).toBe("DIRECTORY_SOURCE_CHANGED");
    unlinkSync(inserted);
    unlinkSync(asset);
    expect(firstCode(await revalidateDirectoryDiscovery(root, sourceMap, first))).toBe("DIRECTORY_SOURCE_CHANGED");
    writeFileSync(asset, "x");
    const changedMap: SourceMapV1 = { ...sourceMap, collections: sourceMap.collections.map((collection) => ({ ...collection, name: "Changed" })) };
    expect(firstCode(await revalidateDirectoryDiscovery(root, changedMap, first))).toBe("DIRECTORY_SOURCE_CHANGED");
  });

  it("rejects hard-linked, symlinked, and special files in directory traversal", async () => {
    const hardRoot = makeTempDir("tfsb-hardlink-");
    roots.push(hardRoot);
    mkdirSync(join(hardRoot, "icons"));
    const hardPath = join(hardRoot, "icons", "asset.svg");
    writeFileSync(hardPath, "x");
    linkSync(hardPath, join(hardRoot, "hard-link"));
    expect(firstCode(await discoverDirectorySources(hardRoot, sourceMap))).toBe("DIRECTORY_HARD_LINK");

    const symRoot = makeTempDir("tfsb-symlink-");
    roots.push(symRoot);
    mkdirSync(join(symRoot, "icons"));
    mkdirSync(join(symRoot, "target"));
    symlinkSync(join(symRoot, "target"), join(symRoot, "icons", "linked"));
    expect(firstCode(await discoverDirectorySources(symRoot, sourceMap))).toBe("DIRECTORY_TRAVERSED_SYMLINK");

    if (process.platform !== "win32") {
      const specialRoot = makeTempDir("tfsb-special-");
      roots.push(specialRoot);
      mkdirSync(join(specialRoot, "icons"));
      execFileSync("mkfifo", [join(specialRoot, "icons", "pipe")]);
      expect(firstCode(await discoverDirectorySources(specialRoot, sourceMap))).toBe("DIRECTORY_SPECIAL_FILE");
    }
  });
});
