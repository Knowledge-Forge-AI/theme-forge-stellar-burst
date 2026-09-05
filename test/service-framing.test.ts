import { describe, expect, it } from "vitest";

import { FramingError, NdjsonFramer, encodeFrame } from "../src/service-protocol/framing.js";
import { MAX_FRAME_BYTES } from "../src/service-protocol/v1-registry.js";

function code(action: () => unknown): string | undefined {
  try { action(); return undefined; }
  catch (error) { return error instanceof FramingError ? error.symbolicCode : "unexpected"; }
}

describe("studio NDJSON framing", () => {
  it("handles arbitrary chunks, multiple records, and a split UTF-8 scalar", () => {
    const framer = new NdjsonFramer();
    const first = Buffer.from('{"value":"stellar 🌟"}\n{"value":2}\n');
    const split = first.indexOf(Buffer.from("🌟")) + 2;
    expect(framer.push(first.subarray(0, split))).toEqual([]);
    expect(framer.push(first.subarray(split))).toEqual([{ value: "stellar 🌟" }, { value: 2 }]);
    expect(() => framer.end()).not.toThrow();
  });

  it.each([
    [Buffer.from("\n"), "INVALID_REQUEST"],
    [Buffer.from("{}\r\n"), "INVALID_REQUEST"],
    [Buffer.from("{}\r"), undefined],
    [Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a]), "INVALID_REQUEST"],
    [Buffer.from("[]\n"), "INVALID_REQUEST"],
    [Buffer.from("{nope}\n"), "PARSE_ERROR"],
    [Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a]), "PARSE_ERROR"],
  ] as const)("rejects malformed record %#", (bytes, expected) => {
    const framer = new NdjsonFramer();
    expect(code(() => framer.push(bytes))).toBe(expected);
    if (expected === undefined) expect(code(() => framer.end())).toBe("INVALID_REQUEST");
  });

  it("accepts the exact byte boundary and rejects one byte over before newline allocation", () => {
    const overhead = Buffer.byteLength('{"x":""}', "utf8");
    const frame = Buffer.from(`{"x":"${"a".repeat(MAX_FRAME_BYTES - 1 - overhead)}"}\n`);
    expect(frame.byteLength).toBe(MAX_FRAME_BYTES);
    expect((new NdjsonFramer().push(frame)[0] as { x: string }).x.length).toBe(MAX_FRAME_BYTES - 1 - overhead);
    const over = Buffer.alloc(MAX_FRAME_BYTES, 0x20);
    expect(code(() => new NdjsonFramer().push(over))).toBe("MESSAGE_TOO_LARGE");
  });

  it("enforces the outbound limit without truncation", () => {
    expect(encodeFrame({ ok: true }).toString("utf8")).toBe('{"ok":true}\n');
    expect(code(() => encodeFrame({ value: "x".repeat(MAX_FRAME_BYTES) }))).toBe("MESSAGE_TOO_LARGE");
  });
});
