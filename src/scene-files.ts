import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, rm, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { DiagnosticError, diagnostic } from "./diagnostics.js";
import {
  identity,
  optionalLstat,
  readOpenedFile,
  sameFileIdentity,
  syncPath,
} from "./filesystem.js";
import { validateScene } from "./scene/validate.js";

export const MAX_SCENE_FILE_BYTES = 8 * 1024 * 1024; // 8 MiB

export const SCENE_FILE_INVALID = "SCENE_FILE_INVALID";
export const SCENE_FILE_LIMIT_EXCEEDED = "SCENE_FILE_LIMIT_EXCEEDED";
export const SCENE_PUBLISH_TARGET_INVALID = "SCENE_PUBLISH_TARGET_INVALID";
export const SCENE_PUBLISH_TARGET_EXISTS = "SCENE_PUBLISH_TARGET_EXISTS";
export const SCENE_PUBLISH_INVALID_INPUT = "SCENE_PUBLISH_INVALID_INPUT";
export const SCENE_LINK_UNSUPPORTED = "SCENE_LINK_UNSUPPORTED";
export const SCENE_PUBLISH_FAILED = "SCENE_PUBLISH_FAILED";

export interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

export interface SceneSvgPublicationResult {
  readonly published: boolean;
  readonly targetPath: string;
  readonly cleanupResidue: string | null;
  readonly dryRun: boolean;
}

export type ScenePublicationResult = SceneSvgPublicationResult;
export type ScenePublicationHooks = SceneSvgPublicationHooks;

export interface ReadSceneFileHooks {
  readonly beforeOpen?: () => void | Promise<void>;
  readonly afterOpen?: () => void | Promise<void>;
  readonly beforeRead?: () => void | Promise<void>;
  readonly afterRead?: () => void | Promise<void>;
  readonly beforeAfterStat?: () => void | Promise<void>;
}

export interface SceneSvgPublicationHooks {
  readonly beforeCreate?: () => void | Promise<void>;
  readonly afterCreate?: () => void | Promise<void>;
  readonly beforeWrite?: () => void | Promise<void>;
  readonly afterWrite?: () => void | Promise<void>;
  readonly beforeTempSync?: () => void | Promise<void>;
  readonly beforeTempClose?: () => void | Promise<void>;
  readonly afterTempClose?: () => void | Promise<void>;
  readonly beforeParentRevalidation?: () => void | Promise<void>;
  readonly beforeTargetRevalidation?: () => void | Promise<void>;
  readonly beforeLink?: () => void | Promise<void>;
  readonly linkOverride?: (tempPath: string, targetPath: string) => Promise<void>;
  readonly afterLink?: () => void | Promise<void>;
  readonly beforeParentSync?: () => void | Promise<void>;
  readonly beforeTempRemoval?: () => void | Promise<void>;
  readonly afterTempRemoval?: () => void | Promise<void>;
  readonly beforeFinalParentSync?: () => void | Promise<void>;
}

function directoryIdentity(stat: Stats): DirectoryIdentity {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sceneFileError(code: string, message: string): DiagnosticError {
  return new DiagnosticError(diagnostic({ operation: "validate", domain: "filesystem" }, code, message));
}

function scenePublishError(code: string, message: string): DiagnosticError {
  return new DiagnosticError(diagnostic({ operation: "export", domain: "filesystem" }, code, message));
}

async function validateSceneInputComponents(absolutePath: string): Promise<void> {
  const root = absolutePath.startsWith(sep) ? sep : absolutePath.slice(0, 3);
  const pieces = absolutePath.slice(root.length).split(sep).filter(Boolean);
  let cursor = root;
  for (let i = 0; i < pieces.length - 1; i++) {
    cursor = join(cursor, pieces[i]!);
    const stat = await lstat(cursor).catch(() => undefined);
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw sceneFileError(
        SCENE_FILE_INVALID,
        "Every existing scene parent component must be a real non-symlink directory.",
      );
    }
  }
}

