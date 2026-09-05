import { realpath, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { ReadMethods } from "../../src/service-protocol/read-methods.js";
import { StudioSession } from "../../src/service-protocol/session.js";
import { validateResult } from "../../src/service-protocol/v1-validate.js";
import { createConsumerBundle, createConsumerProject } from "../brand/consumer-test-helper.js";
import { createDeriveProject } from "./brand-test-helper.js";
import { fakeRasterCapability, setupRasterProject } from "../brand/raster-test-helper.js";
import { QUALIFICATION_ID, RENDERER_BUILD_DIGEST } from "../../src/service-protocol/v1-registry.js";
import { executeBrandQaBaselineUpdatePlan, planBrandQaBaselineUpdate } from "../../src/brand/qa-baseline.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function context(root: string, version: "1.0" | "1.1" | "1.2" = "1.1"): Promise<{ session: StudioSession; reads: ReadMethods; projectHandle: string }> {
  const session = new StudioSession();
  await session.negotiate(version);
  const opened = await session.handles.openProject(await realpath(root)) as { readonly projectHandle: string };
  return { session, reads: new ReadMethods(session), projectHandle: opened.projectHandle };
}

async function read(reads: ReadMethods, method: any, params: unknown): Promise<any> {
  const result = await reads.execute(method, params, new AbortController().signal, method, () => undefined);
  validateResult(method, result);
  return result;
}

