import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { computeRawSha256 } from "../src/digests.js";
import { identity } from "../src/filesystem.js";
import {
  executeManagedOutputTransaction,
  type ManagedOutput,
  type ManagedOutputParentAuthority,
  type ManagedOutputTransactionHooks,
} from "../src/managed-output-transaction.js";
import { findRecoveryResidue } from "../src/transaction.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const directoryFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
const fileFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

async function directoryAuthority(path: string, handles: FileHandle[], missingDirectories: readonly string[] = []): Promise<ManagedOutputParentAuthority> {
  const handle = await open(path, directoryFlags);
  handles.push(handle);
  return { nearestPath: path, nearestIdentity: identity(await handle.stat()), nearestHandle: handle, missingDirectories };
}

function digest(bytes: Uint8Array): `sha256:${string}` { return `sha256:${computeRawSha256(bytes)}`; }

async function existingOutput(
  root: string,
  destination: string,
  bytes: Uint8Array,
  parentAuthority: ManagedOutputParentAuthority,
  handles: FileHandle[],
): Promise<ManagedOutput> {
  const absoluteDestination = join(root, destination);
  const handle = await open(absoluteDestination, fileFlags);
  handles.push(handle);
  const stat = await handle.stat();
  return {
    destination,
    absoluteDestination,
    bytes,
    snapshot: { kind: "file", identity: identity(stat), digest: digest(bytes) },
    handle,
    parentAuthority,
    maxBytes: 1024 * 1024,
  };
}

function absentOutput(
  root: string,
  destination: string,
  bytes: Uint8Array,
  parentAuthority: ManagedOutputParentAuthority,
): ManagedOutput {
  return {
    destination,
    absoluteDestination: join(root, destination),
    bytes,
    snapshot: { kind: "absent" },
    parentAuthority,
    maxBytes: 1024 * 1024,
  };
}

function absentLock(root: string, bytes: Uint8Array, parentAuthority: ManagedOutputParentAuthority): ManagedOutput {
  return {
    destination: "illustration.lock.json",
    absoluteDestination: join(root, "illustration.lock.json"),
    bytes,
    snapshot: { kind: "absent" },
    parentAuthority,
    maxBytes: 1024 * 1024,
  };
}

async function closeAll(handles: readonly FileHandle[]): Promise<void> {
  for (const handle of handles) await handle.close().catch(() => undefined);
}

async function replaceWithForeign(path: string, bytes: Uint8Array): Promise<void> {
  const replacement = `${path}.replacement`;
  await writeFile(replacement, bytes);
  await rename(replacement, path);
}

type FaultBoundary =
  | "beforeStage"
  | "afterStage"
  | "beforeJournal"
  | "afterJournal"
  | "beforeOutputPromotion"
  | "beforeLockPromotion"
  | "beforeRollback"
  | "beforeCleanup";

function faultHooks(boundary: FaultBoundary): ManagedOutputTransactionHooks {
  const fault = (): never => { throw new Error(`fault at ${boundary}`); };
  switch (boundary) {
    case "beforeStage": return { beforeStage: fault };
    case "afterStage": return { afterStage: fault };
    case "beforeJournal": return { beforeJournal: fault };
    case "afterJournal": return { afterJournal: fault };
    case "beforeOutputPromotion": return { beforeOutputPromotion: fault };
    case "beforeLockPromotion": return { beforeLockPromotion: fault };
    case "beforeRollback": return { beforeLockPromotion: fault, beforeRollback: fault };
    case "beforeCleanup": return { beforeCleanup: fault };
  }
}

