import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

import { buildProject } from "../../src/build.js";
import { importProject } from "../../src/importer.js";
import { installProject } from "../../src/install.js";
import { previewProject } from "../../src/preview.js";
import { PRODUCTION_FIXTURE_DIRECTORY } from "./harness.js";

interface PreviewFixture {
  readonly root: string;
  readonly baseUrl: string;
  readonly buildOutput: string;
  readonly installOutput: string;
  readonly close: () => Promise<void>;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function createPreviewFixture(): Promise<PreviewFixture> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-preview-visual-"));
  const archiveEntries: Record<string, Uint8Array> = {};
  for (const name of await readdir(PRODUCTION_FIXTURE_DIRECTORY)) archiveEntries[name] = await readFile(join(PRODUCTION_FIXTURE_DIRECTORY, name));
  const archive = join(root, "terminal-nova-production.zip");
  await writeFile(archive, zipSync(archiveEntries, { level: 6, mtime: new Date("1980-01-02T00:00:00Z") }));
  const imported = await importProject({ archive, root, schema: 1, companions: ["brand-README.md"], recordProvenance: true });
  const favicon = imported.assets.find((asset) => asset.filename === "favicon-on-dark.svg")!;
  const projectPath = join(root, ".tfsb/project.toml");
  await writeFile(projectPath, `${await readFile(projectPath, "utf8")}\n[[install]]\nasset = "${favicon.id}"\ndestinations = ["installed/${favicon.filename}"]\n\n[[companion]]\nfile = "brand-README.md"\ndestinations = ["installed/brand-README.md"]\n`);
  const assetPath = join(root, ".tfsb/assets", `${favicon.id}.toml`);
  const assetText = await readFile(assetPath, "utf8");
  await writeFile(assetPath, assetText.replace(/^title = ".*"$/m, `title = "<script>window.evil=1</script>&'\\"safe\\""`));
  await buildProject(root);
  await installProject(root);
  await previewProject({ root });
  const previewRoot = join(root, ".tfsb-preview");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const requestPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const normalized = normalize(requestPath).replaceAll("\\", "/");
      if (normalized.startsWith("../") || normalized.includes("/../") || normalized === ".") {
        response.writeHead(400).end("bad path");
        return;
      }
      const bytes = await readFile(join(previewRoot, normalized));
      const contentType = extname(normalized) === ".html" ? "text/html; charset=utf-8" : extname(normalized) === ".css" ? "text/css; charset=utf-8" : extname(normalized) === ".svg" ? "image/svg+xml" : "application/json";
      response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
      response.end(bytes);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  try {
    const port = await listen(server);
    return {
      root,
      baseUrl: `http://127.0.0.1:${port}`,
      buildOutput: join(root, "brand/dist", favicon.filename),
      installOutput: join(root, "installed", favicon.filename),
      close: async () => {
        await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test.describe("static production preview", () => {
  let fixture: PreviewFixture;

  test.beforeAll(async () => {
    fixture = await createPreviewFixture();
  });

  test.afterAll(async () => {
    await fixture.close();
  });

  test("is offline, scriptless, escaped, complete, and drift-aware", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const requests: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => requests.push(request.url()));
    const response = await page.goto(fixture.baseUrl, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(requests.every((url) => url.startsWith(fixture.baseUrl))).toBe(true);
    expect(await page.locator("script").count()).toBe(0);
    expect(await page.locator("object, embed, iframe").count()).toBe(0);
    expect(await page.locator("link[rel=stylesheet]").getAttribute("href")).toBe("preview.css");
    const imageSources = await page.locator("img").evaluateAll((images) => [...new Set(images.map((image) => image.getAttribute("src")))].sort());
    expect(imageSources).toHaveLength(10);
    expect(imageSources.every((source) => source?.startsWith("assets/") === true)).toBe(true);
    expect(await page.locator(".asset-card").count()).toBe(10);
    expect(await page.locator(".asset-card").first().locator(".surface").count()).toBe(5);
    expect(await page.locator(".asset-card", { hasText: "favicon-on-dark" }).getByText("16 px", { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.locator(".asset-card", { hasText: "favicon-on-dark" }).getByText("24 px", { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.locator(".asset-card", { hasText: "favicon-on-dark" }).getByText("32 px", { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.locator(".asset-card", { hasText: "favicon-on-dark" }).getByText("48 px", { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.locator(".asset-card", { hasText: "horizontal" }).first().locator(".geometry-profile").textContent()).toBe("wide");
    expect(await page.locator(".asset-card", { hasText: "stacked" }).first().locator(".geometry-profile").textContent()).toBe("near_square");
    expect(await page.locator("body").textContent()).toContain("<script>window.evil=1</script>&'\"safe\"");
    expect(await page.locator(".companions").textContent()).toContain("brand-README.md");
    expect(await page.locator(".companions a").count()).toBe(0);
    expect(await page.locator(".companions").innerHTML()).not.toContain("# Theme Forge");
    const image = page.locator("img").first();
    await expect(image).toBeVisible();
    const dimensions = await image.evaluate((element: HTMLImageElement) => ({ width: element.naturalWidth, height: element.naturalHeight }));
    expect(dimensions.width).toBeGreaterThan(0);
    expect(dimensions.height).toBeGreaterThan(0);
    expect((await image.screenshot()).length).toBeGreaterThan(100);

    await writeFile(fixture.buildOutput, "build drift");
    await writeFile(fixture.installOutput, "install drift");
    await previewProject({ root: fixture.root });
    await page.reload({ waitUntil: "networkidle" });
    const faviconCard = page.locator(".asset-card", { hasText: "favicon-on-dark" });
    expect(await faviconCard.locator(".build-status").textContent()).toBe("byte_different");
    expect(await faviconCard.locator(".install-status").textContent()).toBe("byte_different");
  });
});
