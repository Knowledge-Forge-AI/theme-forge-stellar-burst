import { describe, expect, it } from "vitest";

import {
  AuthorityLedger,
  PLAN_METADATA_CHARGE_BYTES,
  planRetentionCharge,
} from "../src/service-protocol/authority-ledger.js";
import { computePlanDigest, type PlanDigestEnvelope } from "../src/service-protocol/canonical-json.js";
import { ProtocolError } from "../src/service-protocol/errors.js";
import { PlanRegistry, type PlanApplyRequest } from "../src/service-protocol/plan-registry.js";

function code(error: unknown): string | undefined {
  return (error as { symbolicCode?: string }).symbolicCode;
}

function digestFor(name: string): string {
  const envelope: PlanDigestEnvelope = {
    authority: { name }, handles: { project: "sha256:project" }, method: "project.fmt.plan",
    preState: { project: "sha256:before" }, protocol: "tfsb.studio", protocolVersion: "1.0", summary: { changed: true },
  };
  return computePlanDigest(envelope);
}

function request(token: string, digest: string, sessionNonce = "session-a"): PlanApplyRequest {
  return {
    sessionNonce,
    planToken: token,
    expectedPlanDigest: digest,
    bindings: { method: "project.fmt.plan", root: "sha256:root", source: null, auxiliary: [] },
  };
}

describe("shared authority-byte ledger", () => {
  it("counts explicit byte-array and string occurrences plus summary and metadata", () => {
    const charge = planRetentionCharge({
      byteArrays: [new Uint8Array(3), new Uint8Array(2)],
      strings: ["é", "a"],
      summary: { ok: true },
    });
    expect(charge).toBe(PLAN_METADATA_CHARGE_BYTES + 5 + 3 + Buffer.byteLength('{"ok":true}', "utf8"));
  });

  it("shares aggregate bytes and releases each lease idempotently", () => {
    const ledger = new AuthorityLedger({ maxRetainedBytes: 10, maxRetainedNativeSnapshotPlans: 1 });
    const handle = ledger.reserveHandle(7);
    expect(ledger.retainedBytes).toBe(7);
    expect(() => ledger.reservePlan(4)).toThrow(/REQUEST_BUSY|busy/i);
    const plan = ledger.reservePlan(3);
    expect(ledger.retainedBytes).toBe(10);
    plan.release(); plan.release();
    expect(ledger.retainedBytes).toBe(7);
    handle.release();
    expect(ledger.retainedBytes).toBe(0);
  });

  it("enforces one native snapshot reservation", () => {
    const ledger = new AuthorityLedger({ maxRetainedBytes: 20, maxRetainedNativeSnapshotPlans: 1 });
    const first = ledger.reservePlan(1, true);
    expect(() => ledger.reservePlan(1, true)).toThrow(/REQUEST_BUSY|busy/i);
    first.release();
    expect(() => ledger.reservePlan(1, true)).not.toThrow();
  });
});

