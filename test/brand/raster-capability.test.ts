import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { assertRasterSvgIsSelfContained, createRasterCapabilityFromModule, decodeStrictPng } from "../../src/brand/raster-capability.js";

const table = (() => { const values = new Uint32Array(256); for (let n = 0; n < 256; n++) { let value = n; for (let k = 0; k < 8; k++) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; values[n] = value >>> 0; } return values; })();
function crc(bytes: Uint8Array): number { let value = 0xffffffff; for (const byte of bytes) value = table[(value ^ byte) & 0xff]! ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array): Uint8Array { const result = new Uint8Array(data.length + 12), view = new DataView(result.buffer); view.setUint32(0, data.length); result.set(Buffer.from(type), 4); result.set(data, 8); view.setUint32(8 + data.length, crc(result.subarray(4, 8 + data.length))); return result; }
function png(filter = 0): Uint8Array {
  const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), ihdr = new Uint8Array(13), view = new DataView(ihdr.buffer); view.setUint32(0, 1); view.setUint32(4, 1); ihdr[8] = 8; ihdr[9] = 6;
  const chunks = [signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Uint8Array.of(filter, 1, 2, 3, 255))), chunk("IEND", new Uint8Array())]; const size = chunks.reduce((sum, item) => sum + item.length, 0), result = new Uint8Array(size); let offset = 0; for (const item of chunks) { result.set(item, offset); offset += item.length; } return result;
}

describe("strict raster capability boundary", () => {
  it.each([0, 1, 2, 3, 4])("decodes PNG filter %i to straight RGBA8", (filter) => {
    const decoded = decodeStrictPng(png(filter), 1, 1);
    expect([...decoded.rgba8]).toEqual([1, 2, 3, 255]);
    expect(decoded.chunkTypes).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("rejects CRC changes, trailing data, wrong dimensions, and ancillary metadata", () => {
    const corrupted = png(); corrupted[corrupted.length - 5] = corrupted[corrupted.length - 5]! ^ 1;
    expect(() => decodeStrictPng(corrupted)).toThrow();
    expect(() => decodeStrictPng(Uint8Array.from([...png(), 0]))).toThrow();
    expect(() => decodeStrictPng(png(), 2, 1)).toThrow();
    const base = png(), metadata = chunk("tEXt", Buffer.from("x\0y"));
    const injected = Uint8Array.from([...base.subarray(0, base.length - 12), ...metadata, ...base.subarray(base.length - 12)]);
    expect(() => decodeStrictPng(injected)).toThrow(/ancillary/);
  });

  it.each(["<image href=\"x.png\"/>", "<text>x</text>", "<style>rect{fill:red}</style>", "<use href=\"other.svg#x\"/>"])("rejects forbidden SVG authority %s", (body) => {
    expect(() => assertRasterSvgIsSelfContained(Buffer.from(`<svg xmlns=\"http://www.w3.org/2000/svg\">${body}</svg>`))).toThrow();
  });

  it("keeps capability unavailable for incompatible module shapes", () => {
    expect(createRasterCapabilityFromModule({ arbitrary: () => undefined })).toEqual({ available: false, code: "EXPORT_CAPABILITY_UNAVAILABLE", reason: "Companion module export shape is incompatible." });
  });
});
