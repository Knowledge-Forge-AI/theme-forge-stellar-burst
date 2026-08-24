import { access, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";

interface ShardManifest {
  readonly shard: string;
  readonly entries: readonly { readonly path: string }[];
  readonly lifecycleOutcome: { readonly status: string };
}

const scratchRoot = process.env.TFSB_DOGFOOD_SCRATCH;
const sizes = [16, 24, 32, 64, 128, 256] as const;

async function manifests(): Promise<readonly { readonly directory: string; readonly manifest: ShardManifest }[]> {
  if (scratchRoot === undefined) return [];
  const result: { directory: string; manifest: ShardManifest }[] = [];
  for (const corpus of await readdir(scratchRoot)) {
    const corpusDirectory = join(scratchRoot, corpus);
    for (const shard of await readdir(corpusDirectory)) {
      const directory = join(corpusDirectory, shard);
      const manifestPath = join(directory, "manifest.json");
      try {
        result.push({ directory, manifest: JSON.parse(await readFile(manifestPath, "utf8")) as ShardManifest });
      } catch {
        // A non-shard scratch entry is not evidence and is ignored.
      }
    }
  }
  return result
    .filter(({ manifest }) => manifest.lifecycleOutcome.status === "qualified")
    .sort((left, right) => Buffer.from(left.manifest.shard).compare(Buffer.from(right.manifest.shard)));
}

function crossBrowserRepresentatives(entries: readonly { readonly path: string; readonly source: string; readonly canonical: string }[]) {
  const patterns = [/<title(?:\s|>)/, /currentColor/, /<circle(?:\s|>)/, /<rect(?:\s|>)/, /<line(?:\s|>)/, /<polyline(?:\s|>)/, /<polygon(?:\s|>)/, /transform=/];
  const selected = new Map<string, typeof entries[number]>();
  for (const pattern of patterns) {
    const match = entries.find((entry) => pattern.test(entry.source));
    if (match !== undefined) selected.set(match.path, match);
  }
  if (entries[0] !== undefined) selected.set(entries[0].path, entries[0]);
  return [...selected.values()];
}

test("dogfood shard source and canonical output are pixel-identical", async ({ page, browserName }) => {
  test.skip(scratchRoot === undefined, "TFSB_DOGFOOD_SCRATCH is not set; local-only dogfood checkouts were not requested.");
  const available = await manifests();
  expect(available.length).toBeGreaterThan(0);

  for (const { directory, manifest } of available) {
    const archive = unzipSync(await readFile(join(directory, "source.zip")));
    const entries = await Promise.all(manifest.entries.map(async ({ path }) => ({
      path,
      source: Buffer.from(archive[path]!).toString("utf8"),
      canonical: await readFile(join(directory, "project", "brand", "dist", basename(path)), "utf8"),
    })));
    const selected = browserName === "chromium" ? entries : crossBrowserRepresentatives(entries);
    for (const entry of selected) {
      const comparison = await page.evaluate(async ({ source, canonical, sizes: requestedSizes }) => {
        const viewBox = /\bviewBox="[^"]*\s([0-9.]+)\s([0-9.]+)"/.exec(source);
        const natural = viewBox === null ? [] : [{ width: Math.ceil(Number(viewBox[1])), height: Math.ceil(Number(viewBox[2])) }];
        const targets = [...natural, ...requestedSizes.map((size) => ({ width: size, height: size }))];
        const render = async (svg: string, width: number, height: number) => {
          const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
          try {
            const image = new Image();
            image.src = url;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (context === null) throw new Error("2D canvas unavailable.");
            context.drawImage(image, 0, 0, width, height);
            return [...context.getImageData(0, 0, width, height).data];
          } finally {
            URL.revokeObjectURL(url);
          }
        };
        for (const target of targets) {
          const before = await render(source, target.width, target.height);
          const after = await render(canonical, target.width, target.height);
          if (before.length !== after.length || before.some((value, index) => value !== after[index])) {
            return { equal: false, width: target.width, height: target.height };
          }
        }
        return { equal: true };
      }, { source: entry.source, canonical: entry.canonical, sizes: [...sizes] });
      expect(comparison, `${browserName} ${manifest.shard} ${entry.path}`).toEqual({ equal: true });
    }
  }
});
