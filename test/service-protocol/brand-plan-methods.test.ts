import { existsSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MutationMethods } from "../../src/service-protocol/mutation-methods.js";
import { StudioSession } from "../../src/service-protocol/session.js";
import { validateResult } from "../../src/service-protocol/v1-validate.js";
import { createConsumerBundle, createConsumerProject, PROFILE_ID } from "../brand/consumer-test-helper.js";
import { createDeriveProject } from "./brand-test-helper.js";
import { createRasterCapabilityFromModule, type RasterRenderRequest } from "../../src/brand/raster-capability.js";
import { executeBrandQaBaselineUpdatePlan, planBrandQaBaselineUpdate } from "../../src/brand/qa-baseline.js";
import { rgbaPng, setupRasterProject } from "../brand/raster-test-helper.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function execute(methods: MutationMethods, method: any, params: unknown): Promise<any> {
  const result = await methods.execute(method, params, new AbortController().signal, method, () => undefined);
  validateResult(method, result);
  return result;
}

describe("Studio brand plan methods", () => {
  it("retains, discards, and applies the authentic derivation plan", async () => {
    const root = await createDeriveProject(); roots.push(root);
    const session = new StudioSession(); await session.negotiate("1.1");
    const opened = await session.handles.openProject(await realpath(root)) as { readonly projectHandle: string };
    const methods = new MutationMethods(session);
    const params = { sessionNonce: session.nonce, projectHandle: opened.projectHandle, selection: { kind: "all" } };
    const discarded = await execute(methods, "brand.derive.plan", params);
    expect(discarded).toMatchObject({ method: "brand.derive.plan", expiresInMs: 600_000, summary: { selectedRecipes: ["recipe-derived-dark"], createdCount: 1 } });
    expect(JSON.stringify(discarded)).not.toContain(root);
    expect(await execute(methods, "plan.discard", { sessionNonce: session.nonce, planToken: discarded.planToken })).toEqual({ discarded: true });
    const planned = await execute(methods, "brand.derive.plan", params);
    expect(await execute(methods, "plan.apply", { sessionNonce: session.nonce, planToken: planned.planToken, expectedPlanDigest: planned.planDigest })).toEqual({ applied: true, method: "brand.derive.plan" });
    expect(existsSync(join(root, ".tfsb/assets/fixture-mark-derived-dark.toml"))).toBe(true);
    await session.shutdown();
  });

  it("plans consumer install only from authentic source handles", async () => {
    const producer = await createConsumerBundle(); const consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const session = new StudioSession(); await session.negotiate("1.1");
    const project = await session.handles.openProject(await realpath(consumer)) as { readonly projectHandle: string };
    const source = await session.handles.openSource(await realpath(producer.archive), { purpose: "brand-bundle" }) as { readonly sourceHandle: string };
    const methods = new MutationMethods(session);
    const planned = await execute(methods, "brand.consumer.install.plan", { sessionNonce: session.nonce, projectHandle: project.projectHandle, sourceHandles: [source.sourceHandle], profiles: [PROFILE_ID] });
    expect(planned).toMatchObject({ method: "brand.consumer.install.plan", summary: { operation: "install", profiles: [PROFILE_ID] } });
    expect(JSON.stringify(planned)).not.toContain(producer.archive);
    expect(JSON.stringify(planned)).not.toContain(consumer);
    expect(await execute(methods, "plan.apply", { sessionNonce: session.nonce, planToken: planned.planToken, expectedPlanDigest: planned.planDigest })).toEqual({ applied: true, method: "brand.consumer.install.plan" });
    await expect(session.handles.brandSource(source.sourceHandle)).resolves.toMatchObject({ purpose: "brand-bundle" });

    const synced = await execute(methods, "brand.consumer.sync.plan", { sessionNonce: session.nonce, projectHandle: project.projectHandle, sourceHandles: [source.sourceHandle] });
    expect(synced).toMatchObject({ method: "brand.consumer.sync.plan", summary: { operation: "sync" } });
    expect(JSON.stringify(synced)).not.toContain(producer.archive);
    expect(JSON.stringify(synced)).not.toContain(consumer);
    expect(await execute(methods, "plan.apply", { sessionNonce: session.nonce, planToken: synced.planToken, expectedPlanDigest: synced.planDigest })).toEqual({ applied: true, method: "brand.consumer.sync.plan" });

    await session.shutdown();
  });

  it("does not register raster plans when the qualified capability is unavailable", async () => {
    const root = await createDeriveProject(); roots.push(root);
    const session = new StudioSession(); await session.negotiate("1.1"); session.rasterCapability = { available: false, code: "EXPORT_CAPABILITY_UNAVAILABLE", reason: "test" };
    const opened = await session.handles.openProject(await realpath(root)) as { readonly projectHandle: string };
    const methods = new MutationMethods(session);
    await expect(execute(methods, "brand.qa.baseline.plan", { sessionNonce: session.nonce, projectHandle: opened.projectHandle, profileId: "profile", caseId: "case" })).rejects.toMatchObject({ symbolicCode: "METHOD_CAPABILITY_UNAVAILABLE" });
    await expect(execute(methods, "brand.export.plan", { sessionNonce: session.nonce, projectHandle: opened.projectHandle, profileId: "profile" })).rejects.toMatchObject({ symbolicCode: "METHOD_CAPABILITY_UNAVAILABLE" });
    expect(session.plans.size).toBe(0);
    await session.shutdown();
  });

  it("registers and applies export through the qualified raster planner and executor", async () => {
    const root = await setupRasterProject(roots, { qa: true });
    const descriptor = Object.freeze({
      adapterId: "resvg-png-v1" as const,
      companionPackage: "@knowledge-forge-ai/tfsb-raster-resvg" as const,
      companionVersion: "0.0.0-tfsb47f",
      backend: "wasm" as const,
      rendererPackage: "@resvg/resvg-wasm" as const,
      rendererVersion: "2.6.2",
      rendererBuildDigest: "sha256:22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70" as const,
      nodeMajor: 22,
      platformClaim: "darwin-arm64",
      qualificationId: "sha256:4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11",
    });
    const capability = createRasterCapabilityFromModule({
      descriptor,
      renderSvg: async (request: RasterRenderRequest) => {
        const rgba8 = new Uint8Array(request.width * request.height * 4).fill(255);
        return { width: request.width, height: request.height, rgba8, pngBytes: rgbaPng(request.width, request.height, rgba8), descriptor };
      },
    });
    if (!capability.available) throw new Error("qualified raster test capability is unavailable");
    const seedBaseline = await planBrandQaBaselineUpdate({ root, profileId: "visual", caseId: "golden", renderer: capability.qa, create: { asset: "fixture-mark-on-light", size: [16, 16], background: "transparent" } });
    await executeBrandQaBaselineUpdatePlan(seedBaseline);
    const session = new StudioSession(); await session.negotiate("1.1"); session.rasterCapability = capability;
    const opened = await session.handles.openProject(await realpath(root)) as { readonly projectHandle: string };
    const methods = new MutationMethods(session);
    const planned = await execute(methods, "brand.export.plan", { sessionNonce: session.nonce, projectHandle: opened.projectHandle, profileId: "web-icons" });
    expect(planned).toMatchObject({ method: "brand.export.plan", summary: { profileId: "web-icons", counts: { create: 1 } } });
    expect(await execute(methods, "plan.apply", { sessionNonce: session.nonce, planToken: planned.planToken, expectedPlanDigest: planned.planDigest })).toEqual({ applied: true, method: "brand.export.plan" });
    expect(existsSync(join(root, "public/icon.png"))).toBe(true);
    const baseline = await execute(methods, "brand.qa.baseline.plan", { sessionNonce: session.nonce, projectHandle: opened.projectHandle, profileId: "visual", caseId: "golden" });
    expect(baseline).toMatchObject({ method: "brand.qa.baseline.plan", summary: { profileId: "visual", caseId: "golden", renderer: { rendererBuildDigest: descriptor.rendererBuildDigest } } });
    expect(await execute(methods, "plan.apply", { sessionNonce: session.nonce, planToken: baseline.planToken, expectedPlanDigest: baseline.planDigest })).toEqual({ applied: true, method: "brand.qa.baseline.plan" });
    await session.shutdown();
  });

  it("plans and applies all advertised brand mutations under protocol version 1.2", async () => {
    const deriveRoot = await createDeriveProject(); roots.push(deriveRoot);
    const producer = await createConsumerBundle(); const consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const rasterRoot = await setupRasterProject(roots, { qa: true });
    const descriptor = Object.freeze({
      adapterId: "resvg-png-v1" as const,
      companionPackage: "@knowledge-forge-ai/tfsb-raster-resvg" as const,
      companionVersion: "0.0.0-tfsb47f",
      backend: "wasm" as const,
      rendererPackage: "@resvg/resvg-wasm" as const,
      rendererVersion: "2.6.2",
      rendererBuildDigest: "sha256:22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70" as const,
      nodeMajor: 22,
      platformClaim: "darwin-arm64",
      qualificationId: "sha256:4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11",
    });
    const capability = createRasterCapabilityFromModule({
      descriptor,
      renderSvg: async (request: RasterRenderRequest) => {
        const rgba8 = new Uint8Array(request.width * request.height * 4).fill(255);
        return { width: request.width, height: request.height, rgba8, pngBytes: rgbaPng(request.width, request.height, rgba8), descriptor };
      },
    });
    if (!capability.available) throw new Error("qualified raster test capability is unavailable");
    const seedBaseline = await planBrandQaBaselineUpdate({ root: rasterRoot, profileId: "visual", caseId: "golden", renderer: capability.qa, create: { asset: "fixture-mark-on-light", size: [16, 16], background: "transparent" } });
    await executeBrandQaBaselineUpdatePlan(seedBaseline);

    const session = new StudioSession(); await session.negotiate("1.2"); session.rasterCapability = capability;
    const deriveOpened = await session.handles.openProject(await realpath(deriveRoot)) as { readonly projectHandle: string };
    const consumerProject = await session.handles.openProject(await realpath(consumer)) as { readonly projectHandle: string };
    const consumerSource = await session.handles.openSource(await realpath(producer.archive), { purpose: "brand-bundle" }) as { readonly sourceHandle: string };
    const rasterOpened = await session.handles.openProject(await realpath(rasterRoot)) as { readonly projectHandle: string };
    const methods = new MutationMethods(session);

    // 1. brand.derive.plan
    const derivePlan = await execute(methods, "brand.derive.plan", { sessionNonce: session.nonce, projectHandle: deriveOpened.projectHandle, selection: { kind: "all" } });
    expect(derivePlan).toMatchObject({ method: "brand.derive.plan", summary: { selectedRecipes: ["recipe-derived-dark"], createdCount: 1 } });
    expect(await execute(methods, "plan.apply", { sessionNonce: session.nonce, planToken: derivePlan.planToken, expectedPlanDigest: derivePlan.planDigest })).toEqual({ applied: true, method: "brand.derive.plan" });

    // 2. brand.consumer.install.plan
    const installPlan = await execute(methods, "brand.consumer.install.plan", { sessionNonce: session.nonce, projectHandle: consumerProject.projectHandle, sourceHandles: [consumerSource.sourceHandle], profiles: [PROFILE_ID] });
    expect(installPlan).toMatchObject({ method: "brand.consumer.install.plan", summary: { operation: "install", profiles: [PROFILE_ID] } });
    expect(await execute(methods, "plan.apply", { sessionNonce: session.nonce, planToken: installPlan.planToken, expectedPlanDigest: installPlan.planDigest })).toEqual({ applied: true, method: "brand.consumer.install.plan" });

    // 3. brand.consumer.sync.plan
    const syncPlan = await execute(methods, "brand.consumer.sync.plan", { sessionNonce: session.nonce, projectHandle: consumerProject.projectHandle, sourceHandles: [consumerSource.sourceHandle] });
    expect(syncPlan).toMatchObject({ method: "brand.consumer.sync.plan", summary: { operation: "sync" } });
    expect(await execute(methods, "plan.apply", { sessionNonce: session.nonce, planToken: syncPlan.planToken, expectedPlanDigest: syncPlan.planDigest })).toEqual({ applied: true, method: "brand.consumer.sync.plan" });

    // 4. brand.qa.baseline.plan
    const baselinePlan = await execute(methods, "brand.qa.baseline.plan", { sessionNonce: session.nonce, projectHandle: rasterOpened.projectHandle, profileId: "visual", caseId: "golden" });
    expect(baselinePlan).toMatchObject({ method: "brand.qa.baseline.plan", summary: { profileId: "visual", caseId: "golden" } });
    expect(await execute(methods, "plan.apply", { sessionNonce: session.nonce, planToken: baselinePlan.planToken, expectedPlanDigest: baselinePlan.planDigest })).toEqual({ applied: true, method: "brand.qa.baseline.plan" });

    // 5. brand.export.plan
    const exportPlan = await execute(methods, "brand.export.plan", { sessionNonce: session.nonce, projectHandle: rasterOpened.projectHandle, profileId: "web-icons" });
    expect(exportPlan).toMatchObject({ method: "brand.export.plan", summary: { profileId: "web-icons", counts: { create: 1 } } });
    expect(await execute(methods, "plan.apply", { sessionNonce: session.nonce, planToken: exportPlan.planToken, expectedPlanDigest: exportPlan.planDigest })).toEqual({ applied: true, method: "brand.export.plan" });

    await session.shutdown();
  });
});
