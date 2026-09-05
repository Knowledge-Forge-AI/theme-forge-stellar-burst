import { access, readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { executeConsumerInstallPlan, executeConsumerSyncPlan, planConsumerInstall, planConsumerSync } from "../../src/index.js";
import { createConsumerBundle, createConsumerProject, PROFILE_ID, PROFILE_TOML } from "./consumer-test-helper.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function installed() {
  const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
  await executeConsumerInstallPlan(await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] }));
  return { producer, consumer };
}

describe("consumer sync", () => {
  it("is an exact no-op when source and installed state are current", async () => {
    const { producer, consumer } = await installed();
    const before = await readFile(`${consumer}/.tfsb/brand.lock.json`);
    const result = await executeConsumerSyncPlan(await planConsumerSync({ root: consumer, sourceBundles: [producer.archive] }));
    expect(result.writtenOutputs).toBe(0);
    expect(await readFile(`${consumer}/.tfsb/brand.lock.json`)).toEqual(before);
  });

  it("adds a new required output but never removes an old mapping", async () => {
    const { consumer } = await installed();
    const extra = `${PROFILE_TOML}\n[[profiles.outputs]]\nasset = "fixture-mark-on-light"\ndestination = "public/fixture-mark-copy.svg"\nrequirement = "required"\ncollision = "error"\n`;
    const updated = await createConsumerBundle({ profileToml: extra }); roots.push(updated.root);
    const result = await executeConsumerSyncPlan(await planConsumerSync({ root: consumer, sourceBundles: [updated.archive] }));
    expect(result.destinations).toContain("public/fixture-mark-copy.svg");
    await expect(access(`${consumer}/public/fixture-mark-copy.svg`)).resolves.toBeUndefined();

    const withoutCompanion = PROFILE_TOML.slice(0, PROFILE_TOML.indexOf("[[profiles.outputs]]\ncompanion"));
    const reduced = await createConsumerBundle({ profileToml: withoutCompanion }); roots.push(reduced.root);
    await expect(planConsumerSync({ root: consumer, sourceBundles: [reduced.archive] })).rejects.toThrow(/remove an installed destination/);
  });
});
