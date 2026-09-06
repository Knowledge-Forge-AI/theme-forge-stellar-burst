import { deflateSync } from "node:zlib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli.js";
import { loadCanonicalProject } from "../../src/project.js";
import { createRasterCapabilityFromModule, type RasterCapabilityStatus } from "../../src/brand/raster-capability.js";
import type { RasterAdapterDescriptor } from "../../src/brand/raster-receipt.js";
import { computeBrandExportsDomainDigest, parseBrandExportsToml } from "../../src/brand/export-profile.js";
import { readRepoFile } from "../helpers.js";

const table = (() => { const values = new Uint32Array(256); for (let n = 0; n < 256; n++) { let value = n; for (let k = 0; k < 8; k++) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; values[n] = value >>> 0; } return values; })();
function crc(bytes: Uint8Array): number { let value = 0xffffffff; for (const byte of bytes) value = table[(value ^ byte) & 0xff]! ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array): Uint8Array { const result = new Uint8Array(data.length + 12), view = new DataView(result.buffer); view.setUint32(0, data.length); result.set(Buffer.from(type), 4); result.set(data, 8); view.setUint32(8 + data.length, crc(result.subarray(4, 8 + data.length))); return result; }

export function rgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const scanlines = new Uint8Array((width * 4 + 1) * height);
  for (let row = 0; row < height; row++) scanlines.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), row * (width * 4 + 1) + 1);
  const ihdr = new Uint8Array(13), view = new DataView(ihdr.buffer); view.setUint32(0, width); view.setUint32(4, height); ihdr[8] = 8; ihdr[9] = 6;
  return Uint8Array.from([...Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), ...chunk("IHDR", ihdr), ...chunk("IDAT", deflateSync(scanlines)), ...chunk("IEND", new Uint8Array())]);
}

function hostPlatformClaim(): string {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  return `${process.platform}-${process.arch}`;
}

export const fakeDescriptor: RasterAdapterDescriptor = Object.freeze({ adapterId: "resvg-png-v1", companionPackage: "@knowledge-forge-ai/tfsb-raster-resvg", companionVersion: "0.0.0-test", backend: "wasm", rendererPackage: "@resvg/resvg-wasm", rendererVersion: "2.6.2", rendererBuildDigest: `sha256:${"1".repeat(64)}`, nodeMajor: Number(process.versions.node.split(".")[0]), platformClaim: hostPlatformClaim(), qualificationId: "test-only-fixed-capability" });

export function fakeRasterCapability(rendererDigit = "1"): RasterCapabilityStatus {
  const descriptor = Object.freeze({ ...fakeDescriptor, rendererBuildDigest: `sha256:${rendererDigit.repeat(64)}` as const });
  return createRasterCapabilityFromModule({
    descriptor,
    renderSvg: async (request: { width: number; height: number; alpha: "straight" | "opaque" }) => {
      const rgba8 = new Uint8Array(request.width * request.height * 4);
      for (let index = 0; index < rgba8.length; index += 4) { rgba8[index] = 17; rgba8[index + 1] = 34; rgba8[index + 2] = 51; rgba8[index + 3] = request.alpha === "opaque" ? 255 : 128; }
      return { width: request.width, height: request.height, rgba8, pngBytes: rgbaPng(request.width, request.height, rgba8), descriptor };
    },
  });
}

export async function setupRasterProject(roots: string[], options: { readonly qa?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-raster-")); roots.push(root);
  await mkdir(join(root, ".tfsb", "assets"), { recursive: true });
  await mkdir(join(root, ".tfsb", "companions"), { recursive: true });
  await writeFile(join(root, ".tfsb", "project.toml"), readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/project.toml"));
  await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-dark.toml"), readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-dark.toml"));
  await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-light.toml"), readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml"));
  let brand = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml").replace("exports = false", "exports = true");
  if (options.qa === true) brand = brand.replace("qa = false", "qa = true");
  await writeFile(join(root, ".tfsb", "brand.toml"), brand);
  const exportsToml = `schema = "tfsb.brand-exports"\nschema_version = 1\n\n[[profiles]]\nid = "web-icons"\nadapter = "resvg-png-v1"\n\n[[profiles.outputs]]\nid = "icon"\npurpose = "pwa-icon"\nasset = "fixture-mark-on-light"\ndestination = "public/icon.png"\nwidth = 16\nheight = 16\nfit = "contain-pad"\nbackground = "transparent"\ncolor_space = "srgb"\nalpha = "straight"\n`;
  await writeFile(join(root, ".tfsb", "brand-exports.toml"), exportsToml);
  const parsedExports = parseBrandExportsToml(exportsToml); if (!parsedExports.ok) throw new Error("Raster export test schema is invalid.");
  let packageToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand-package.toml").replace(/brand_system_digest = "[^"]+"/u, (line) => `${line}\nexport_profile_digest = "${computeBrandExportsDomainDigest(parsedExports.value)}"`);
  const guidance = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/GUIDANCE.md");
  await writeFile(join(root, ".tfsb", "brand-package.toml"), packageToml);
  await writeFile(join(root, ".tfsb", "companions", "GUIDANCE.md"), guidance);
  await writeFile(join(root, "GUIDANCE.md"), guidance);
  if (options.qa === true) await writeFile(join(root, ".tfsb", "brand-qa.toml"), `schema = "tfsb.brand-qa"\nschema_version = 1\n\n[[profiles]]\nid = "visual"\nrenderer = "required"\nformats = ["json"]\ncases = ["bounds"]\n\n[[cases]]\nid = "bounds"\nkind = "pixel-bounds"\nasset = "fixture-mark-on-light"\nsizes = [[16, 16]]\nbackgrounds = ["transparent"]\nalpha_threshold = 0\n`);
  const loaded = await loadCanonicalProject(root, "check"); if (loaded.brand?.brandSystemDigest === undefined) throw new Error("Raster fixture brand system digest is unavailable.");
  packageToml = packageToml.replace(/brand_system_digest = "[^"]+"/u, `brand_system_digest = "${loaded.brand.brandSystemDigest}"`); await writeFile(join(root, ".tfsb", "brand-package.toml"), packageToml);
  let errorText = "";
  const sink = { stdout: (_text: string) => undefined, stderr: (text: string) => { errorText += text; } };
  if (await runCli(["build"], root, sink) !== 0) throw new Error(`Raster test fixture build failed: ${errorText}`);
  return root;
}

export async function cleanupRoots(roots: string[]): Promise<void> { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); }