describe("private Studio plan registry", () => {
  it("generates 32-byte base64url tokens and advertises exact limits", () => {
    const registry = new PlanRegistry({ sessionNonce: "session-a", clock: () => 0 });
    const digest = digestFor("token-shape");
    const result = registry.register({
      method: "project.fmt.plan", plan: { authentic: true }, summary: { changed: true }, digest,
      bindings: { sessionNonce: "session-a", method: "project.fmt.plan", root: "sha256:root" }, retainedPlanBytes: 1,
    });
    expect(result.planToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.planDigest).toBe(digest);
    expect(result.expiresInMs).toBe(600_000);
    expect(registry.limits).toEqual({
      maxActivePlans: 4, maxRetainedPlanBytes: 201_326_592,
      maxRetainedNativeSnapshotPlans: 1, planTtlMs: 600_000, maxConcurrentApplies: 1,
    });
  });

  it("disposes rejected plans at the four-plan boundary", () => {
    const registry = new PlanRegistry({ clock: () => 0 });
    let disposed = 0;
    for (let index = 0; index < 4; index += 1) {
      registry.register({ method: "project.fmt.plan", plan: index, summary: { index }, digest: digestFor(String(index)), retainedPlanBytes: 1, dispose: () => { disposed += 1; } });
    }
    expect(() => registry.register({ method: "project.fmt.plan", plan: 4, summary: { index: 4 }, digest: digestFor("4"), retainedPlanBytes: 1, dispose: () => { disposed += 1; } })).toThrow(/REQUEST_BUSY|busy/i);
    expect(registry.activePlanCount).toBe(4);
    expect(disposed).toBe(1);
  });

  it("applies the aggregate byte and native boundaries before insertion", () => {
    const ledger = new AuthorityLedger({ maxRetainedBytes: 5, maxRetainedNativeSnapshotPlans: 1 });
    const registry = new PlanRegistry({ ledger, clock: () => 0 });
    const digest = digestFor("bytes");
    let disposed = 0;
    registry.register({ method: "project.fmt.plan", plan: {}, summary: {}, digest, retainedPlanBytes: 5, dispose: () => { disposed += 1; } });
    expect(() => registry.register({ method: "project.fmt.plan", plan: {}, summary: {}, digest, retainedPlanBytes: 1, dispose: () => { disposed += 1; } })).toThrow(/REQUEST_BUSY|busy/i);
    expect(disposed).toBe(1);
    expect(registry.size).toBe(1);
  });

  it("uses the exact 192-MiB and one-native-plan defaults", () => {
    const registry = new PlanRegistry({ clock: () => 0 });
    const digest = digestFor("exact-limit");
    const first = registry.register({ method: "project.fmt.plan", plan: {}, summary: {}, digest, retainedPlanBytes: 201_326_592 });
    expect(() => registry.register({ method: "project.fmt.plan", plan: {}, summary: {}, digest, retainedPlanBytes: 1 })).toThrow(/REQUEST_BUSY|busy/i);
    registry.discard({ sessionNonce: "anything", planToken: first.planToken });

    const native = new PlanRegistry({ clock: () => 0 });
    native.register({ method: "project.fmt.plan", plan: {}, summary: {}, digest, retainedPlanBytes: 1, nativeSnapshot: true });
    expect(() => native.register({ method: "project.fmt.plan", plan: {}, summary: {}, digest, retainedPlanBytes: 1, nativeSnapshot: true })).toThrow(/REQUEST_BUSY|busy/i);
  });

  it("expires at age equality and disposes exactly once", () => {
    let now = 0; let disposed = 0;
    const registry = new PlanRegistry({ sessionNonce: "session-a", clock: () => now });
    const digest = digestFor("expiry");
    const result = registry.register({ method: "project.fmt.plan", plan: {}, summary: {}, digest, retainedPlanBytes: 1, dispose: () => { disposed += 1; } });
    now = 600_000;
    expect(() => registry.discard({ sessionNonce: "session-a", planToken: result.planToken })).toThrow(/PLAN_TOKEN_INVALID|invalid/i);
    expect(disposed).toBe(1);
    expect(registry.size).toBe(0);
    expect(() => registry.discard({ sessionNonce: "session-a", planToken: result.planToken })).toThrow(/PLAN_TOKEN_INVALID|invalid/i);
    expect(disposed).toBe(1);
  });

  it("does not consume a valid token on binding or digest mismatch", async () => {
    const registry = new PlanRegistry({ sessionNonce: "session-a", clock: () => 0 });
    let disposed = 0;
    const digest = digestFor("auth");
    const result = registry.register({
      method: "project.fmt.plan", plan: { value: 1 }, summary: {}, digest,
      bindings: { sessionNonce: "session-a", method: "project.fmt.plan", root: "sha256:root", source: null, auxiliary: [] },
      retainedPlanBytes: 1, dispose: () => { disposed += 1; },
    });
    await expect(registry.apply({ ...request(result.planToken, digest), expectedPlanDigest: digestFor("wrong") }, async () => undefined)).rejects.toSatisfy((error: unknown) => code(error) === "PLAN_DIGEST_MISMATCH");
    await expect(registry.apply({ ...request(result.planToken, digest), bindings: { method: "project.fmt.plan", root: "sha256:other", source: null, auxiliary: [] } }, async () => undefined)).rejects.toSatisfy((error: unknown) => code(error) === "PLAN_TOKEN_INVALID");
    expect(disposed).toBe(0);
    await expect(registry.apply<number, { readonly value: number }, unknown>(request(result.planToken, digest), async (plan) => plan.value)).resolves.toBe(1);
    expect(disposed).toBe(1);
    await expect(registry.apply(request(result.planToken, digest), async () => undefined)).rejects.toSatisfy((error: unknown) => code(error) === "PLAN_TOKEN_INVALID");
  });

  it("dispatches the private executor stored with the authentic record", async () => {
    const registry = new PlanRegistry({ sessionNonce: "session-a", clock: () => 0 });
    const digest = digestFor("private-dispatch");
    const result = registry.register({
      method: "project.fmt.plan", plan: { value: 7 }, summary: {}, digest, retainedPlanBytes: 1,
      executor: async (plan) => plan.value,
    });
    await expect(registry.apply({ sessionNonce: "session-a", planToken: result.planToken, expectedPlanDigest: digest })).resolves.toBe(7);
  });

  it("returns busy before token lookup while the one apply lane is occupied", async () => {
    const registry = new PlanRegistry({ sessionNonce: "session-a", clock: () => 0 });
    const digest = digestFor("lane");
    const result = registry.register({ method: "project.fmt.plan", plan: {}, summary: {}, digest, retainedPlanBytes: 1, bindings: { method: "project.fmt.plan", root: "sha256:root", source: null, auxiliary: [] } });
    let finish!: () => void;
    const running = registry.apply(request(result.planToken, digest), async () => new Promise<void>((resolve) => { finish = resolve; }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(registry.applying).toBe(true);
    await expect(registry.apply({ ...request("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", digest) }, async () => undefined)).rejects.toSatisfy((error: unknown) => code(error) === "REQUEST_BUSY");
    finish();
    await running;
  });

  it("consumes a token when cancellation arrives after authentication", async () => {
    const registry = new PlanRegistry({ sessionNonce: "session-a", clock: () => 0 });
    const digest = digestFor("cancel");
    let disposed = 0;
    const result = registry.register({
      method: "project.fmt.plan", plan: {}, summary: {}, digest, retainedPlanBytes: 1,
      bindings: { sessionNonce: "session-a", method: "project.fmt.plan", root: "sha256:root", source: null, auxiliary: [] },
      dispose: () => { disposed += 1; },
    });
    const controller = new AbortController();
    let authenticatedExecutorEntered = false;
    await expect(registry.apply({ ...request(result.planToken, digest), signal: controller.signal }, async () => {
      authenticatedExecutorEntered = true;
      controller.abort();
      throw new ProtocolError("REQUEST_CANCELLED");
    })).rejects.toSatisfy((error: unknown) => code(error) === "REQUEST_CANCELLED");
    expect(authenticatedExecutorEntered).toBe(true);
    expect(disposed).toBe(1);
    await expect(registry.apply(request(result.planToken, digest), async () => undefined)).rejects.toSatisfy((error: unknown) => code(error) === "PLAN_TOKEN_INVALID");
  });

  it("disposes unused plans on shutdown", async () => {
    const registry = new PlanRegistry({ sessionNonce: "session-a", clock: () => 0 });
    const digest = digestFor("shutdown");
    let disposed = 0;
    registry.register({ method: "project.fmt.plan", plan: {}, summary: {}, digest: digestFor("shutdown"), retainedPlanBytes: 1, dispose: () => { disposed += 1; } });
    await registry.shutdown();
    expect(disposed).toBe(1);
    expect(registry.closed).toBe(true);
    expect(() => registry.register({ method: "project.fmt.plan", plan: {}, summary: {}, digest, retainedPlanBytes: 1 })).toThrow(/SESSION_NOT_INITIALIZED|handshake/i);
  });
});
