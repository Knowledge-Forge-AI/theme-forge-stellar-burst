import { readFile, readdir, rename, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeRasterExportPlan, planRasterExport } from "../../src/brand/export-plan.js";
import { executeConsumerInstallPlan, executeConsumerSyncPlan, planConsumerInstall, planConsumerSync } from "../../src/index.js";
import { PREVIEW_MARKER_FILENAME, previewProject } from "../../src/preview.js";
import { loadCanonicalProject } from "../../src/project.js";
import { previewStatus } from "../../src/service-protocol/read-methods.js";
import type { ProjectRecord } from "../../src/service-protocol/handles.js";
import { findRecoveryResidue } from "../../src/transaction.js";
import { createConsumerBundle, createConsumerProject, PROFILE_ID, PROFILE_TOML } from "./consumer-test-helper.js";
import { cleanupRoots, fakeRasterCapability, setupRasterProject } from "./raster-test-helper.js";

// Deterministic interposition between a pathname check and the descriptor read: the hook runs inside
// fs.promises.open for one target (one shot), or right after the opened handle is first stat'ed.
const interpose = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | { match: (path: string) => boolean; run: (path: string) => Promise<void> },
  afterFirstStat: undefined as undefined | { match: (path: string) => boolean; run: (path: string) => Promise<void> },
  handles: [] as Array<{ path: string; handle: { readonly fd: number } }>,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = async (path: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
    const target = String(path), before = interpose.beforeOpen;
    if (before?.match(target)) { interpose.beforeOpen = undefined; await before.run(target); }
    const handle = await (actual.open as (...args: unknown[]) => ReturnType<typeof actual.open>)(path, ...rest);
    interpose.handles.push({ path: target, handle });
    const after = interpose.afterFirstStat;
    if (after?.match(target)) {
      interpose.afterFirstStat = undefined;
      const stat = handle.stat.bind(handle);
      Object.defineProperty(handle, "stat", { configurable: true, value: async (...args: Parameters<typeof stat>) => { const value = await stat(...args); await after.run(target); return value; } });
    }
    return handle;
  };
  return { ...actual, open, default: { ...actual, open } };
});

/** Replace a file with identical bytes on a new inode (a same-content swap a pathname reread cannot see). */
async function swapIdentical(path: string): Promise<void> { const bytes = await readFile(path); await writeFile(`${path}.swap`, bytes); await rename(`${path}.swap`, path); }
function expectHandlesClosed(match: (path: string) => boolean): void {
  const opened = interpose.handles.filter((entry) => match(entry.path));
  expect(opened.length).toBeGreaterThan(0);
  expect(opened.filter((entry) => entry.handle.fd !== -1).map((entry) => entry.path)).toEqual([]);
}

const roots: string[] = [];
afterEach(async () => {
  interpose.beforeOpen = undefined; interpose.afterFirstStat = undefined; interpose.handles.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  await cleanupRoots(roots);
});

