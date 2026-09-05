import { describe, expect, it } from "vitest";

import { CursorCodec, type CursorScope } from "../../src/service-protocol/cursor.js";

const digest = `sha256:${"0".repeat(64)}`;

describe("Studio brand cursors", () => {
  it("binds version, method, project, page size, and authenticated payload", () => {
    const codec = new CursorCodec(Buffer.alloc(32, 7));
    const scope: CursorScope = { method: "brand.family.list", kind: "project", handle: "project_a" };
    const cursor = codec.encode({ protocolVersion: "1.1", scope, viewDigest: digest, lastKey: { projectId: "project", kind: "brand", id: "family-a" }, pageSize: 64 });
    expect(codec.decode(cursor, scope, 64, "1.1")).toMatchObject({ protocolVersion: "1.1", viewDigest: digest });
    expect(() => codec.decode(cursor, scope, 64, "1.0")).toThrow();
    expect(() => codec.decode(cursor, { ...scope, method: "brand.token.list" }, 64, "1.1")).toThrow();
    expect(() => codec.decode(cursor, { ...scope, handle: "project_b" }, 64, "1.1")).toThrow();
    expect(() => codec.decode(cursor, scope, 32, "1.1")).toThrow();
    expect(() => codec.decode(`${cursor.slice(0, -1)}A`, scope, 64, "1.1")).toThrow();
    codec.destroy(); expect(() => codec.decode(cursor, scope, 64, "1.1")).toThrow();
  });

  it("encodes view digest faithfully so staleness can be detected by consumers", () => {
    const codec = new CursorCodec(Buffer.alloc(32, 7));
    const scope: CursorScope = { method: "brand.family.list", kind: "project", handle: "project_a" };
    const cursor = codec.encode({ protocolVersion: "1.1", scope, viewDigest: digest, lastKey: { projectId: "project", kind: "brand", id: "family-a" }, pageSize: 64 });
    const decoded = codec.decode(cursor, scope, 64, "1.1");
    expect(decoded.viewDigest).toBe(digest);
    const staleDigest = `sha256:${"1".repeat(64)}`;
    expect(decoded.viewDigest === staleDigest).toBe(false);
  });
});