export async function readSceneFileBytes(path: string, hooks: ReadSceneFileHooks = {}): Promise<Uint8Array> {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw sceneFileError(SCENE_FILE_INVALID, "A non-empty scene file path is required.");
  }
  const absolutePath = resolve(path);
  await validateSceneInputComponents(absolutePath);

  const before = await optionalLstat(absolutePath);
  if (before === undefined) {
    throw sceneFileError(SCENE_FILE_INVALID, "Scene file does not exist.");
  }
  if (before.isSymbolicLink()) {
    throw sceneFileError(SCENE_FILE_INVALID, "Scene file cannot be a symbolic link.");
  }
  if (!before.isFile()) {
    throw sceneFileError(SCENE_FILE_INVALID, "Scene file must be a regular file.");
  }
  if (before.size > MAX_SCENE_FILE_BYTES) {
    throw sceneFileError(SCENE_FILE_LIMIT_EXCEEDED, "Scene file exceeds 8 MiB limit.");
  }

  await hooks.beforeOpen?.();
  let handle: FileHandle | undefined;
  let bytes: Uint8Array;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    await hooks.afterOpen?.();

    const openedBefore = await handle.stat();
    if (!openedBefore.isFile() || !sameFileIdentity(identity(before), identity(openedBefore))) {
      throw sceneFileError(SCENE_FILE_INVALID, "Scene file changed or is not a regular file.");
    }
    if (openedBefore.size > MAX_SCENE_FILE_BYTES) {
      throw sceneFileError(SCENE_FILE_LIMIT_EXCEEDED, "Scene file exceeds 8 MiB limit.");
    }

    await hooks.beforeRead?.();
    bytes = await readOpenedFile(handle, openedBefore.size, MAX_SCENE_FILE_BYTES);
    await hooks.afterRead?.();

    const openedAfter = await handle.stat();
    await hooks.beforeAfterStat?.();
    const after = await optionalLstat(absolutePath);
    if (
      bytes.byteLength !== openedBefore.size ||
      !sameFileIdentity(identity(openedBefore), identity(openedAfter)) ||
      after === undefined ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      !sameFileIdentity(identity(openedAfter), identity(after))
    ) {
      throw sceneFileError(SCENE_FILE_INVALID, "Scene file changed during reading.");
    }
    return bytes;
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    throw sceneFileError(SCENE_FILE_INVALID, "Scene file could not be read safely.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readSceneFile(path: string, hooks: ReadSceneFileHooks = {}): Promise<unknown> {
  const bytes = await readSceneFileBytes(path, hooks);

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw sceneFileError(SCENE_FILE_INVALID, "Scene file must be valid UTF-8.");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw sceneFileError(SCENE_FILE_INVALID, "Scene file must be valid JSON.");
  }
}

async function validateOutputParent(parentPath: string): Promise<DirectoryIdentity> {
  const root = parentPath.startsWith(sep) ? sep : parentPath.slice(0, 3);
  let cursor = root;
  const pieces = parentPath.slice(root.length).split(sep).filter(Boolean);
  for (const piece of pieces) {
    cursor = join(cursor, piece);
    const stat = await lstat(cursor).catch(() => undefined);
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw scenePublishError(
        SCENE_PUBLISH_TARGET_INVALID,
        "Every existing output parent component must be a real non-symlink directory.",
      );
    }
  }
  const stat = await lstat(parentPath).catch(() => undefined);
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw scenePublishError(
      SCENE_PUBLISH_TARGET_INVALID,
      "Every existing output parent component must be a real non-symlink directory.",
    );
  }
  return directoryIdentity(stat);
}

