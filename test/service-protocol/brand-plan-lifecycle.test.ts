import { realpath, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { MutationMethods } from "../../src/service-protocol/mutation-methods.js";
import { StudioSession } from "../../src/service-protocol/session.js";
import { createDeriveProject } from "./brand-test-helper.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("Studio brand plan lifecycle", () => {
  it("does not consume on digest mismatch, consumes after apply, and disposes on shutdown", async () => {
    const root = await createDeriveProject(); roots.push(root);
    const session = new StudioSession(); await session.negotiate("1.1");
    const project = await session.handles.openProject(await realpath(root)) as { readonly projectHandle: string };
    const methods = new MutationMethods(session); const signal = new AbortController().signal; const progress = () => undefined;
    const planned = await methods.execute("brand.derive.plan", { sessionNonce: session.nonce, projectHandle: project.projectHandle, selection: { kind: "all" } }, signal, "plan", progress) as any;
    await expect(methods.execute("plan.apply", { sessionNonce: session.nonce, planToken: planned.planToken, expectedPlanDigest: `sha256:${"f".repeat(64)}` }, signal, "bad", progress)).rejects.toMatchObject({ symbolicCode: "PLAN_DIGEST_MISMATCH" });
    expect(session.plans.size).toBe(1);
    await expect(methods.execute("plan.apply", { sessionNonce: session.nonce, planToken: planned.planToken, expectedPlanDigest: planned.planDigest }, signal, "apply", progress)).resolves.toEqual({ applied: true, method: "brand.derive.plan" });
    expect(session.plans.size).toBe(0);
    await expect(methods.execute("plan.apply", { sessionNonce: session.nonce, planToken: planned.planToken, expectedPlanDigest: planned.planDigest }, signal, "replay", progress)).rejects.toMatchObject({ symbolicCode: "PLAN_TOKEN_INVALID" });
    const unused = await methods.execute("brand.derive.plan", { sessionNonce: session.nonce, projectHandle: project.projectHandle, selection: { kind: "all" } }, signal, "unused", progress) as any;
    expect(unused.planToken).toHaveLength(43); expect(session.plans.size).toBe(1);
    await session.shutdown();
    expect(session.plans.size).toBe(0); expect(session.authorityLedger.retainedBytes).toBe(0);
  });
});
