import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { descriptor, renderSvg } from "../index.js";
import { createRasterCapabilityFromModule, decodeStrictPng } from "../../../src/brand/raster-capability.js";

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4" viewBox="0 0 8 4"><rect width="8" height="4" fill="#336699"/></svg>');
const request = Object.freeze({ canonicalSvgBytes: svg, width: 16, height: 16, backgroundRgba: null, alpha: "straight", fit: "contain-pad", colorSpace: "srgb" });
/** @param {Uint8Array} bytes */
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

describe("fixed resvg WASM adapter", () => {
  it("binds the reviewed local tuple", () => {
    expect(descriptor).toMatchObject({ adapterId: "resvg-png-v1", backend: "wasm", rendererPackage: "@resvg/resvg-wasm", rendererVersion: "2.6.2", rendererBuildDigest: "sha256:22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70", nodeMajor: 22, platformClaim: `${process.platform}-${process.arch}`.replace("linux-x64", "linux-x64-gnu").replace("win32-x64", "windows-x64"), qualificationId: "sha256:4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11" });
  });

  it("renders exact contain-pad dimensions deterministically", async () => {
    const first = await renderSvg(request), second = await renderSvg(request);
    expect([first.width, first.height, first.rgba8.length]).toEqual([16, 16, 1024]);
    expect(sha(first.pngBytes)).toBe(sha(second.pngBytes));
    expect(sha(first.rgba8)).toBe(sha(second.rgba8));
    expect(first.rgba8.slice(0, 4)).toEqual(Uint8Array.of(0, 0, 0, 0));
    expect(first.rgba8.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)).toEqual(Uint8Array.of(51, 102, 153, 255));
  });

  it("returns straight RGBA bytes that exactly match the PNG for partial alpha", async () => {
    const capability = createRasterCapabilityFromModule({ descriptor, renderSvg });
    if (!capability.available) throw new Error(capability.reason);
    const partial = Object.freeze({ ...request, canonicalSvgBytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#336699" fill-opacity="0.5"/></svg>'), width: 1, height: 1 });
    const rendered = await capability.adapter.renderSvg(partial);
    const decoded = decodeStrictPng(rendered.pngBytes, 1, 1);
    expect(rendered.rgba8).toEqual(decoded.rgba8);
    expect(rendered.rgba8).toEqual(Uint8Array.of(52, 102, 153, 128));
  });

  it("rejects unresolved images and unqualified authority", async () => {
    const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><image href="x.png" width="8" height="8"/></svg>');
    await expect(renderSvg({ ...request, canonicalSvgBytes: image })).rejects.toThrow(/image/);
  });
});
