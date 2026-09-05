import { readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { disposeConsumerPlan, executeConsumerInstallPlan, inspectConsumerState, parseConsumerBrandLock, planConsumerInstall } from "../../src/index.js";
import { createConsumerBundle, createConsumerProject, PROFILE_ID, PROFILE_TOML } from "./consumer-test-helper.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("consumer install transaction", () => {
  it("publishes required asset and legal companion with lock last", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const plan = await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] });
    expect(plan.outputs.map((entry) => entry.destination)).toEqual(["GUIDANCE-BRAND.md", "public/fixture-mark.svg"]);
    const result = await executeConsumerInstallPlan(plan);
    expect(result.writtenOutputs).toBe(2);
    expect(await readFile(`${consumer}/GUIDANCE-BRAND.md`, "utf8")).toContain("Core Fixture");
    expect(await readFile(`${consumer}/public/fixture-mark.svg`, "utf8")).toContain("<svg");
    const lock = parseConsumerBrandLock(await readFile(`${consumer}/.tfsb/brand.lock.json`, "utf8"));
    expect(lock.ok).toBe(true);
    expect((await inspectConsumerState({ root: consumer })).status).toBe("source-unavailable");
    expect((await inspectConsumerState({ root: consumer, sourceBundles: [producer.archive] })).status).toBe("ok");
  });

  it("never treats an equal-byte unowned destination as ownership", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const { mkdir, writeFile } = await import("node:fs/promises"); await mkdir(`${consumer}/public`, { recursive: true });
    await writeFile(`${consumer}/public/fixture-mark.svg`, await readFile("docs/examples/v0.4/brand-system/core-minimal/bundle/assets/fixture-mark-on-light.svg"));
    await expect(planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] })).rejects.toThrow(/already exists/);
  });

  it("resolves parameters, when-conditions, filename policies, optional outputs, and composition end-to-end", async () => {
    const producerToml = `schema = "tfsb.consumer-profiles"
schema_version = 1
[[profiles]]
id = "advanced"
version = 1
compatible_package = "core-fixture-brand"
[[profiles.parameters]]
id = "theme"
values = ["light", "dark"]
[[profiles.outputs]]
asset = "fixture-mark-on-light"
destination_directory = "public/themed"
filename_policy = "asset-id.svg"
requirement = "required"
collision = "error"
[[profiles.outputs.when]]
parameter = "theme"
equals = "light"
[[profiles.outputs]]
asset = "fixture-mark-on-light"
destination_directory = "public/themed"
filename_policy = "source-basename"
requirement = "required"
collision = "error"
[[profiles.outputs.when]]
parameter = "theme"
equals = "dark"
[[profiles.outputs]]
companion = "absent-companion"
destination = "docs/ABSENT.md"
requirement = "optional"
collision = "error"
`;
    const producer = await createConsumerBundle({ profileToml: producerToml });
    const consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const localToml = `schema = "tfsb.consumer-profiles"
schema_version = 1
[[profiles]]
id = "local-composed"
version = 1
compatible_package = "core-fixture-brand"
composes = ["core-fixture-brand/advanced"]
[[profiles.outputs]]
companion = "fixture-guidance"
destination_directory = "docs/legal"
filename_policy = "source-basename"
requirement = "required"
collision = "error"
`;
    await writeFile(`${consumer}/.tfsb/consumer-profiles.toml`, localToml);
    const plan = await planConsumerInstall({
      root: consumer,
      sourceBundles: [producer.archive],
      profiles: ["core-fixture-brand/local-composed"],
      parameters: { "core-fixture-brand/advanced": { theme: "light" } },
    });
    expect(plan.outputs.map((e) => e.destination).sort()).toEqual(["docs/legal/GUIDANCE.md", "public/themed/fixture-mark-on-light.svg"]);
    const executed = await executeConsumerInstallPlan(plan);
    expect(executed.writtenOutputs).toBe(2);
    expect(await readFile(`${consumer}/public/themed/fixture-mark-on-light.svg`, "utf8")).toContain("<svg");
    expect(await readFile(`${consumer}/docs/legal/GUIDANCE.md`, "utf8")).toContain("Core Fixture");
    const lock = parseConsumerBrandLock(await readFile(`${consumer}/.tfsb/brand.lock.json`, "utf8"));
    expect(lock.ok).toBe(true);
  });

  it("keeps local profiles separate and rejects producer identity override", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const local = `schema = "tfsb.consumer-profiles"\nschema_version = 1\n[[profiles]]\nid = "local"\nversion = 1\ncompatible_package = "core-fixture-brand"\n[[profiles.outputs]]\nasset = "fixture-mark-on-light"\ndestination = "public/local.svg"\nrequirement = "required"\ncollision = "error"\n`;
    await writeFile(`${consumer}/.tfsb/consumer-profiles.toml`, local);
    const plan = await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: ["core-fixture-brand/local"] });
    expect(plan.outputs[0]?.destination).toBe("public/local.svg");
    await disposeConsumerPlan(plan);
    await writeFile(`${consumer}/.tfsb/consumer-profiles.toml`, PROFILE_TOML);
    await expect(planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] })).rejects.toThrow(/conflicts with producer profile/);
  });

  it("rejects public plan mutation, copying, and one-shot replay", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const plan = await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] });
    expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.outputs[0])).toBe(true);
    expect(() => { (plan.outputs[0] as { destination: string }).destination = "forged.svg"; }).toThrow();
    await expect(executeConsumerInstallPlan({ ...plan })).rejects.toThrow(/authentic unused plan/);
    await executeConsumerInstallPlan(plan);
    await expect(executeConsumerInstallPlan(plan)).rejects.toThrow(/authentic unused plan/);
  });

  it("merges two disjoint verified packages deterministically", async () => {
    const first = await createConsumerBundle();
    const secondProfile = PROFILE_TOML.replaceAll("core-fixture-brand", "second-brand").replace("public/fixture-mark.svg", "public/second-mark.svg").slice(0, PROFILE_TOML.replaceAll("core-fixture-brand", "second-brand").replace("public/fixture-mark.svg", "public/second-mark.svg").indexOf("[[profiles.outputs]]\ncompanion"));
    const second = await createConsumerBundle({ packageId: "second-brand", profileToml: secondProfile });
    const consumer = await createConsumerProject(); roots.push(first.root, second.root, consumer);
    await executeConsumerInstallPlan(await planConsumerInstall({ root: consumer, sourceBundles: [second.archive, first.archive], profiles: ["second-brand/basic", PROFILE_ID] }));
    const parsed = parseConsumerBrandLock(await readFile(`${consumer}/.tfsb/brand.lock.json`, "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
    expect(parsed.value.packages.map((entry) => entry.packageId)).toEqual(["core-fixture-brand", "second-brand"]);
  });
});
