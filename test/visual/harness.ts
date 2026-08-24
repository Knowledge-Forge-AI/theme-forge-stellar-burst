import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@playwright/test";
import { zipSync } from "fflate";

import { buildProject } from "../../src/build.js";
import { importProject } from "../../src/importer.js";
import { installProject } from "../../src/install.js";

export const FIXTURE_DIRECTORY = join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1");
export const PRODUCTION_FIXTURE_DIRECTORY = join(process.cwd(), "test/fixtures/tftn-production-v1");

export type VisualVariant = "original" | "rebuilt" | "installed";

export interface VisualCase {
  readonly name: string;
  readonly asset: string;
  readonly width: number;
  readonly height: number;
  readonly background: string;
}

export interface RenderResult {
  readonly status: number;
  readonly errors: readonly string[];
  readonly screenshot: Buffer;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly renderedWidth: number;
  readonly renderedHeight: number;
}

export interface VisualFixture {
  readonly root: string;
  readonly baseUrl: string;
  readonly assets: readonly string[];
  readonly installedPath: (asset: string) => string;
  readonly close: () => Promise<void>;
}

const backgrounds = {
  white: "#FFFFFF",
  lightGray: "#F0F0F0",
  charcoal: "#2D2D2D",
  black: "#000000",
} as const;

function casesFor(
  asset: string,
  role: string,
  sizes: readonly (readonly [number, number])[],
  roleBackgrounds: readonly (readonly [string, string])[],
): VisualCase[] {
  return sizes.flatMap(([width, height]) =>
    roleBackgrounds.map(([backgroundName, background]) => ({
      name: `${role}-${width}x${height}-${backgroundName}`,
      asset,
      width,
      height,
      background,
    })),
  );
}

export const VISUAL_CASES: readonly VisualCase[] = [
  ...casesFor(
    "favicon.svg",
    "favicon",
    [[16, 16], [24, 24], [32, 32], [48, 48]],
    Object.entries(backgrounds),
  ),
  ...casesFor(
    "theme-forge-terminal-nova-mark.svg",
    "mark-full-color",
    [[64, 64], [128, 128], [256, 256]],
    [["white", backgrounds.white], ["charcoal", backgrounds.charcoal]],
  ),
  ...casesFor(
    "mark-monochrome-dark.svg",
    "mark-monochrome-dark",
    [[64, 64], [128, 128], [256, 256]],
    [["white", backgrounds.white], ["light-gray", backgrounds.lightGray]],
  ),
  ...casesFor(
    "mark-monochrome-light.svg",
    "mark-monochrome-light",
    [[64, 64], [128, 128], [256, 256]],
    [["charcoal", backgrounds.charcoal], ["black", backgrounds.black]],
  ),
  ...casesFor(
    "theme-forge-terminal-nova-horizontal.svg",
    "lockup-horizontal",
    [[235, 70], [470, 140], [940, 280]],
    [["white", backgrounds.white], ["charcoal", backgrounds.charcoal]],
  ),
  ...casesFor(
    "theme-forge-terminal-nova-stacked.svg",
    "lockup-stacked",
    [[150, 140], [300, 280], [600, 560]],
    [["white", backgrounds.white], ["charcoal", backgrounds.charcoal]],
  ),
];