describe("Studio brand read methods", () => {
  it("returns the closed unbranded status and project-scoped raster capability", async () => {
    const root = await createConsumerProject(); roots.push(root);
    const { session, reads, projectHandle } = await context(root);
    const common = { sessionNonce: session.nonce, projectHandle };
    expect(await read(reads, "brand.status", common)).toEqual({ present: false, raster: { available: false } });
    expect(await read(reads, "brand.export.capability", common)).toEqual({ available: false });
    await session.shutdown();
  });

  it("serves bounded producer reads and authenticated pagination", async () => {
    const producer = await createConsumerBundle(); roots.push(producer.root);
    const { session, reads, projectHandle } = await context(producer.root);
    const common = { sessionNonce: session.nonce, projectHandle };
    const status = await read(reads, "brand.status", common);
    expect(status).toMatchObject({ present: true, schemaVersion: 1, counts: { families: 1 }, raster: { available: false } });
    const families = await read(reads, "brand.family.list", { ...common, pageSize: 1 });
    expect(families.page).toMatchObject({ size: 1, count: 1 });
    expect(JSON.stringify(families)).not.toContain(producer.root);
    const staleCursor = session.cursors.encode({ protocolVersion: "1.1", scope: { method: "brand.family.list", kind: "project", handle: projectHandle }, viewDigest: `sha256:${"f".repeat(64)}`, lastKey: { projectId: "project", kind: "brand", id: "family-a" }, pageSize: 1 });
    await expect(read(reads, "brand.family.list", { ...common, pageSize: 1, cursor: staleCursor })).rejects.toMatchObject({ symbolicCode: "CURSOR_STALE" });
    await expect(read(reads, "brand.token.list", { ...common, pageSize: 1 })).rejects.toMatchObject({ symbolicCode: "DOMAIN_OPERATION_FAILED" });
    await expect(read(reads, "brand.recipe.graph", common)).rejects.toMatchObject({ symbolicCode: "DOMAIN_OPERATION_FAILED" });
    await expect(read(reads, "brand.qa.profile.get", { ...common, profileId: "core" })).rejects.toMatchObject({ symbolicCode: "DOMAIN_OPERATION_FAILED" });
    await expect(read(reads, "brand.export.status", { ...common, pageSize: 64 })).rejects.toMatchObject({ symbolicCode: "DOMAIN_OPERATION_FAILED" });
    await session.shutdown();
  });

  it("diffs against the exact retained source authority without paths", async () => {
    const producer = await createConsumerBundle(); roots.push(producer.root);
    const { session, reads, projectHandle } = await context(producer.root);
    const opened = await session.handles.openSource(await realpath(producer.archive), { purpose: "brand-bundle" }) as { readonly sourceHandle: string };
    const result = await read(reads, "brand.diff", { sessionNonce: session.nonce, projectHandle, sourceHandle: opened.sourceHandle });
    expect(result).toMatchObject({ diff: { status: "equal" }, visualDiff: { available: false } });
    expect(JSON.stringify(result)).not.toContain(producer.root);
    await session.shutdown();
  });

  it("returns complete canonical token and recipe DTOs for enabled domains", async () => {
    const root = await createDeriveProject(); roots.push(root);
    const { session, reads, projectHandle } = await context(root, "1.2");
    const common = { sessionNonce: session.nonce, projectHandle };
    const tokens = await read(reads, "brand.token.list", { ...common, pageSize: 1 });
    expect(tokens.page).toMatchObject({ count: 1, nextCursor: expect.any(String) });
    expect(tokens.page.items[0]).toMatchObject({ id: "brand-blue", type: "color", value: "#0066CCFF", unused: false });
    const second = await read(reads, "brand.token.list", { ...common, pageSize: 1, cursor: tokens.page.nextCursor });
    expect(second.page).toMatchObject({ count: 1, nextCursor: null });
    const graph = await read(reads, "brand.recipe.graph", common);
    expect(graph).toMatchObject({ affectedTargetCount: 1, nodes: [{ recipeId: "recipe-derived-dark", targetAsset: "fixture-mark-derived-dark", operations: ["replace-paint", "copy-accessibility"] }] });
    const raw = fakeRasterCapability(); if (!raw.available) throw new Error("fake raster unavailable");
    session.rasterCapability = Object.freeze({ available: true, adapter: Object.freeze({ ...raw.adapter, descriptor: Object.freeze({ ...raw.adapter.descriptor, companionVersion: "0.0.0-tfsb47f", rendererBuildDigest: RENDERER_BUILD_DIGEST, nodeMajor: 22, platformClaim: "darwin-arm64", qualificationId: QUALIFICATION_ID }) }), qa: Object.freeze({ ...raw.qa, descriptor: Object.freeze({ id: "resvg-png-v1", version: "2.6.2", qualificationId: QUALIFICATION_ID, platformClaim: "darwin-arm64" }) }) });
    const tokenBackground = await read(reads, "brand.visual.evidence.get", { ...common, kind: "project-render", target: { kind: "asset", assetId: "fixture-mark-on-light" }, width: 16, height: 16, background: "token:brand-blue" });
    expect(tokenBackground).toMatchObject({ configuration: { background: "token:brand-blue" }, artifacts: [{ role: "current" }] });
    await session.shutdown();
  });

  it("returns the QA profile/result and export ownership view without raster capability", async () => {
    const root = await setupRasterProject(roots, { qa: true });
    const { session, reads, projectHandle } = await context(root);
    const common = { sessionNonce: session.nonce, projectHandle };
    const profile = await read(reads, "brand.qa.profile.get", { ...common, profileId: "visual" });
    expect(profile).toMatchObject({ profile: { id: "visual", renderer: "required" }, resolvedTargetCount: 1, evaluationCount: 1, raster: { available: false } });
    const qa = await read(reads, "brand.qa.result.get", { ...common, profileId: "visual" });
    expect(qa).toMatchObject({ profileId: "visual", status: "unavailable", exitCode: 3, counts: { unavailable: 1 } });
    const exports = await read(reads, "brand.export.status", { ...common, pageSize: 64 });
    expect(exports.page).toMatchObject({ count: 1, items: [{ profileId: "web-icons", outputId: "icon", state: "create", capabilityAvailable: false }] });
    await session.shutdown();
  });

  it("returns conflict-checked consumer profile and lock views from authentic source leases", async () => {
    const producer = await createConsumerBundle(); const consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const { session, reads, projectHandle } = await context(consumer);
    const source = await session.handles.openSource(await realpath(producer.archive), { purpose: "brand-bundle" }) as { readonly sourceHandle: string };
    const common = { sessionNonce: session.nonce, projectHandle, sourceHandles: [source.sourceHandle] };
    const profiles = await read(reads, "brand.consumer.profile.list", { ...common, pageSize: 64 });
    expect(profiles.page).toMatchObject({ count: 1, items: [{ authorityKind: "producer-package", packageId: "core-fixture-brand" }] });
    const lock = await read(reads, "brand.consumer.lock.status", common);
    expect(lock).toMatchObject({ status: "ok", packages: [], mappings: [] });
    await session.shutdown();
  });

  it("lists deterministic QA profiles only in 1.2 and renders bounded current PNG evidence", async () => {
    const root = await setupRasterProject(roots, { qa: true });
    for (const version of ["1.0", "1.1"] as const) {
      const old = await context(root, version);
      await expect(read(old.reads, "brand.qa.profile.list", { sessionNonce: old.session.nonce, projectHandle: old.projectHandle, pageSize: 64 })).rejects.toMatchObject({ symbolicCode: "METHOD_CAPABILITY_UNAVAILABLE" });
      await expect(read(old.reads, "brand.visual.evidence.get", { sessionNonce: old.session.nonce, projectHandle: old.projectHandle, kind: "project-render", target: { kind: "asset", assetId: "fixture-mark-on-light" }, width: 16, height: 16, background: "transparent" })).rejects.toMatchObject({ symbolicCode: "METHOD_CAPABILITY_UNAVAILABLE" });
      await old.session.shutdown();
    }

    const { session, reads, projectHandle } = await context(root, "1.2");
    const raw = fakeRasterCapability(); if (!raw.available) throw new Error("fake raster unavailable");
    const adapterDescriptor = Object.freeze({ ...raw.adapter.descriptor, companionVersion: "0.0.0-tfsb47f", rendererBuildDigest: RENDERER_BUILD_DIGEST, nodeMajor: 22, platformClaim: "darwin-arm64", qualificationId: QUALIFICATION_ID });
    session.rasterCapability = Object.freeze({ available: true, adapter: Object.freeze({ ...raw.adapter, descriptor: adapterDescriptor }), qa: Object.freeze({ ...raw.qa, descriptor: Object.freeze({ id: "resvg-png-v1", version: "2.6.2", qualificationId: QUALIFICATION_ID, platformClaim: "darwin-arm64" }) }) });
    const common = { sessionNonce: session.nonce, projectHandle };
    const profiles = await read(reads, "brand.qa.profile.list", { ...common, pageSize: 1 });
    expect(profiles.page).toMatchObject({ size: 1, count: 1, nextCursor: null, items: [{ id: "visual", caseCount: 1, semanticCaseCount: 0, visualCaseCount: 1, baselineCaseCount: 0 }] });
    const evidence = await read(reads, "brand.visual.evidence.get", { ...common, kind: "project-render", target: { kind: "asset", assetId: "fixture-mark-on-light" }, width: 16, height: 16, background: "transparent" });
    expect(evidence).toMatchObject({ schema: "tfsb.studio-visual-evidence", kind: "project-render", artifacts: [{ role: "current", mediaType: "image/png", encoding: "base64", width: 16, height: 16 }] });
    expect(evidence.artifacts[0].byteLength).toBe(Buffer.from(evidence.artifacts[0].bytesBase64, "base64").byteLength);
    const boundedMaximum = await read(reads, "brand.visual.evidence.get", { ...common, kind: "project-render", target: { kind: "binding", family: "core-fixture", role: "mark", variant: "standard-light" }, width: 1024, height: 1024, background: "#FFFFFFFF" });
    expect(boundedMaximum).toMatchObject({ configuration: { width: 1024, height: 1024, background: "#FFFFFFFF" }, target: { assetId: "fixture-mark-on-light", binding: { family: "core-fixture", role: "mark", variant: "standard-light" } } });
    expect(JSON.stringify(evidence)).not.toContain(root);
    await session.shutdown();
  });

  it("renders verified source/project evidence with exact before/after roles", async () => {
    const producer = await createConsumerBundle(); roots.push(producer.root);
    const { session, reads, projectHandle } = await context(producer.root, "1.2");
    const opened = await session.handles.openSource(await realpath(producer.archive), { purpose: "brand-bundle" }) as { readonly sourceHandle: string };
    const raw = fakeRasterCapability(); if (!raw.available) throw new Error("fake raster unavailable");
    session.rasterCapability = Object.freeze({ available: true, adapter: Object.freeze({ ...raw.adapter, descriptor: Object.freeze({ ...raw.adapter.descriptor, companionVersion: "0.0.0-tfsb47f", rendererBuildDigest: RENDERER_BUILD_DIGEST, nodeMajor: 22, platformClaim: "darwin-arm64", qualificationId: QUALIFICATION_ID }) }), qa: Object.freeze({ ...raw.qa, descriptor: Object.freeze({ id: "resvg-png-v1", version: "2.6.2", qualificationId: QUALIFICATION_ID, platformClaim: "darwin-arm64" }) }) });
    const evidence = await read(reads, "brand.visual.evidence.get", { kind: "brand-diff", sessionNonce: session.nonce, projectHandle, sourceHandle: opened.sourceHandle, target: { kind: "asset", assetId: "fixture-mark-on-light" }, width: 16, height: 16, background: "transparent" });
    expect(evidence).toMatchObject({ kind: "brand-diff", sourceDigest: expect.stringMatching(/^sha256:/u), artifacts: [{ role: "before" }, { role: "after" }], difference: { claim: "pixel-equal-for-this-renderer-and-case-only" } });
    expect(JSON.stringify(evidence)).not.toMatch(/geometry-equivalent|\.tfsb|\/Users\//u);
    await session.shutdown();
  });

  it("returns exact baseline/current evidence for an owner-bound QA case", async () => {
    const root = await setupRasterProject(roots, { qa: true });
    const raw = fakeRasterCapability(); if (!raw.available) throw new Error("fake raster unavailable");
    const renderer = Object.freeze({ ...raw.qa, descriptor: Object.freeze({ id: "resvg-png-v1", version: "2.6.2", qualificationId: QUALIFICATION_ID, platformClaim: "darwin-arm64" }) });
    const plan = await planBrandQaBaselineUpdate({ root, profileId: "visual", caseId: "golden", renderer, create: { asset: "fixture-mark-on-light", size: [16, 16], background: "transparent" } });
    await executeBrandQaBaselineUpdatePlan(plan);
    const { session, reads, projectHandle } = await context(root, "1.2");
    session.rasterCapability = Object.freeze({ available: true, adapter: Object.freeze({ ...raw.adapter, descriptor: Object.freeze({ ...raw.adapter.descriptor, companionVersion: "0.0.0-tfsb47f", rendererBuildDigest: RENDERER_BUILD_DIGEST, nodeMajor: 22, platformClaim: "darwin-arm64", qualificationId: QUALIFICATION_ID }) }), qa: renderer });
    const profile = await read(reads, "brand.qa.profile.get", { sessionNonce: session.nonce, projectHandle, profileId: "visual" });
    expect(profile.baselines).toEqual([{ caseId: "golden", digest: expect.stringMatching(/^sha256:/u) }]);
    expect(JSON.stringify(profile)).not.toMatch(/baselinePath|\.tfsb|\/Users\//u);
    const evidence = await read(reads, "brand.visual.evidence.get", { kind: "qa-baseline", sessionNonce: session.nonce, projectHandle, profileId: "visual", caseId: "golden" });
    expect(evidence).toMatchObject({ kind: "qa-baseline", qaDigest: expect.stringMatching(/^sha256:/u), artifacts: [{ role: "baseline" }, { role: "current" }], difference: { changedPixels: 0, maximumChannelDelta: 0, changedBounds: null, claim: "pixel-equal-for-this-renderer-and-case-only" } });
    await session.shutdown();
  });
});
