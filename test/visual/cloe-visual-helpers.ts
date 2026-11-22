import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";

export async function loadCloeReference(page: Page) {
  const reference = await readFile(new URL("./fixtures/cloe-research-studio.webp", import.meta.url));
  expect(createHash("sha256").update(reference).digest("hex"))
    .toBe("fbd4ff85614e9eeaa145fbc954929b0bc14f1b6c8c4efbf22a4c1991f317f78c");
  await page.route("http://cloe.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Cloe visual fixture</title>" }));
  await page.route("http://cloe.test/reference.webp", (route) =>
    route.fulfill({ contentType: "image/webp", body: reference }));
  await page.goto("http://cloe.test/");
}

export async function render(page: Page, path: string, width: number, height: number) {
  const encoded = await page.evaluate(async ({ path, width, height }) => {
    const image = new Image();
    image.src = path;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    let binary = "";
    for (let offset = 0; offset < pixels.length; offset += 8192) {
      binary += String.fromCharCode(...pixels.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }, { path, width, height });
  return Buffer.from(encoded, "base64");
}

type Region = readonly [number, number, number, number];
export function compare(reference: Uint8Array, candidate: Uint8Array, width: number, height: number, region: Region) {
  const [left, top, right, bottom] = region.map((n, i) => Math.floor(n * (i % 2 === 0 ? width : height)));
  let absolute = 0, severe = 0, total = 0;
  for (let y = top!; y < bottom!; y += 1) {
    for (let x = left!; x < right!; x += 1) {
      const offset = (y * width + x) * 4;
      const delta = [0, 1, 2].map((c) => Math.abs(reference[offset + c]! - candidate[offset + c]!));
      absolute += (delta[0]! + delta[1]! + delta[2]!) / 3;
      if (Math.max(...delta) > 48) severe += 1;
      total += 1;
    }
  }
  return { mean: absolute / total, severe: severe / total };
}

export function compareCloe(reference: Uint8Array, candidate: Uint8Array, width: number, height: number) {
  return {
    full: compare(reference, candidate, width, height, [0, 0, 1, 1]),
    face: compare(reference, candidate, width, height, [0.33, 0.045, 0.64, 0.225]),
    tablet: compare(reference, candidate, width, height, [0.64, 0.20, 0.83, 0.34]),
  };
}