export const PRODUCTION_VISUAL_CASES: readonly VisualCase[] = [
  ...casesFor(
    "favicon-on-dark.svg",
    "prod-favicon-on-dark",
    [[16, 16], [32, 32], [64, 64]],
    [["charcoal", backgrounds.charcoal], ["black", backgrounds.black]],
  ),
  ...casesFor(
    "favicon-on-light.svg",
    "prod-favicon-on-light",
    [[16, 16], [32, 32], [64, 64]],
    [["white", backgrounds.white], ["light-gray", backgrounds.lightGray]],
  ),
  ...casesFor(
    "mark-monochrome-dark.svg",
    "prod-mark-monochrome-dark",
    [[64, 64], [128, 128], [256, 256]],
    [["white", backgrounds.white], ["light-gray", backgrounds.lightGray]],
  ),
  ...casesFor(
    "mark-monochrome-light.svg",
    "prod-mark-monochrome-light",
    [[64, 64], [128, 128], [256, 256]],
    [["charcoal", backgrounds.charcoal], ["black", backgrounds.black]],
  ),
  ...casesFor(
    "theme-forge-terminal-nova-mark-on-dark.svg",
    "prod-mark-on-dark",
    [[64, 64], [128, 128], [256, 256]],
    [["charcoal", backgrounds.charcoal], ["black", backgrounds.black]],
  ),
  ...casesFor(
    "theme-forge-terminal-nova-mark-on-light.svg",
    "prod-mark-on-light",
    [[64, 64], [128, 128], [256, 256]],
    [["white", backgrounds.white], ["light-gray", backgrounds.lightGray]],
  ),
  ...casesFor(
    "theme-forge-terminal-nova-horizontal-on-dark.svg",
    "prod-lockup-horizontal-on-dark",
    [[540, 150], [1080, 300]],
    [["charcoal", backgrounds.charcoal], ["black", backgrounds.black]],
  ),
  ...casesFor(
    "theme-forge-terminal-nova-horizontal-on-light.svg",
    "prod-lockup-horizontal-on-light",
    [[540, 150], [1080, 300]],
    [["white", backgrounds.white], ["light-gray", backgrounds.lightGray]],
  ),
  ...casesFor(
    "theme-forge-terminal-nova-stacked-on-dark.svg",
    "prod-lockup-stacked-on-dark",
    [[360, 320], [720, 640]],
    [["charcoal", backgrounds.charcoal], ["black", backgrounds.black]],
  ),
  ...casesFor(
    "theme-forge-terminal-nova-stacked-on-light.svg",
    "prod-lockup-stacked-on-light",
    [[360, 320], [720, 640]],
    [["white", backgrounds.white], ["light-gray", backgrounds.lightGray]],
  ),
];

export const SMOKE_CASES: readonly VisualCase[] = [
  { name: "favicon", asset: "favicon.svg", width: 32, height: 32, background: backgrounds.black },
  { name: "mark-full-color", asset: "theme-forge-terminal-nova-mark.svg", width: 128, height: 128, background: backgrounds.lightGray },
  { name: "mark-monochrome-dark", asset: "mark-monochrome-dark.svg", width: 128, height: 128, background: backgrounds.white },
  { name: "mark-monochrome-light", asset: "mark-monochrome-light.svg", width: 128, height: 128, background: backgrounds.black },
  { name: "lockup-horizontal", asset: "theme-forge-terminal-nova-horizontal.svg", width: 470, height: 140, background: backgrounds.white },
  { name: "lockup-stacked", asset: "theme-forge-terminal-nova-stacked.svg", width: 300, height: 280, background: backgrounds.charcoal },
];

export const NATURAL_DIMENSIONS: Readonly<Record<string, readonly [number, number]>> = {
  "favicon.svg": [64, 64],
  "mark-monochrome-dark.svg": [256, 256],
  "mark-monochrome-light.svg": [256, 256],
  "theme-forge-terminal-nova-horizontal.svg": [940, 280],
  "theme-forge-terminal-nova-mark.svg": [256, 256],
  "theme-forge-terminal-nova-stacked.svg": [600, 560],
};

