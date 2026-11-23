import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

import { computeSha256 } from "../digests.js";
import { identity, readExactBuffer, sameFileIdentity, type FileIdentity } from "../filesystem.js";

export class IllustrationCustodyError extends Error {
  constructor(readonly code: "ILLUSTRATION_PATH_UNSAFE" | "ILLUSTRATION_FILE_CHANGED" | "ILLUSTRATION_RESOURCE_LIMIT") {
    super("Illustration filesystem custody check failed.");
    this.name = "IllustrationCustodyError";
  }
}

export interface RetainedIllustrationDirectory {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
}

export interface RetainedIllustrationFile {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
  readonly bytes: Uint8Array;
  readonly sha256: ReturnType<typeof computeSha256>;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const CTX = { operation: "install", domain: "transaction" } as const;

function unsafe(): never { throw new IllustrationCustodyError("ILLUSTRATION_PATH_UNSAFE"); }
function changed(): never { throw new IllustrationCustodyError("ILLUSTRATION_FILE_CHANGED"); }

/** Private caller coordinates; never serialize these paths or descriptors. */
export function illustrationAbsolutePath(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096
      || /[\u0000-\u001f\u007f\\]/u.test(value) || value.split(sep).includes("..")) unsafe();
  return resolve(value);
}

export function sameIllustrationDirectory(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

/** Retain every existing ancestor. No symlink alias is silently resolved. */
export async function retainIllustrationDirectories(pathInput: string): Promise<readonly RetainedIllustrationDirectory[]> {
  const path = illustrationAbsolutePath(pathInput);
  const root = parse(path).root;
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  if (parts.length > 64) throw new IllustrationCustodyError("ILLUSTRATION_RESOURCE_LIMIT");
  const result: RetainedIllustrationDirectory[] = [];
  let cursor = root;
  try {
    for (const part of ["", ...parts]) {
      if (part) cursor = join(cursor, part);
      const handle = await open(cursor, constants.O_RDONLY | DIRECTORY | NOFOLLOW | NONBLOCK);
      try {
        const opened = await handle.stat();
        const named = await lstat(cursor);
        if (!opened.isDirectory() || named.isSymbolicLink() || !named.isDirectory()
            || !sameIllustrationDirectory(identity(opened), identity(named))) unsafe();
        result.push({ path: cursor, handle, identity: identity(opened) });
      } catch (error) { await handle.close().catch(() => undefined); throw error; }
    }
    return result;
  } catch (error) {
    await closeIllustrationDirectories(result);
    if (error instanceof IllustrationCustodyError) throw error;
    unsafe();
  }
}

export async function verifyIllustrationDirectories(directories: readonly RetainedIllustrationDirectory[]): Promise<void> {
  try {
    for (const item of directories) {
      const opened = await item.handle.stat();
      const named = await lstat(item.path);
      if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink()
          || !sameIllustrationDirectory(item.identity, identity(opened))
          || !sameIllustrationDirectory(item.identity, identity(named))) changed();
    }
  } catch (error) {
    if (error instanceof IllustrationCustodyError) throw error;
    changed();
  }
}

export async function closeIllustrationDirectories(directories: readonly RetainedIllustrationDirectory[]): Promise<void> {
  for (const item of [...directories].reverse()) await item.handle.close().catch(() => undefined);
}

/** Parent directories must already be retained by the calling source/plan. */
export async function retainIllustrationFile(pathInput: string, maximum: number): Promise<RetainedIllustrationFile> {
  const path = illustrationAbsolutePath(pathInput);
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32 * 1048576) throw new IllustrationCustodyError("ILLUSTRATION_RESOURCE_LIMIT");
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const openedBefore = await handle.stat();
    const namedBefore = await lstat(path);
    if (!openedBefore.isFile() || !namedBefore.isFile() || namedBefore.isSymbolicLink()) unsafe();
    if (!sameFileIdentity(identity(namedBefore), identity(openedBefore))) changed();
    if (openedBefore.size > maximum) throw new IllustrationCustodyError("ILLUSTRATION_RESOURCE_LIMIT");
    const bytes = await readExactBuffer(handle, openedBefore.size, 0, CTX, maximum, "ILLUSTRATION_FILE_CHANGED", "Illustration file changed while reading.");
    const openedAfter = await handle.stat();
    const namedAfter = await lstat(path);
    if (!openedAfter.isFile() || !namedAfter.isFile() || namedAfter.isSymbolicLink()
        || !sameFileIdentity(identity(openedBefore), identity(openedAfter))
        || !sameFileIdentity(identity(openedAfter), identity(namedAfter))) changed();
    return { path, handle, bytes, identity: identity(openedAfter), sha256: computeSha256(bytes) };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof IllustrationCustodyError) throw error;
    unsafe();
  }
}

export async function verifyIllustrationFile(item: RetainedIllustrationFile): Promise<void> {
  try {
    const before = await item.handle.stat();
    const named = await lstat(item.path);
    if (!before.isFile() || !named.isFile() || named.isSymbolicLink()
        || !sameFileIdentity(item.identity, identity(before))
        || !sameFileIdentity(item.identity, identity(named))) changed();
    const bytes = await readExactBuffer(item.handle, before.size, 0, CTX, 32 * 1048576, "ILLUSTRATION_FILE_CHANGED", "Illustration file changed while reading.");
    const after = await item.handle.stat();
    const namedAfter = await lstat(item.path);
    if (computeSha256(bytes) !== item.sha256 || !sameFileIdentity(item.identity, identity(after))
        || !namedAfter.isFile() || namedAfter.isSymbolicLink() || !sameFileIdentity(item.identity, identity(namedAfter))) changed();
  } catch (error) {
    if (error instanceof IllustrationCustodyError) throw error;
    changed();
  }
}
