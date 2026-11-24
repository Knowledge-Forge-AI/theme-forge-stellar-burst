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
  return reference;
}

export async function loadOrihimeReference(page: Page) {
  const reference = await readFile(new URL("../../website/orihime.webp", import.meta.url));
  expect(createHash("sha256").update(reference).digest("hex"))
    .toBe("7fa33afd77cd87ddc0240a25eea2ff1464911fe7ac4ff5068b49ca9bea11fc66");
  await page.route("http://orihime.test/", route => route.fulfill({
    contentType: "text/html", body: "<!doctype html><title>Orihime illustration fixture</title>",
  }));
  await page.route("http://orihime.test/reference.webp", route => route.fulfill({
    contentType: "image/webp", body: reference,
  }));
  await page.goto("http://orihime.test/");
}

export const orihimeRegions = {
  full: [0, 0, 1, 1],
  face: [0.432, 0.106, 0.575, 0.226],
  prop: [0.196, 0.194, 0.385, 0.278],
} as const;

export function alphaMeanError(reference: Uint8Array, candidate: Uint8Array) {
  expect(candidate.byteLength).toBe(reference.byteLength);
  let total = 0;
  for (let index = 3; index < reference.length; index += 4) {
    total += Math.abs(reference[index]! - candidate[index]!);
  }
  return total * 4 / reference.byteLength;
}

export async function render(page: Page, path: string, width: number, height: number, background: string | null = "#ffffff") {
  const encoded = await page.evaluate(async ({ path, width, height, background }) => {
    // Each fixture URL serves one immutable image for the life of this page.
    // Reuse the decoded image while still painting a new canvas for each size.
    const host = window as Window & { illustrationFixtureImages?: Map<string, HTMLImageElement> };
    const images = host.illustrationFixtureImages ??= new Map();
    let image = images.get(path);
    if (image === undefined) {
      image = new Image();
      image.src = path;
      await image.decode();
      images.set(path, image);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    if (background !== null) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(image, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    let binary = "";
    for (let offset = 0; offset < pixels.length; offset += 8192) {
      binary += String.fromCharCode(...pixels.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }, { path, width, height, background });
  return Buffer.from(encoded, "base64");
}

type Region = readonly [number, number, number, number];
export function compare(reference: Uint8Array, candidate: Uint8Array, width: number, height: number, region: Region) {
  const [left, top, right, bottom] = region.map((n, i) => Math.floor(n * (i % 2 === 0 ? width : height)));
  let absolute = 0, severe = 0, total = 0;
  for (let y = top!; y < bottom!; y += 1) {
    for (let x = left!; x < right!; x += 1) {
      const offset = (y * width + x) * 4;
      const red = Math.abs(reference[offset]! - candidate[offset]!);
      const green = Math.abs(reference[offset + 1]! - candidate[offset + 1]!);
      const blue = Math.abs(reference[offset + 2]! - candidate[offset + 2]!);
      absolute += (red + green + blue) / 3;
      if (Math.max(red, green, blue) > 48) severe += 1;
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

export function cloeFaceContourBounds(width: number) {
  const scale = (coordinate: number) => Math.floor(coordinate * width / 1024);
  return [scale(421), scale(143), scale(622), scale(285)] as const;
}

export function cloeHairSatchelBounds(width: number) {
  const scale = (coordinate: number) => Math.floor(coordinate * width / 1024);
  return {
    hair: [scale(225), scale(320), scale(390), scale(638)],
    satchel: [scale(280), scale(625), scale(447), scale(833)],
  } as const;
}

export function cloeTrouserShoeBounds(width: number) {
  const scale = (coordinate: number) => Math.floor(coordinate * width / 1024);
  return {
    trousers: [scale(343), scale(739), scale(664), scale(1328)],
    shoes: [scale(309), scale(1318), scale(625), scale(1502)],
  } as const;
}

export function cloeStylusBounds(width: number) {
  const scale = (coordinate: number) => Math.floor(coordinate * width / 1024);
  return [scale(555), scale(406), scale(668), scale(550)] as const;
}

export function cloeSupportingHandBounds(width: number) {
  const scale = (coordinate: number) => Math.floor(coordinate * width / 1024);
  return [scale(728), scale(453), scale(799), scale(544)] as const;
}

export function meanLineError(
  reference: Uint8Array,
  candidate: Uint8Array,
  width: number,
  bounds: readonly [number, number, number, number],
) {
  const [left, top, right, bottom] = bounds;
  let total = 0, edges = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * width + x) * 4;
      let error = 0, across = 0, down = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = reference[offset + channel]!;
        error += Math.abs(value - candidate[offset + channel]!);
        across += Math.abs(value - reference[offset + channel + 4]!);
        down += Math.abs(value - reference[offset + channel + width * 4]!);
      }
      if (Math.max(across, down) >= 42) {
        total += error;
        edges += 1;
      }
    }
  }
  expect(edges).toBeGreaterThan(0);
  return total / (3 * edges);
}