function html(asset: string, variant: VisualVariant, background: string, blank: boolean): string {
  const image = blank
    ? ""
    : `<img id="asset" src="/svg/${variant}/${encodeURIComponent(asset)}" alt="">`;
  return `<!doctype html><meta charset="utf-8"><style>*{animation:none!important;transition:none!important}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${background}}img{display:block;width:100%;height:100%;object-fit:contain}</style>${image}`;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

export async function createVisualFixture(fixtureDir = FIXTURE_DIRECTORY): Promise<VisualFixture> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-visual-"));
  const assets = (await readdir(fixtureDir)).filter((name) => name.endsWith(".svg")).sort();
  const archiveEntries: Record<string, Uint8Array> = {};
  for (const asset of assets) archiveEntries[asset] = await readFile(join(fixtureDir, asset));
  const archive = join(root, "terminal-nova.zip");
  await writeFile(
    archive,
    zipSync(archiveEntries, { level: 6, mtime: new Date("1980-01-02T00:00:00Z") }),
  );
  const imported = await importProject({ archive, root, schema: 1 });
  const projectPath = join(root, ".tfsb/project.toml");
  const projectToml = await readFile(projectPath, "utf8");
  const installs = imported.assets
    .map(
      (asset) =>
        `[[install]]\nasset = "${asset.id}"\ndestinations = ["installed/${asset.filename}"]\n`,
    )
    .join("\n");
  await writeFile(projectPath, `${projectToml}\n${installs}`);
  await buildProject(root);
  await installProject(root);

  const allowedAssets = new Set(assets);
  const directories: Readonly<Record<VisualVariant, string>> = {
    original: fixtureDir,
    rebuilt: join(root, "brand/dist"),
    installed: join(root, "installed"),
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }
      if (url.pathname === "/render") {
        const asset = url.searchParams.get("asset") ?? "";
        const variant = url.searchParams.get("variant") as VisualVariant;
        const background = url.searchParams.get("background") ?? "";
        if (!allowedAssets.has(asset) || !(variant in directories) || !/^#[0-9A-F]{6}$/i.test(background)) {
          response.writeHead(400).end("invalid render request");
          return;
        }
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(html(asset, variant, background, url.searchParams.get("blank") === "1"));
        return;
      }
      const match = /^\/svg\/(original|rebuilt|installed)\/([^/]+)$/.exec(url.pathname);
      if (match !== null) {
        const variant = match[1] as VisualVariant;
        const asset = decodeURIComponent(match[2] ?? "");
        if (!allowedAssets.has(asset)) {
          response.writeHead(404).end("not found");
          return;
        }
        const bytes = await readFile(join(directories[variant], asset));
        response.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
        response.end(bytes);
        return;
      }
      response.writeHead(404).end("not found");
    } catch {
      response.writeHead(500).end("internal test server error");
    }
  });

  try {
    const port = await listen(server);
    return {
      root,
      baseUrl: `http://127.0.0.1:${port}`,
      assets,
      installedPath: (asset) => join(root, "installed", asset),
      close: async () => {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function renderCase(
  page: Page,
  fixture: VisualFixture,
  variant: VisualVariant,
  visualCase: VisualCase,
  blank = false,
): Promise<RenderResult> {
  await page.setViewportSize({ width: visualCase.width, height: visualCase.height });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors: string[] = [];
  const onConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === "error") errors.push(message.text());
  };
  const onPageError = (error: Error) => errors.push(error.message);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  try {
    const params = new URLSearchParams({
      asset: visualCase.asset,
      variant,
      background: visualCase.background,
      ...(blank ? { blank: "1" } : {}),
    });
    const response = await page.goto(`${fixture.baseUrl}/render?${params.toString()}`, {
      waitUntil: "load",
    });
    let dimensions = { naturalWidth: 0, naturalHeight: 0, renderedWidth: 0, renderedHeight: 0 };
    if (!blank) {
      const image = page.locator("#asset");
      await image.waitFor({ state: "visible" });
      dimensions = await image.evaluate((element: HTMLImageElement) => {
        const bounds = element.getBoundingClientRect();
        return {
          naturalWidth: element.naturalWidth,
          naturalHeight: element.naturalHeight,
          renderedWidth: bounds.width,
          renderedHeight: bounds.height,
        };
      });
    }
    return {
      status: response?.status() ?? 0,
      errors,
      screenshot: await page.screenshot({ animations: "disabled", caret: "hide" }),
      ...dimensions,
    };
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
}
