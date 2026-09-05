import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { executeConsumerInstallPlan, planConsumerInstall } from "../../src/index.js";
import { findRecoveryResidue } from "../../src/transaction.js";
import { createConsumerBundle, createConsumerProject, PROFILE_ID } from "./consumer-test-helper.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("consumer transaction races and recovery", () => {
  it("rolls back outputs when lock promotion is faulted", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const plan = await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] });
    await expect(executeConsumerInstallPlan(plan, { beforeLockPromotion: () => { throw new Error("fault"); } })).rejects.toThrow(/rolled back/);
    await expect(access(`${consumer}/public/fixture-mark.svg`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${consumer}/.tfsb/brand.lock.json`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await findRecoveryResidue(consumer)).toEqual([]);
  });

  it("detects a concurrent unowned target and never overwrites it", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const plan = await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] });
    await expect(executeConsumerInstallPlan(plan, { beforeOutputPromotion: async (index) => { if (index === 0) await writeFile(`${consumer}/GUIDANCE-BRAND.md`, "concurrent"); } })).rejects.toThrow(/rolled back/);
    expect(await (await import("node:fs/promises")).readFile(`${consumer}/GUIDANCE-BRAND.md`, "utf8")).toBe("concurrent");
    await expect(access(`${consumer}/.tfsb/brand.lock.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects source and canonical state changes after planning", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const sourcePlan = await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] });
    const archiveBytes = await readFile(producer.archive);
    await expect(executeConsumerInstallPlan(sourcePlan, { beforeOutputPromotion: async () => { await rm(producer.archive); await writeFile(producer.archive, archiveBytes); } })).rejects.toThrow(/rolled back/);
    const canonicalPlan = await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] });
    await expect(executeConsumerInstallPlan(canonicalPlan, { beforeOutputPromotion: async () => { await writeFile(`${consumer}/.tfsb/project.toml`, `${await readFile(`${consumer}/.tfsb/project.toml`, "utf8")}# changed\n`); } })).rejects.toThrow(/rolled back/);
  });

  it("retains recovery residue instead of deleting a replaced stage", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const plan = await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] });
    await expect(executeConsumerInstallPlan(plan, { afterStage: async (index) => {
      if (index !== 0) return;
      const stage = (await readdir(consumer)).find((name) => name.includes("tfsb-consumer-stage"));
      if (stage === undefined) throw new Error("stage not found");
      const path = `${consumer}/${stage}`, bytes = await readFile(path); await rm(path); await writeFile(path, bytes);
    } })).rejects.toThrow(/retained recovery residue/);
    expect((await findRecoveryResidue(consumer)).some((path) => path.includes("tfsb-consumer-stage"))).toBe(true);
  });

  it("blocks future planning while nested recovery residue exists", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    await mkdir(`${consumer}/public`, { recursive: true });
    await writeFile(`${consumer}/public/.output.tfsb-consumer-stage-${"a".repeat(32)}`, "residue");
    await expect(planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] })).rejects.toThrow(/Recovery residue requires manual inspection/);
  });
});
