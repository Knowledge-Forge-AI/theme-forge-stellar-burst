import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { disposeConsumerSources, verifyConsumerSources } from "../../src/index.js";
import { createConsumerBundle, createConsumerProject } from "./consumer-test-helper.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("offline consumer source authority", () => {
  it("retains a verified local bundle without exposing its path", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const sources = await verifyConsumerSources({ root: consumer, sourceBundles: [producer.archive] });
    expect(sources.packages[0]?.packageId).toBe("core-fixture-brand");
    expect(JSON.stringify(sources)).not.toContain(producer.archive);
    expect(sources.packages[0]?.consumerProfiles?.profiles).toHaveLength(1);
    await disposeConsumerSources(sources);
  });

  it("verifies the fixed npm-installed carrier and exact package identity", async () => {
    const producer = await createConsumerBundle({ npmPackage: { name: "@fixture/core-brand", version: "0.4.0-fixture.1" } }), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const carrier = await createConsumerProject(); roots.push(carrier);
    await rm(`${carrier}/.tfsb`, { recursive: true, force: true });
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(`${carrier}/brand`, { recursive: true });
    await writeFile(`${carrier}/package.json`, JSON.stringify({ name: "@fixture/core-brand", version: "0.4.0-fixture.1" }));
    await writeFile(`${carrier}/brand/tfsb-brand-bundle.zip`, await readFile(producer.archive));
    const sources = await verifyConsumerSources({ root: consumer, sourcePackages: [carrier] });
    expect(sources.packages[0]?.source).toMatchObject({ kind: "npm-installed", npmName: "@fixture/core-brand", npmVersion: "0.4.0-fixture.1" });
    expect(JSON.stringify(sources)).not.toContain(carrier);
    await disposeConsumerSources(sources);
    await writeFile(`${carrier}/package.json`, JSON.stringify({ name: "@fixture/wrong", version: "0.4.0-fixture.1" }));
    await expect(verifyConsumerSources({ root: consumer, sourcePackages: [carrier] })).rejects.toThrow(/match brand package authority/);
  });

  it("rejects symlinked npm package metadata, carrier directories, and bundles", async () => {
    const producer = await createConsumerBundle({ npmPackage: { name: "@fixture/core-brand", version: "0.4.0-fixture.1" } }), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const carrier = await createConsumerProject(); roots.push(carrier); await rm(`${carrier}/.tfsb`, { recursive: true, force: true });
    const { mkdir, symlink, writeFile } = await import("node:fs/promises");
    await mkdir(`${carrier}/real-brand`); await writeFile(`${carrier}/package-real.json`, JSON.stringify({ name: "@fixture/core-brand", version: "0.4.0-fixture.1" }));
    await writeFile(`${carrier}/real-brand/tfsb-brand-bundle.zip`, await readFile(producer.archive));
    await symlink(`${carrier}/package-real.json`, `${carrier}/package.json`); await symlink(`${carrier}/real-brand`, `${carrier}/brand`);
    await expect(verifyConsumerSources({ root: consumer, sourcePackages: [carrier] })).rejects.toThrow(/package.json must be a bounded regular non-symlink file/);
    await rm(`${carrier}/package.json`); await writeFile(`${carrier}/package.json`, JSON.stringify({ name: "@fixture/core-brand", version: "0.4.0-fixture.1" }));
    await expect(verifyConsumerSources({ root: consumer, sourcePackages: [carrier] })).rejects.toThrow(/brand carrier must be a real non-symlink directory/);
    await rm(`${carrier}/brand`); await mkdir(`${carrier}/brand`); await symlink(`${carrier}/real-brand/tfsb-brand-bundle.zip`, `${carrier}/brand/tfsb-brand-bundle.zip`);
    await expect(verifyConsumerSources({ root: consumer, sourcePackages: [carrier] })).rejects.toThrow(/fixed brand\/tfsb-brand-bundle.zip carrier/);
  });
});
