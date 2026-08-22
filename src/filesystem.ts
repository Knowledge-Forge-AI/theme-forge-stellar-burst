import { open, lstat, readdir, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";

import { computeRawSha256 } from "./digests.js";
import { fail, type DiagnosticContext } from "./diagnostics.js";

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export type PresentFileSnapshot = { readonly kind: "file"; readonly sha256: string; readonly bytes: Uint8Array } & FileIdentity;

export type FileSnapshot =
  | { readonly kind: "absent" }
  | PresentFileSnapshot;

export type FlatDirectorySnapshot =
  | { readonly kind: "absent" }
  | ({ readonly kind: "directory"; readonly files: ReadonlyMap<string, FileSnapshot> } & FileIdentity);

function identity(stat: Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export async function optionalLstat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readOpenedFile(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return bytes.subarray(0, offset);
}

export async function readRegularFileSnapshot(
  path: string,
  ctx: DiagnosticContext,
  unsafeCode: string,
  unsafeMessage: string,
  maxBytes?: number,
): Promise<{ readonly bytes: Uint8Array; readonly snapshot: PresentFileSnapshot }> {
  const before = await optionalLstat(path);
  if (before === undefined || !before.isFile() || before.isSymbolicLink()) {
    fail(ctx, unsafeCode, unsafeMessage, path);
  }
  if (maxBytes !== undefined && before.size > maxBytes) {
    fail(ctx, unsafeCode, unsafeMessage, path);
  }
  const handle = await open(path, "r");
  try {
    const openedBefore = await handle.stat();
    if (!openedBefore.isFile() || !sameFileIdentity(identity(before), identity(openedBefore))) {
      fail(ctx, unsafeCode, unsafeMessage, path);
    }
    const bytes = await readOpenedFile(handle, openedBefore.size);
    const openedAfter = await handle.stat();
    const after = await optionalLstat(path);
    if (
      bytes.byteLength !== openedBefore.size ||
      !sameFileIdentity(identity(openedBefore), identity(openedAfter)) ||
      after === undefined || !after.isFile() || after.isSymbolicLink() ||
      !sameFileIdentity(identity(openedAfter), identity(after))
    ) {
      fail(ctx, unsafeCode, unsafeMessage, path);
    }
    return { bytes, snapshot: { kind: "file", ...identity(openedAfter), sha256: computeRawSha256(bytes), bytes } };
  } finally {
    await handle.close();
  }
}

export async function snapshotRegularFile(
  path: string,
  ctx: DiagnosticContext,
  unsafeCode: string,
  unsafeMessage: string,
): Promise<FileSnapshot> {
  const stat = await optionalLstat(path);
  if (stat === undefined) return { kind: "absent" };
  return (await readRegularFileSnapshot(path, ctx, unsafeCode, unsafeMessage)).snapshot;
}

export function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "absent" || right.kind === "absent") return true;
  return sameFileIdentity(left, right) && left.sha256 === right.sha256;
}

export async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function durableWrite(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  await syncPath(path);
}

export async function snapshotFlatDirectory(
  path: string,
  ctx: DiagnosticContext,
  unsafeCode: string,
  unsafeMessage: string,
  maxEntries = 1024,
): Promise<FlatDirectorySnapshot> {
  const before = await optionalLstat(path);
  if (before === undefined) return { kind: "absent" };
  if (!before.isDirectory() || before.isSymbolicLink()) fail(ctx, unsafeCode, unsafeMessage, path);
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.length > maxEntries || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    fail(ctx, unsafeCode, unsafeMessage, path);
  }
  const files = new Map<string, FileSnapshot>();
  for (const entry of entries) {
    files.set(entry.name, (await readRegularFileSnapshot(`${path}/${entry.name}`, ctx, unsafeCode, unsafeMessage)).snapshot);
  }
  const after = await optionalLstat(path);
  if (after === undefined || !after.isDirectory() || after.isSymbolicLink() || !sameFileIdentity(identity(before), identity(after))) {
    fail(ctx, unsafeCode, unsafeMessage, path);
  }
  return { kind: "directory", ...identity(after), files };
}

export function sameFlatDirectorySnapshot(left: FlatDirectorySnapshot, right: FlatDirectorySnapshot): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "absent" || right.kind === "absent") return true;
  if (!sameFileIdentity(left, right) || left.files.size !== right.files.size) return false;
  for (const [name, expected] of left.files) {
    const actual = right.files.get(name);
    if (actual === undefined || !sameFileSnapshot(expected, actual)) return false;
  }
  return true;
}
