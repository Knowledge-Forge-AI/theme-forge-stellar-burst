import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AuthorityLedger } from "../../src/service-protocol/authority-ledger.js";
import { HandleRegistry } from "../../src/service-protocol/handles.js";
import { disposeConsumerSources } from "../../src/brand/consumer-source.js";
import { createConsumerBundle, createConsumerProject } from "../brand/consumer-test-helper.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("Studio brand source handles", () => {
  it("returns sanitized package facts and lends independently disposable authentic leases", async () => {
    const producer = await createConsumerBundle();
    const consumer = await createConsumerProject();
    roots.push(producer.root, consumer);
    const ledger = new AuthorityLedger();
    const handles = new HandleRegistry(ledger);
    const archive = await realpath(producer.archive);
    const opened = await handles.openSource(archive, { purpose: "brand-bundle" }) as any;
    expect(opened).toMatchObject({ rootKind: "source", authorityKind: "brand-bundle", packageId: "core-fixture-brand", capabilities: { analyze: false, brandDiff: true, consumerSource: true } });
    expect(JSON.stringify(opened)).not.toContain(archive);
    const first = await handles.leaseBrandSources([opened.sourceHandle]);
    const second = await handles.leaseBrandSources([opened.sourceHandle]);
    expect(first.packages[0]).toBe(second.packages[0]);
    await disposeConsumerSources(first);
    await expect(handles.brandSource(opened.sourceHandle)).resolves.toMatchObject({ purpose: "brand-bundle" });
    await disposeConsumerSources(second);
    await handles.dispose();
    expect(ledger.retainedBytes).toBe(0);
    expect(ledger.activeReservations).toBe(0);
  });

  it("rejects brand handles as analyze sources and rejects random handles", async () => {
    const producer = await createConsumerBundle(); roots.push(producer.root);
    const handles = new HandleRegistry();
    const opened = await handles.openSource(await realpath(producer.archive), { purpose: "brand-bundle" }) as any;
    await expect(handles.source(opened.sourceHandle)).rejects.toMatchObject({ symbolicCode: "ROOT_HANDLE_INVALID" });
    await expect(handles.brandSource("source_random")).rejects.toMatchObject({ symbolicCode: "ROOT_HANDLE_INVALID" });
    await handles.dispose();
  });

  it("opens the fixed npm carrier, rejects duplicate package identities, and detects carrier drift", async () => {
    const producer = await createConsumerBundle({ npmPackage: { name: "@fixture/core-brand", version: "1.0.0" } });
    const installed = await mkdtemp(join(tmpdir(), "tfsb-studio-npm-source-")); roots.push(producer.root, installed);
    await mkdir(join(installed, "brand"), { recursive: true });
    await writeFile(join(installed, "package.json"), JSON.stringify({ name: "@fixture/core-brand", version: "1.0.0" }));
    await cp(producer.archive, join(installed, "brand", "tfsb-brand-bundle.zip"));
    const handles = new HandleRegistry();
    const npm = await handles.openSource(await realpath(installed), { purpose: "npm-installed-package" }) as any;
    expect(npm).toMatchObject({ authorityKind: "npm-installed-package", npmName: "@fixture/core-brand", npmVersion: "1.0.0" });
    const bundle = await handles.openSource(await realpath(producer.archive), { purpose: "brand-bundle" }) as any;
    await expect(handles.leaseBrandSources([npm.sourceHandle, bundle.sourceHandle])).rejects.toMatchObject({ symbolicCode: "DOMAIN_OPERATION_FAILED" });
    const carrier = join(installed, "brand", "tfsb-brand-bundle.zip");
    await writeFile(carrier, Buffer.concat([await readFile(carrier), Buffer.from("drift")]));
    await expect(handles.brandSource(npm.sourceHandle)).rejects.toMatchObject({ symbolicCode: "ROOT_INVALID" });
    await handles.dispose();
  });
});
