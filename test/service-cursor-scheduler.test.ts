import { describe, expect, it } from "vitest";

import { CursorCodec, type CursorScope } from "../src/service-protocol/cursor.js";
import { ProtocolError } from "../src/service-protocol/errors.js";
import { ReadScheduler } from "../src/service-protocol/session.js";

const scope: CursorScope = { method: "asset.list", kind: "project", handle: "project_example" };
const payload = {
  protocolVersion: "1.0" as const,
  scope,
  viewDigest: `sha256:${"a".repeat(64)}`,
  lastKey: { projectId: "project", kind: "asset" as const, id: "asset-064" },
  pageSize: 64,
};

function symbolic(action: () => unknown): string | undefined {
  try { action(); return undefined; }
  catch (error) { return error instanceof ProtocolError ? error.symbolicCode : "unexpected"; }
}

describe("studio authenticated cursors", () => {
  it("authenticates session, scope, structured boundary, and canonical encoding", () => {
    const codec = new CursorCodec(Buffer.alloc(32, 1));
    const cursor = codec.encode(payload);
    expect(codec.decode(cursor, scope, 64)).toEqual(payload);
    expect(symbolic(() => new CursorCodec(Buffer.alloc(32, 2)).decode(cursor, scope, 64))).toBe("CURSOR_INVALID");
    expect(symbolic(() => codec.decode(cursor, { ...scope, handle: "project_other" }, 64))).toBe("CURSOR_INVALID");
    expect(symbolic(() => codec.decode(`${cursor.slice(0, -1)}x`, scope, 64))).toBe("CURSOR_INVALID");
    expect(symbolic(() => codec.decode(cursor.slice(0, -3), scope, 64))).toBe("CURSOR_INVALID");
    expect(symbolic(() => codec.decode(cursor, scope, 65))).toBe("CURSOR_INVALID");
    const opaqueBytes = Buffer.from(cursor, "base64url").toString("utf8");
    expect(opaqueBytes).not.toContain("/tmp/");
    expect(opaqueBytes).not.toContain("asset-064");
    codec.destroy();
    expect(symbolic(() => codec.decode(cursor, scope, 64))).toBe("CURSOR_INVALID");
  });
});

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

describe("studio bounded read scheduler", () => {
  it("runs four independent reads and rejects a fifth", async () => {
    const scheduler = new ReadScheduler();
    const gates = Array.from({ length: 4 }, deferred);
    const reads = gates.map((gate, index) => scheduler.submit(`id-${index}`, `lane-${index}`, async () => gate.promise));
    await expect(scheduler.submit("id-5", "lane-5", async () => undefined)).rejects.toMatchObject({ symbolicCode: "REQUEST_BUSY" });
    gates.forEach((gate) => gate.resolve());
    await Promise.all(reads);
    expect(scheduler.size).toBe(0);
  });

  it("serializes same-lane work FIFO, rejects duplicate active IDs, and cancels queued work", async () => {
    const scheduler = new ReadScheduler(); const gate = deferred(); const order: string[] = [];
    const first = scheduler.submit("same", "project:one", async () => { order.push("first-start"); await gate.promise; order.push("first-end"); });
    await expect(scheduler.submit("same", "project:two", async () => undefined)).rejects.toMatchObject({ symbolicCode: "INVALID_REQUEST_ID" });
    const second = scheduler.submit("second", "project:one", async () => { order.push("second"); });
    const cancelled = scheduler.submit("cancelled", "project:one", async () => { order.push("cancelled-ran"); });
    scheduler.cancel("cancelled");
    await expect(cancelled).rejects.toMatchObject({ symbolicCode: "REQUEST_CANCELLED" });
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
    await expect(scheduler.submit("same", "project:three", async () => "reused")).resolves.toBe("reused");
  });
});