// Replacing an open file by rename is not portable to Windows; identity checks there are exercised by the ordinary suites.
describe.skipIf(process.platform === "win32")("descriptor-verified pathname reads (CI4 js/file-system-race repairs)", () => {
  it("consumer rollback never deletes an identical-content replacement of a promoted output", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const plan = await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] });
    const target = join(consumer, "public", "fixture-mark.svg");
    await expect(executeConsumerInstallPlan(plan, { beforeLockPromotion: () => {
      interpose.beforeOpen = { match: (path) => path === target, run: swapIdentical };
      throw new Error("fault after output promotion");
    } })).rejects.toMatchObject({ diagnostic: { code: "CONSUMER_RECOVERY_REQUIRED" } });
    // The swapped-in inode was not proven ours, so rollback retained it instead of removing it by pathname.
    expect(await readFile(target, "utf8")).toContain("<svg");
    expect(await findRecoveryResidue(consumer)).not.toEqual([]);
    expectHandlesClosed((path) => path === target);
  });

  it("consumer promotion refuses a promoted destination swapped while it is re-verified", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const plan = await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] });
    const target = join(consumer, "public", "fixture-mark.svg");
    await expect(executeConsumerInstallPlan(plan, { beforeLockPromotion: () => {
      interpose.beforeOpen = { match: (path) => path === target, run: swapIdentical };
    } })).rejects.toThrow(/after CONSUMER_DESTINATION_CHANGED/);
    expectHandlesClosed((path) => path === target);
  });

  it("consumer sync refuses an identical-content backup swapped during backup verification", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    await executeConsumerInstallPlan(await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] }));
    const extra = `${PROFILE_TOML}\n[[profiles.outputs]]\nasset = "fixture-mark-on-light"\ndestination = "public/fixture-mark-copy.svg"\nrequirement = "required"\ncollision = "error"\n`;
    const updated = await createConsumerBundle({ profileToml: extra }); roots.push(updated.root);
    const plan = await planConsumerSync({ root: consumer, sourceBundles: [updated.archive] });
    const isLockBackup = (path: string) => path.includes(".brand.lock.json.tfsb-consumer-backup-");
    interpose.beforeOpen = { match: isLockBackup, run: swapIdentical };
    await expect(executeConsumerSyncPlan(plan)).rejects.toThrow(/after CONSUMER_BACKUP_CHANGED/);
    // The unproven backup is retained for recovery; it is never renamed back over the lock or deleted.
    expect((await readdir(join(consumer, ".tfsb"))).some(isLockBackup)).toBe(true);
    expectHandlesClosed(isLockBackup);
  });

  it("raster export inspection keeps its error contract for swap and short-read races and closes handles", async () => {
    const root = await setupRasterProject(roots), capability = fakeRasterCapability();
    await executeRasterExportPlan(await planRasterExport(root, { profileId: "web-icons", capability }));
    const target = join(root, "public", "icon.png");
    interpose.beforeOpen = { match: (path) => path === target, run: swapIdentical };
    await expect(planRasterExport(root, { profileId: "web-icons", capability })).rejects.toMatchObject({ diagnostic: { code: "RASTER_OUTPUT_CHANGED" } });
    interpose.afterFirstStat = { match: (path) => path === target, run: async (path) => { await truncate(path, 8); } };
    await expect(planRasterExport(root, { profileId: "web-icons", capability })).rejects.toMatchObject({ diagnostic: { code: "RASTER_OUTPUT_CHANGED" } });
    expectHandlesClosed((path) => path === target);
  });

  it("preview status maps swapped, truncated and vanished files to states instead of reading or throwing", async () => {
    const root = await setupRasterProject(roots);
    await previewProject({ root });
    const status = async () => previewStatus({ kind: "project", root } as ProjectRecord, await loadCanonicalProject(root, "check"));
    expect(await status()).toMatchObject({ status: "owned-clean" });
    const previewRoot = join(root, ".tfsb-preview");
    const marker: string | undefined = PREVIEW_MARKER_FILENAME;
    const file = (await readdir(previewRoot, { recursive: true, withFileTypes: true })).find((entry) => entry.isFile() && entry.name.endsWith(".svg"));
    expect(marker).toBeDefined(); expect(file).toBeDefined();
    const markerPath = join(previewRoot, marker!), filePath = join(file!.parentPath, file!.name);

    interpose.beforeOpen = { match: (path) => path === markerPath, run: swapIdentical };
    expect(await status()).toMatchObject({ status: "unowned/invalid", markerDigest: null });
    interpose.beforeOpen = { match: (path) => path === filePath, run: swapIdentical };
    expect(await status()).toMatchObject({ status: "owned-drift" });
    interpose.afterFirstStat = { match: (path) => path === filePath, run: async (path) => { await truncate(path, 1); } };
    expect(await status()).toMatchObject({ status: "owned-drift" });
    interpose.beforeOpen = { match: (path) => path === filePath, run: async (path) => { await rm(path); } };
    expect(await status()).toMatchObject({ status: "owned-drift" });
    expectHandlesClosed((path) => path === markerPath || path === filePath);
  });
});