export async function publishSceneBytes(
  output: string,
  bytes: Uint8Array,
  dryRun = false,
  hooks: ScenePublicationHooks = {},
): Promise<ScenePublicationResult> {
  if (typeof output !== "string" || output.length === 0 || output.includes("\0")) {
    throw scenePublishError(SCENE_PUBLISH_TARGET_INVALID, "A non-empty scene output path is required.");
  }

  const targetPath = resolve(output);
  const parentPath = dirname(targetPath);
  const initialParentIdentity = await validateOutputParent(parentPath);

  const existingTarget = await optionalLstat(targetPath);
  if (existingTarget !== undefined) {
    throw scenePublishError(SCENE_PUBLISH_TARGET_EXISTS, "The scene output target must be absent.");
  }

  if (dryRun) {
    return {
      published: false,
      targetPath,
      cleanupResidue: null,
      dryRun: true,
    };
  }

  const tempName = `.tfsb-scene-${randomUUID()}.tmp`;
  const tempPath = join(parentPath, tempName);
  let tempHandle: FileHandle | undefined;
  let tempIdentity: { readonly dev: number; readonly ino: number } | undefined;
  let tempClosed = false;

  try {
    await hooks.beforeCreate?.();
    tempHandle = await open(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    const initialTempStat = await tempHandle.stat();
    tempIdentity = { dev: initialTempStat.dev, ino: initialTempStat.ino };
    await hooks.afterCreate?.();

    await hooks.beforeWrite?.();
    await tempHandle.writeFile(bytes);
    await hooks.afterWrite?.();

    await hooks.beforeTempSync?.();
    await tempHandle.sync();

    await hooks.beforeTempClose?.();
    await tempHandle.close();
    tempClosed = true;
    tempHandle = undefined;
    await hooks.afterTempClose?.();

    await hooks.beforeParentRevalidation?.();
    const revalidatedParent = await lstat(parentPath).catch(() => undefined);
    if (
      revalidatedParent === undefined ||
      revalidatedParent.isSymbolicLink() ||
      !revalidatedParent.isDirectory() ||
      !sameDirectory(initialParentIdentity, directoryIdentity(revalidatedParent))
    ) {
      throw scenePublishError(
        SCENE_PUBLISH_TARGET_INVALID,
        "Every existing output parent component must be a real non-symlink directory.",
      );
    }

    await hooks.beforeTargetRevalidation?.();
    const revalidatedTarget = await optionalLstat(targetPath);
    if (revalidatedTarget !== undefined) {
      throw scenePublishError(SCENE_PUBLISH_TARGET_EXISTS, "The scene output target must be absent.");
    }

    await hooks.beforeLink?.();

    const preLinkParent = await lstat(parentPath).catch(() => undefined);
    if (
      preLinkParent === undefined ||
      preLinkParent.isSymbolicLink() ||
      !preLinkParent.isDirectory() ||
      !sameDirectory(initialParentIdentity, directoryIdentity(preLinkParent))
    ) {
      throw scenePublishError(
        SCENE_PUBLISH_TARGET_INVALID,
        "Every existing output parent component must be a real non-symlink directory.",
      );
    }

    const preLinkTemp = await optionalLstat(tempPath);
    if (
      preLinkTemp === undefined ||
      !preLinkTemp.isFile() ||
      preLinkTemp.isSymbolicLink() ||
      preLinkTemp.dev !== tempIdentity.dev ||
      preLinkTemp.ino !== tempIdentity.ino
    ) {
      throw scenePublishError(SCENE_PUBLISH_FAILED, "Staged scene output changed before publication.");
    }

    try {
      if (hooks.linkOverride) {
        await hooks.linkOverride(tempPath, targetPath);
      } else {
        await link(tempPath, targetPath);
      }
    } catch (linkError: any) {
      if (linkError instanceof DiagnosticError) throw linkError;
      const code = linkError?.code;
      if (code === "EEXIST") {
        throw scenePublishError(SCENE_PUBLISH_TARGET_EXISTS, "The scene output target must be absent.");
      }
      if (
        code === "EXDEV" ||
        code === "ENOSYS" ||
        code === "EPERM" ||
        code === "ENOTSUP" ||
        code === "EOPNOTSUPP" ||
        code === "EMLINK"
      ) {
        throw scenePublishError(
          SCENE_LINK_UNSUPPORTED,
          `File linking is unsupported by the filesystem: ${code ?? "unknown"}.`,
        );
      }
      throw scenePublishError(SCENE_PUBLISH_FAILED, "Failed to publish scene output file.");
    }
  } catch (preError: unknown) {
    if (tempHandle !== undefined && !tempClosed) {
      await tempHandle.close().catch(() => undefined);
      tempClosed = true;
    }
    if (tempIdentity !== undefined) {
      const current = await optionalLstat(tempPath).catch(() => undefined);
      if (
        current !== undefined &&
        !current.isSymbolicLink() &&
        current.dev === tempIdentity.dev &&
        current.ino === tempIdentity.ino
      ) {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    }
    if (preError instanceof DiagnosticError) {
      throw preError;
    }
    throw scenePublishError(SCENE_PUBLISH_FAILED, "Failed to publish scene output file.");
  }

  try {
    await hooks.afterLink?.();
    await hooks.beforeParentSync?.();
    await syncPath(parentPath);
    await hooks.beforeTempRemoval?.();

    if (tempIdentity !== undefined) {
      const current = await optionalLstat(tempPath).catch(() => undefined);
      if (
        current !== undefined &&
        !current.isSymbolicLink() &&
        current.dev === tempIdentity.dev &&
        current.ino === tempIdentity.ino
      ) {
        await rm(tempPath, { force: true });
      } else if (current !== undefined) {
        throw scenePublishError(SCENE_PUBLISH_FAILED, "Staged scene output changed during cleanup.");
      }
    }

    await hooks.afterTempRemoval?.();
    await hooks.beforeFinalParentSync?.();
    await syncPath(parentPath);
  } catch (postError: unknown) {
    const residue = await optionalLstat(tempPath)
      .then((stat) => (stat === undefined ? "none" : tempName))
      .catch(() => "unknown");
    throw scenePublishError(
      SCENE_PUBLISH_FAILED,
      `Post-publication sync or cleanup failed; output was published (residue: ${residue}).`,
    );
  }

  return {
    published: true,
    targetPath,
    cleanupResidue: null,
    dryRun: false,
  };
}

export async function publishSceneSvg(
  output: string,
  svg: string,
  dryRun = false,
  hooks: SceneSvgPublicationHooks = {},
): Promise<SceneSvgPublicationResult> {
  if (typeof output !== "string" || output.length === 0 || output.includes("\0")) {
    throw scenePublishError(SCENE_PUBLISH_TARGET_INVALID, "A non-empty scene output path is required.");
  }
  if (typeof svg !== "string") {
    throw scenePublishError(SCENE_PUBLISH_INVALID_INPUT, "Scene SVG content must be a string.");
  }

  const bytes = Buffer.from(svg, "utf8");
  return publishSceneBytes(output, bytes, dryRun, hooks);
}

export async function publishSceneJson(
  output: string,
  canonicalScene: string,
  dryRun = false,
  hooks: ScenePublicationHooks = {},
): Promise<ScenePublicationResult> {
  if (typeof output !== "string" || output.length === 0 || output.includes("\0")) {
    throw scenePublishError(SCENE_PUBLISH_TARGET_INVALID, "A non-empty scene output path is required.");
  }
  if (typeof canonicalScene !== "string") {
    throw scenePublishError(SCENE_PUBLISH_INVALID_INPUT, "Scene JSON content must be a string.");
  }

  if (Buffer.byteLength(canonicalScene, "utf8") > MAX_SCENE_FILE_BYTES) {
    throw scenePublishError(SCENE_FILE_LIMIT_EXCEEDED, "Scene file exceeds 8 MiB limit.");
  }
  // Validate the actual bytes to publish; a separately supplied scene cannot
  // attest to different JSON content.
  try {
    const parsed = JSON.parse(canonicalScene);
    const val = validateScene(parsed);
    if (!val.ok) {
      throw scenePublishError(SCENE_PUBLISH_INVALID_INPUT, "Scene JSON failed validation.");
    }
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    throw scenePublishError(SCENE_PUBLISH_INVALID_INPUT, "Scene JSON must be valid JSON.");
  }
  const bytes = Buffer.from(canonicalScene, "utf8");

  return publishSceneBytes(output, bytes, dryRun, hooks);
}