describe("managed output transaction", () => {
  it("installs raw binary output with an external lock and re-observes a no-op", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-managed-output-"));
    roots.push(root);
    const handles: FileHandle[] = [];
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const lockBytes = Buffer.from('{"schema":"tfsb.illustration-lock","schemaVersion":1}\n');
    const rootAuthority = await directoryAuthority(root, handles);
    const output = absentOutput(root, "public/illustration.png", bytes, {
      ...rootAuthority,
      missingDirectories: [join(root, "public")],
    });
    const lock = absentLock(root, lockBytes, rootAuthority);
    let sourceVerifications = 0;
    let projectVerifications = 0;
    try {
      const first = await executeManagedOutputTransaction({
        root,
        namespace: "illustration",
        outputs: [output],
        lock,
        verifySource: () => { sourceVerifications++; },
        verifyProject: () => { projectVerifications++; },
      });
      expect(first.writtenOutputs).toBe(1);
      expect(await readFile(join(root, "public/illustration.png"))).toEqual(bytes);
      expect(await readFile(join(root, "illustration.lock.json"))).toEqual(lockBytes);
      await closeAll(handles.splice(0));

      const publicAuthority = await directoryAuthority(join(root, "public"), handles);
      const newRootAuthority = await directoryAuthority(root, handles);
      const observedOutput = await existingOutput(root, "public/illustration.png", bytes, publicAuthority, handles);
      const observedLock = await existingOutput(root, "illustration.lock.json", lockBytes, newRootAuthority, handles);
      const beforeSource = sourceVerifications;
      const beforeProject = projectVerifications;
      const second = await executeManagedOutputTransaction({
        root,
        namespace: "illustration",
        outputs: [observedOutput],
        lock: observedLock,
        verifySource: () => { sourceVerifications++; },
        verifyProject: () => { projectVerifications++; },
      });
      expect(second.writtenOutputs).toBe(0);
      expect(sourceVerifications).toBeGreaterThan(beforeSource);
      expect(projectVerifications).toBeGreaterThan(beforeProject);
      expect(await findRecoveryResidue(root)).toEqual([]);
    } finally {
      await closeAll(handles);
    }
  });

  it("rolls back staged binary output when lock promotion faults", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-managed-output-"));
    roots.push(root);
    const handles: FileHandle[] = [];
    const bytes = Buffer.from([1, 2, 3, 4]);
    const rootAuthority = await directoryAuthority(root, handles);
    try {
      await expect(executeManagedOutputTransaction({
        root,
        namespace: "illustration",
        outputs: [absentOutput(root, "public/illustration.webp", bytes, { ...rootAuthority, missingDirectories: [join(root, "public")] })],
        lock: absentLock(root, Buffer.from("lock\n"), rootAuthority),
        verifySource: () => undefined,
        verifyProject: () => undefined,
        hooks: { beforeLockPromotion: () => { throw new Error("fault before lock promotion"); } },
      })).rejects.toMatchObject({ diagnostic: { code: "ILLUSTRATION_TRANSACTION_ROLLED_BACK" } });
      expect(await lstat(join(root, "public/illustration.webp")).catch(() => undefined)).toBeUndefined();
      expect(await lstat(join(root, "illustration.lock.json")).catch(() => undefined)).toBeUndefined();
      expect(await findRecoveryResidue(root)).toEqual([]);
    } finally {
      await closeAll(handles);
    }
  });

  it("keeps an authenticated semantic lock no-op byte and inode stable", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-managed-output-"));
    roots.push(root);
    const handles: FileHandle[] = [];
    const oldBytes = Buffer.from('{"schema": "tfsb.lock", "lockDigest": "sha256:old"}\n');
    const nextBytes = Buffer.from('{"schema":"tfsb.lock","lockDigest":"sha256:old"}\n');
    await writeFile(join(root, "illustration.lock.json"), oldBytes);
    const rootAuthority = await directoryAuthority(root, handles);
    const lock = await existingOutput(root, "illustration.lock.json", oldBytes, rootAuthority, handles);
    const nextLock: ManagedOutput = { ...lock, bytes: nextBytes };
    try {
      const before = await stat(join(root, "illustration.lock.json"));
      const result = await executeManagedOutputTransaction({
        root,
        namespace: "consumer",
        outputs: [],
        lock: nextLock,
        semanticLockUnchanged: true,
        verifySource: () => undefined,
        verifyProject: () => undefined,
      });
      const after = await stat(join(root, "illustration.lock.json"));
      expect(result.writtenOutputs).toBe(0);
      expect(await readFile(join(root, "illustration.lock.json"))).toEqual(oldBytes);
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    } finally {
      await closeAll(handles);
    }
  });

  it.skipIf(process.platform === "win32")("binds a retained destination pathname before a no-op", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-managed-output-"));
    roots.push(root);
    const handles: FileHandle[] = [];
    const original = Buffer.from("original-bytes\n");
    const foreign = Buffer.from("foreign-bytes\n");
    const lockBytes = Buffer.from("lock-v1\n");
    await mkdir(join(root, "public"));
    await writeFile(join(root, "public/illustration.png"), original);
    await writeFile(join(root, "illustration.lock.json"), lockBytes);
    const publicAuthority = await directoryAuthority(join(root, "public"), handles);
    const rootAuthority = await directoryAuthority(root, handles);
    const output = await existingOutput(root, "public/illustration.png", original, publicAuthority, handles);
    const lock = await existingOutput(root, "illustration.lock.json", lockBytes, rootAuthority, handles);
    try {
      await replaceWithForeign(join(root, "public/illustration.png"), foreign);
      await expect(executeManagedOutputTransaction({
        root,
        namespace: "illustration",
        outputs: [output],
        lock,
        verifySource: () => undefined,
        verifyProject: () => undefined,
      })).rejects.toMatchObject({ diagnostic: { code: "ILLUSTRATION_DESTINATION_CHANGED" } });
      expect(await readFile(join(root, "public/illustration.png"))).toEqual(foreign);
      expect(await readFile(join(root, "illustration.lock.json"))).toEqual(lockBytes);
      expect(await findRecoveryResidue(root)).toEqual([]);
    } finally {
      await closeAll(handles);
    }
  });

  it.skipIf(process.platform === "win32")("refuses metadata-only lock sync when a retained output moved", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-managed-output-"));
    roots.push(root);
    const handles: FileHandle[] = [];
    const original = Buffer.from("original-bytes\n");
    const foreign = Buffer.from("foreign-bytes\n");
    const lockBytes = Buffer.from("lock-v1\n");
    const nextLockBytes = Buffer.from("lock-v2\n");
    await mkdir(join(root, "public"));
    await writeFile(join(root, "public/illustration.png"), original);
    await writeFile(join(root, "illustration.lock.json"), lockBytes);
    const publicAuthority = await directoryAuthority(join(root, "public"), handles);
    const rootAuthority = await directoryAuthority(root, handles);
    const output = await existingOutput(root, "public/illustration.png", original, publicAuthority, handles);
    const observedLock = await existingOutput(root, "illustration.lock.json", lockBytes, rootAuthority, handles);
    const nextLock: ManagedOutput = { ...observedLock, bytes: nextLockBytes };
    try {
      await replaceWithForeign(join(root, "public/illustration.png"), foreign);
      await expect(executeManagedOutputTransaction({
        root,
        namespace: "illustration",
        outputs: [output],
        lock: nextLock,
        verifySource: () => undefined,
        verifyProject: () => undefined,
      })).rejects.toMatchObject({ diagnostic: { code: "ILLUSTRATION_DESTINATION_CHANGED" } });
      expect(await readFile(join(root, "public/illustration.png"))).toEqual(foreign);
      expect(await readFile(join(root, "illustration.lock.json"))).toEqual(lockBytes);
      expect(await findRecoveryResidue(root)).toEqual([]);
    } finally {
      await closeAll(handles);
    }
  });

  it.each([
    "beforeStage",
    "afterStage",
    "beforeJournal",
    "afterJournal",
    "beforeOutputPromotion",
    "beforeLockPromotion",
    "beforeRollback",
    "beforeCleanup",
  ] as FaultBoundary[])("covers illustration fault boundary %s", async (boundary) => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-managed-output-"));
    roots.push(root);
    const handles: FileHandle[] = [];
    const rootAuthority = await directoryAuthority(root, handles);
    const requiresRecovery = boundary === "beforeRollback" || boundary === "beforeCleanup";
    try {
      await expect(executeManagedOutputTransaction({
        root,
        namespace: "illustration",
        outputs: [absentOutput(root, "public/illustration.png", Buffer.from([1, 2, 3]), { ...rootAuthority, missingDirectories: [join(root, "public")] })],
        lock: absentLock(root, Buffer.from("lock\n"), rootAuthority),
        verifySource: () => undefined,
        verifyProject: () => undefined,
        hooks: faultHooks(boundary),
      })).rejects.toMatchObject({ diagnostic: { code: requiresRecovery ? "ILLUSTRATION_RECOVERY_REQUIRED" : "ILLUSTRATION_TRANSACTION_ROLLED_BACK" } });
      if (requiresRecovery) expect(await findRecoveryResidue(root)).not.toEqual([]);
      else expect(await findRecoveryResidue(root)).toEqual([]);
    } finally {
      await closeAll(handles);
    }
  });

  it.skipIf(process.platform === "win32")("retains a same-byte foreign inode during rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-managed-output-"));
    roots.push(root);
    const handles: FileHandle[] = [];
    const bytes = Buffer.from([7, 8, 9]);
    const target = join(root, "public/illustration.png");
    const rootAuthority = await directoryAuthority(root, handles);
    try {
      await expect(executeManagedOutputTransaction({
        root,
        namespace: "illustration",
        outputs: [absentOutput(root, "public/illustration.png", bytes, { ...rootAuthority, missingDirectories: [join(root, "public")] })],
        lock: absentLock(root, Buffer.from("lock\n"), rootAuthority),
        verifySource: () => undefined,
        verifyProject: () => undefined,
        hooks: {
          beforeLockPromotion: async () => {
            const replacement = `${target}.replacement`;
            await writeFile(replacement, bytes);
            await rename(replacement, target);
            throw new Error("fault after foreign replacement");
          },
        },
      })).rejects.toMatchObject({ diagnostic: { code: "ILLUSTRATION_RECOVERY_REQUIRED" } });
      expect(await readFile(target)).toEqual(bytes);
      expect(await findRecoveryResidue(root)).not.toEqual([]);
    } finally {
      await closeAll(handles);
    }
  });

  it("recognizes only the bounded illustration journal and stage residue forms", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-managed-output-"));
    roots.push(root);
    const token = "a".repeat(32);
    await mkdir(join(root, "public"));
    await writeFile(join(root, `.tfsb-illustration-transaction-${token}.json`), "journal\n");
    await writeFile(join(root, "public", `.illustration.png.tfsb-illustration-stage-${token}`), "stage\n");
    await writeFile(join(root, `.tfsb-illustration-transaction-${token}-extra.json`), "not residue\n");
    expect(await findRecoveryResidue(root)).toEqual([
      `.tfsb-illustration-transaction-${token}.json`,
      `public/.illustration.png.tfsb-illustration-stage-${token}`,
    ]);
  });
});
