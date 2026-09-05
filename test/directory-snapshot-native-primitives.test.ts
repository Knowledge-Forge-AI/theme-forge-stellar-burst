import {
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
  loadDirectorySnapshotNative,
  type DirectorySnapshotNativeAddon,
  type NativeHandle,
} from "../src/directory-snapshot-native.js";

const roots: string[] = [];
const nativeLoad = loadDirectorySnapshotNative();

function addon(): DirectorySnapshotNativeAddon {
  if (!nativeLoad.ok) throw new Error("native addon unavailable");
  return nativeLoad.addon;
}

function physicalTempRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tfsb-primitives-"));
  roots.push(root);
  return root;
}

function openAbsolute(native: DirectorySnapshotNativeAddon, path: string): NativeHandle[] {
  const handles = [native.openFilesystemRoot()];
  try {
    for (const component of path.slice(1).split("/")) handles.push(native.openChildDirectory(handles.at(-1)!, component));
    return handles;
  } catch (error) {
    for (const handle of handles.reverse()) native.closeHandle(handle);
    throw error;
  }
}

function closeAll(native: DirectorySnapshotNativeAddon, handles: readonly NativeHandle[]): void {
  for (const handle of [...handles].reverse()) native.closeHandle(handle);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(nativeLoad.ok)("native addon primitive boundary", () => {
  it("exports exactly eight primitives and non-callable identity facts", () => {
    const native = addon();
    expect(Object.keys(native).sort()).toEqual([
      "abiVersion",
      "backend",
      "closeHandle",
      "openChildDirectory",
      "openChildRegular",
      "openFilesystemRoot",
      "readDirectory",
      "readRegular",
      "statFilesystem",
      "statHandle",
    ]);
    expect(native.backend).toBe("native-addon-posix-openat-v1");
    expect(native.abiVersion).toBe(1);
    expect(() => Object.assign(native, { backend: "mismatch" })).toThrow(TypeError);
    expect(native.backend).toBe("native-addon-posix-openat-v1");
  });

  it("enforces component grammar without decoding percent or Unicode data", () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "%2e%2e"));
    mkdirSync(join(root, "．"));
    const native = addon();
    const handles = openAbsolute(native, root);
    const source = handles.at(-1)!;
    const percent = native.openChildDirectory(source, "%2e%2e");
    const unicode = native.openChildDirectory(source, "．");
    native.closeHandle(percent);
    native.closeHandle(unicode);
    for (const invalid of ["", ".", "..", "a/b", "a\\b", "nul\0name", "control\u0001name", "delete\u007fname"]) {
      expect(() => native.openChildDirectory(source, invalid)).toThrow(expect.objectContaining({ code: "DIRECTORY_INVALID_COMPONENT" }));
    }
    closeAll(native, handles);
  });

  it("rewinds every duplicated directory stream before enumeration", () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "one"));
    mkdirSync(join(root, "two"));
    const native = addon();
    const handles = openAbsolute(native, root);
    const source = handles.at(-1)!;
    const first = native.readDirectory(source).map((entry) => entry.name).sort();
    const second = native.readDirectory(source).map((entry) => entry.name).sort();
    expect(first).toEqual(["one", "two"]);
    expect(second).toEqual(first);
    closeAll(native, handles);
  });

  it("keeps reads anchored to the retained parent through rename, replacement, and swap-back", () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "icons"));
    mkdirSync(join(root, "attacker"));
    writeFileSync(join(root, "icons", "asset.svg"), "original");
    writeFileSync(join(root, "attacker", "asset.svg"), "attacker");
    const native = addon();
    const handles = openAbsolute(native, root);
    const source = handles.at(-1)!;
    const retainedIcons = native.openChildDirectory(source, "icons");
    renameSync(join(root, "icons"), join(root, "holding"));
    renameSync(join(root, "attacker"), join(root, "icons"));
    const file = native.openChildRegular(retainedIcons, "asset.svg");
    expect(native.readRegular(file, 1024).toString("utf8")).toBe("original");
    native.closeHandle(file);
    renameSync(join(root, "icons"), join(root, "attacker"));
    renameSync(join(root, "holding"), join(root, "icons"));
    const afterSwapBack = native.openChildRegular(retainedIcons, "asset.svg");
    expect(native.readRegular(afterSwapBack, 1024).toString("utf8")).toBe("original");
    native.closeHandle(afterSwapBack);
    native.closeHandle(retainedIcons);
    closeAll(native, handles);
  });

  it("fails closed when a final regular file becomes a symlink", () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "icons"));
    writeFileSync(join(root, "target.svg"), "attacker");
    const file = join(root, "icons", "asset.svg");
    writeFileSync(file, "original");
    const native = addon();
    const handles = openAbsolute(native, root);
    const icons = native.openChildDirectory(handles.at(-1)!, "icons");
    unlinkSync(file);
    symlinkSync(join(root, "target.svg"), file);
    expect(() => native.openChildRegular(icons, "asset.svg")).toThrow(expect.objectContaining({ code: "DIRECTORY_TRAVERSED_SYMLINK" }));
    native.closeHandle(icons);
    closeAll(native, handles);
  });

  it("detects a staged truncate across actual native stat/read boundaries", () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "icons"));
    const path = join(root, "icons", "asset.svg");
    writeFileSync(path, "original content");
    const native = addon();
    const handles = openAbsolute(native, root);
    const icons = native.openChildDirectory(handles.at(-1)!, "icons");
    const file = native.openChildRegular(icons, "asset.svg");
    const before = native.statHandle(file);
    truncateSync(path, 2);
    const bytes = native.readRegular(file, 1024);
    const after = native.statHandle(file);
    expect(bytes.toString("utf8")).toBe("or");
    expect(after.size).not.toBe(before.size);
    expect(after.ctimeSeconds === before.ctimeSeconds && after.ctimeNanoseconds === before.ctimeNanoseconds).toBe(false);
    native.closeHandle(file);
    native.closeHandle(icons);
    closeAll(native, handles);
  });

  it("makes close idempotent and stale handles inert under descriptor reuse pressure", () => {
    const native = addon();
    const stale = native.openFilesystemRoot();
    native.closeHandle(stale);
    native.closeHandle(stale);
    for (let index = 0; index < 1_000; index += 1) {
      const current = native.openFilesystemRoot();
      native.closeHandle(current);
    }
    expect(() => native.statHandle(stale)).toThrow(expect.objectContaining({ code: "DIRECTORY_USE_AFTER_CLOSE" }));
  });

  it("returns only bounded error families and sanitized messages", () => {
    const root = physicalTempRoot();
    const native = addon();
    const handles = openAbsolute(native, root);
    try {
      native.openChildDirectory(handles.at(-1)!, "missing");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty("code", "DIRECTORY_SOURCE_CHANGED");
      expect(String(error)).not.toContain(root);
      expect(String(error)).not.toMatch(/\b(?:fd|0x[0-9a-f]+|Users|private)\b/i);
    }
    closeAll(native, handles);
  });
});
