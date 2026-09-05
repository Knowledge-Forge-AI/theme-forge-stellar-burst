import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeDirectorySnapshot,
  createDirectorySnapshot,
  getDirectorySnapshotCapability,
  parseSourceMap,
  revalidateDirectorySnapshot,
} from "../src/index.js";
import { firstCode, unwrap } from "./helpers.js";

const roots: string[] = [];

function physicalTempRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tfsb-native-"));
  roots.push(root);
  return root;
}

function sourceMap() {
  return unwrap(parseSourceMap(`schema_version = 1
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
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const nativeAvailable = getDirectorySnapshotCapability(realpathSync(tmpdir())).supported;

describe.runIf(nativeAvailable)("native mutation-grade directory snapshots", () => {
  it("advertises only the exact qualified local artifact and filesystem", () => {
    const root = physicalTempRoot();
    const capability = getDirectorySnapshotCapability(root);
    expect(capability).toMatchObject({
      supported: true,
      backend: "native-addon-posix-openat-v1",
      platformArtifact: process.platform === "linux" ? "linux-x64-gnu" : `darwin-${process.arch}`,
      filesystemClass: "qualified-local",
    });
    expect(JSON.stringify(capability)).not.toContain(root);
  });

  it("creates and revalidates a sanitized authenticated snapshot", async () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "icons"));
    writeFileSync(join(root, "icons", "asset.svg"), "<svg/>\n");
    const map = sourceMap();
    const snapshot = unwrap(await createDirectorySnapshot(root, map));
    expect(snapshot).toMatchObject({ authenticated: true, backend: "native-addon-posix-openat-v1" });
    expect(snapshot.files.map((file) => file.sourcePath)).toEqual(["icons/asset.svg"]);
    expect(JSON.stringify(snapshot)).not.toContain(root);
    expect(JSON.stringify(snapshot)).not.toContain("<svg");
    expect(JSON.stringify(snapshot)).not.toMatch(/\b(?:dev|ino|fd|pointer|mtime|ctime)\b/);
    expect(() => Object.assign(snapshot.files[0]!, { sourcePath: "attacker.svg" })).toThrow(TypeError);
    expect(unwrap(await revalidateDirectorySnapshot(snapshot, map))).toMatchObject({
      authenticated: true,
      portableContentUnchanged: true,
    });
    closeDirectorySnapshot(snapshot);
    closeDirectorySnapshot(snapshot);
    expect(firstCode(await revalidateDirectorySnapshot(snapshot, map))).toBe("DIRECTORY_SNAPSHOT_CLOSED");
  });

  it("authenticates optional companion absence and present bytes through parent inventory", async () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "svg"));
    writeFileSync(join(root, "svg", "asset.svg"), "<svg/>\n");
    const map = unwrap(parseSourceMap(`schema_version = 1
source_root = "."
[[collection]]
id = "brand"
name = "Brand"
root = "."
identity = "basename"
prefix = ""
include_paths = []
include_trees = ["svg"]
exclude_paths = []
exclude_trees = []
`));
    const absent = unwrap(await createDirectorySnapshot(root, map, ["brand"], { optionalCompanions: [{ collectionId: "brand", sourcePath: "README.md" }] }));
    expect(absent.companions).toEqual([]);
    writeFileSync(join(root, "README.md"), "legal\n");
    expect(firstCode(await revalidateDirectorySnapshot(absent, map))).toBe("DIRECTORY_SOURCE_CHANGED");
    closeDirectorySnapshot(absent);

    const present = unwrap(await createDirectorySnapshot(root, map, ["brand"], { optionalCompanions: [{ collectionId: "brand", sourcePath: "README.md" }] }));
    expect(present.companions).toMatchObject([{ sourcePath: "README.md", byteCount: 6 }]);
    closeDirectorySnapshot(present);
  });

  it("treats percent-like and Unicode component names as literal data", async () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "%2e%2e"));
    mkdirSync(join(root, "%2e%2e", "icons"));
    writeFileSync(join(root, "%2e%2e", "icons", "lookalike-．.svg"), "literal");
    const map = sourceMap();
    const snapshot = unwrap(await createDirectorySnapshot(join(root, "%2e%2e"), map));
    expect(snapshot.files.map((file) => file.sourcePath)).toEqual(["icons/lookalike-．.svg"]);
    closeDirectorySnapshot(snapshot);
  });

  it("rejects equal-byte recreation and persistent source-root retargeting", async () => {
    const parent = physicalTempRoot();
    const source = join(parent, "source");
    const attacker = join(parent, "attacker");
    mkdirSync(join(source, "icons"), { recursive: true });
    mkdirSync(join(attacker, "icons"), { recursive: true });
    const file = join(source, "icons", "asset.svg");
    writeFileSync(file, "same");
    writeFileSync(join(attacker, "icons", "asset.svg"), "attacker");
    const map = sourceMap();
    const recreated = unwrap(await createDirectorySnapshot(source, map));
    unlinkSync(file);
    writeFileSync(file, "same");
    expect(firstCode(await revalidateDirectorySnapshot(recreated, map))).toBe("DIRECTORY_SOURCE_CHANGED");
    closeDirectorySnapshot(recreated);

    const retargeted = unwrap(await createDirectorySnapshot(source, map));
    renameSync(source, join(parent, "original"));
    renameSync(attacker, source);
    expect(firstCode(await revalidateDirectorySnapshot(retargeted, map))).toBe("DIRECTORY_SOURCE_CHANGED");
    closeDirectorySnapshot(retargeted);
  });

  it("ignores a harmless transient retarget that ends before revalidation", async () => {
    const parent = physicalTempRoot();
    const source = join(parent, "source");
    const attacker = join(parent, "attacker");
    mkdirSync(join(source, "icons"), { recursive: true });
    mkdirSync(join(attacker, "icons"), { recursive: true });
    writeFileSync(join(source, "icons", "asset.svg"), "original");
    writeFileSync(join(attacker, "icons", "asset.svg"), "attacker");
    const map = sourceMap();
    const snapshot = unwrap(await createDirectorySnapshot(source, map));
    renameSync(source, join(parent, "holding"));
    renameSync(attacker, source);
    renameSync(source, attacker);
    renameSync(join(parent, "holding"), source);
    expect(unwrap(await revalidateDirectorySnapshot(snapshot, map))).toMatchObject({ authenticated: true });
    closeDirectorySnapshot(snapshot);
  });

  it("rejects selected hard links", async () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "icons"));
    const file = join(root, "icons", "asset.svg");
    writeFileSync(file, "x");
    linkSync(file, join(root, "second-link"));
    expect(firstCode(await createDirectorySnapshot(root, sourceMap()))).toBe("DIRECTORY_HARD_LINK");
  });

  it("detects intermediate replacement and a nested attacker tree with matching names", async () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "icons", "nested"), { recursive: true });
    mkdirSync(join(root, "attacker", "nested"), { recursive: true });
    writeFileSync(join(root, "icons", "nested", "asset.svg"), "original");
    writeFileSync(join(root, "attacker", "nested", "asset.svg"), "attacker");
    const map = sourceMap();
    const snapshot = unwrap(await createDirectorySnapshot(root, map));
    renameSync(join(root, "icons"), join(root, "holding"));
    renameSync(join(root, "attacker"), join(root, "icons"));
    expect(firstCode(await revalidateDirectorySnapshot(snapshot, map))).toBe("DIRECTORY_SOURCE_CHANGED");
    closeDirectorySnapshot(snapshot);
  });

  it("detects final-file symlink replacement", async () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "icons"));
    const file = join(root, "icons", "asset.svg");
    writeFileSync(file, "original");
    writeFileSync(join(root, "attacker.svg"), "attacker");
    const map = sourceMap();
    const snapshot = unwrap(await createDirectorySnapshot(root, map));
    unlinkSync(file);
    symlinkSync(join(root, "attacker.svg"), file);
    expect(firstCode(await revalidateDirectorySnapshot(snapshot, map))).toBe("DIRECTORY_SOURCE_CHANGED");
    closeDirectorySnapshot(snapshot);
  });

  it("detects deterministic truncate and extend mutations", async () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "icons"));
    const file = join(root, "icons", "asset.svg");
    writeFileSync(file, "original content");
    const map = sourceMap();
    const truncated = unwrap(await createDirectorySnapshot(root, map));
    truncateSync(file, 2);
    expect(firstCode(await revalidateDirectorySnapshot(truncated, map))).toBe("DIRECTORY_SOURCE_CHANGED");
    closeDirectorySnapshot(truncated);
    writeFileSync(file, "original content");
    const extended = unwrap(await createDirectorySnapshot(root, map));
    writeFileSync(file, "original content extended");
    expect(firstCode(await revalidateDirectorySnapshot(extended, map))).toBe("DIRECTORY_SOURCE_CHANGED");
    closeDirectorySnapshot(extended);
  });

  it("detects directory insertion and deletion while a snapshot is live", async () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "icons", "nested"), { recursive: true });
    writeFileSync(join(root, "icons", "nested", "asset.svg"), "x");
    const map = sourceMap();
    const inserted = unwrap(await createDirectorySnapshot(root, map));
    writeFileSync(join(root, "icons", "inserted.svg"), "x");
    expect(firstCode(await revalidateDirectorySnapshot(inserted, map))).toBe("DIRECTORY_SOURCE_CHANGED");
    closeDirectorySnapshot(inserted);
    unlinkSync(join(root, "icons", "inserted.svg"));
    const deleted = unwrap(await createDirectorySnapshot(root, map));
    rmSync(join(root, "icons", "nested"), { recursive: true });
    expect(firstCode(await revalidateDirectorySnapshot(deleted, map))).toBe("DIRECTORY_SOURCE_CHANGED");
    closeDirectorySnapshot(deleted);
  });

  it("detects a child directory replaced with a symlink", async () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "icons", "nested"), { recursive: true });
    mkdirSync(join(root, "attacker"));
    writeFileSync(join(root, "icons", "nested", "asset.svg"), "original");
    writeFileSync(join(root, "attacker", "asset.svg"), "attacker");
    const map = sourceMap();
    const snapshot = unwrap(await createDirectorySnapshot(root, map));
    rmSync(join(root, "icons", "nested"), { recursive: true });
    symlinkSync(join(root, "attacker"), join(root, "icons", "nested"));
    expect(firstCode(await revalidateDirectorySnapshot(snapshot, map))).toBe("DIRECTORY_SOURCE_CHANGED");
    closeDirectorySnapshot(snapshot);
  });

  it("detects source-root rename followed by remove and recreate at the named path", async () => {
    const parent = physicalTempRoot();
    const source = join(parent, "source");
    mkdirSync(join(source, "icons"), { recursive: true });
    writeFileSync(join(source, "icons", "asset.svg"), "original");
    const map = sourceMap();
    const snapshot = unwrap(await createDirectorySnapshot(source, map));
    renameSync(source, join(parent, "retained-original"));
    mkdirSync(join(source, "icons"), { recursive: true });
    writeFileSync(join(source, "icons", "asset.svg"), "attacker");
    expect(firstCode(await revalidateDirectorySnapshot(snapshot, map))).toBe("DIRECTORY_SOURCE_CHANGED");
    closeDirectorySnapshot(snapshot);
  });

  it("detects leaf mutation driven between candidate inspection and open/read", async () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "icons"));
    const file = join(root, "icons", "asset.svg");
    writeFileSync(file, "<svg>original</svg>\n");

    const loadResult = (await import("../src/directory-snapshot-native.js")).loadDirectorySnapshotNative();
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;
    const addon = loadResult.addon;

    // Step 1: Open filesystem root and walk to parent directory
    const rootHandle = addon.openFilesystemRoot();
    const handles = [rootHandle];
    for (const component of root.slice(1).split("/")) {
      handles.push(addon.openChildDirectory(handles.at(-1)!, component));
    }
    const iconsHandle = addon.openChildDirectory(handles.at(-1)!, "icons");
    handles.push(iconsHandle);

    // Step 2: Candidate inspection records entry stat
    const entries = addon.readDirectory(iconsHandle);
    const candidateEntry = entries.find((entry) => entry.name === "asset.svg");
    expect(candidateEntry).toBeDefined();
    const candidateStat = candidateEntry!.stat;

    // Step 3: Attacker replaces file before openSelectedNativeFile runs
    unlinkSync(file);
    writeFileSync(file, "<svg>attacker-substituted-bytes</svg>\n");

    // Step 4: openChildRegular opens new file, statHandle mismatch must fail closed
    const openedFile = addon.openChildRegular(iconsHandle, "asset.svg");
    const openedStat = addon.statHandle(openedFile);
    expect(openedStat.inode !== candidateStat.inode || openedStat.ctimeSeconds !== candidateStat.ctimeSeconds || openedStat.size !== candidateStat.size).toBe(true);
    addon.closeHandle(openedFile);

    // Step 5: Attacker replaces file with symlink
    unlinkSync(file);
    symlinkSync("/etc/hosts", file);
    expect(() => addon.openChildRegular(iconsHandle, "asset.svg")).toThrow(expect.objectContaining({ code: "DIRECTORY_TRAVERSED_SYMLINK" }));

    for (const handle of handles.reverse()) addon.closeHandle(handle);
  });
});
