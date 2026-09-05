import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { StudioServer } from "../src/service-protocol/server.js";
import { ValidationError, validateJsonRpcId, validateResult } from "../src/service-protocol/v1-validate.js";

describe("studio session privacy and result validation", () => {
  it("sanitizes unexpected input errors containing paths, secrets, and stacks", async () => {
    const input = new PassThrough(); const output = new PassThrough(); const error = new PassThrough();
    let stdout = ""; let stderr = ""; output.on("data", (chunk) => { stdout += chunk.toString("utf8"); }); error.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    new StudioServer({ input, output, error }).start();
    const raw = new Error("/tmp/private-root FAKE_SECRET"); raw.stack = "FAKE_STACK /tmp/private-root FAKE_SECRET";
    input.destroy(raw); await new Promise((resolve) => setImmediate(resolve));
    expect(stdout).not.toContain("/tmp/"); expect(stdout).not.toContain("FAKE_SECRET"); expect(stdout).not.toContain("FAKE_STACK");
    expect(stderr).not.toContain("/tmp/"); expect(stderr).not.toContain("FAKE_SECRET"); expect(stderr).not.toContain("FAKE_STACK");
    expect(stderr).toContain('"event":"input-error"');
  });

  it("rejects negative zero IDs because JSON serialization cannot echo them exactly", () => {
    expect(() => validateJsonRpcId(-0)).toThrow(ValidationError);
    expect(validateJsonRpcId(0)).toBe(0);
  });

  it("closes generated result DTOs against unknown fields", () => {
    expect(() => validateResult("preview.status", { status: "absent", outputIdentity: ".tfsb-preview", markerDigest: null })).not.toThrow();
    expect(() => validateResult("preview.status", { status: "absent", outputIdentity: ".tfsb-preview", markerDigest: null, path: "/tmp/injected" })).toThrow(ValidationError);
    expect(() => validateResult("shutdown", {})).toThrow(ValidationError);
  });
});
