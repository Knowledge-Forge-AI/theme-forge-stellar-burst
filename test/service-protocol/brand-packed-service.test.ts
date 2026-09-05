import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = []; const tarballs: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); for (const path of tarballs.splice(0)) await rm(path, { force: true }); });

function initialize(service: string, minVersion: string, maxVersion: string, cwd: string): any {
  const frame = { jsonrpc: "2.0", id: "init", method: "initialize", params: { protocol: "tfsb.studio", minVersion, maxVersion, client: { name: "packed-vitest", version: "1" }, capabilities: { progress: false, cancellation: true } } };
  const run = spawnSync(process.execPath, [service], { cwd, input: `${JSON.stringify(frame)}\n`, encoding: "utf8" });
  const line = run.stdout.trim().split("\n")[0]; if (line === undefined || line === "") throw new Error(`Packed service did not respond: ${run.stderr}`);
  return JSON.parse(line);
}

describe("packed Studio brand protocol service", () => {
  it("negotiates exact 1.0 and base-only 1.1 from one candidate tarball", { timeout: 90_000 }, async () => {
    const consumer = await mkdtemp(join(tmpdir(), "tfsb-studio-packed-")); roots.push(consumer);
    const rootPackDestination = join(consumer, "root-pack");
    const companionPackDestination = join(consumer, "companion-pack");
    await mkdir(rootPackDestination, { recursive: true });
    await mkdir(companionPackDestination, { recursive: true });
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", rootPackDestination], { cwd: process.cwd(), encoding: "utf8" }))[0];
    const tarball = join(rootPackDestination, packed.filename);
    const installed = join(consumer, "node_modules/@knowledge-forge-ai/theme-forge-stellar-burst"); await mkdir(installed, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "--strip-components=1", "-C", installed]);
    for (const dependency of ["@xmldom", "fflate", "smol-toml"]) { const source = join(process.cwd(), "node_modules", dependency), target = join(consumer, "node_modules", dependency); if (existsSync(source)) await symlink(source, target); }
    const service = join(installed, "dist/service-protocol/server-cli.js");
    const one = initialize(service, "1.0", "1.0", consumer); expect(one.result.selectedVersion).toBe("1.0"); expect(one.result.capabilities).not.toHaveProperty("brand");
    const next = initialize(service, "1.0", "1.1", consumer); expect(next.result.selectedVersion).toBe("1.1"); expect(next.result.capabilities.brand.raster).toEqual({ available: false });
    expect(existsSync(join(installed, "protocol/tfsb-studio-v1/requests-1.1.schema.json"))).toBe(true);
    expect(existsSync(join(installed, "protocol/tfsb-studio-v1/inventory-1.1.json"))).toBe(true);

    const companionRoot = join(process.cwd(), "packages/tfsb-raster-resvg");
    const companionPack = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", companionPackDestination], { cwd: companionRoot, encoding: "utf8" }))[0];
    const companionTarball = join(companionPackDestination, companionPack.filename);
    const companionInstalled = join(consumer, "node_modules/@knowledge-forge-ai/tfsb-raster-resvg"); await mkdir(companionInstalled, { recursive: true });
    execFileSync("tar", ["-xzf", companionTarball, "--strip-components=1", "-C", companionInstalled]);
    const resvgSource = join(companionRoot, "node_modules/@resvg"), resvgTarget = join(consumer, "node_modules/@resvg"); if (existsSync(resvgSource)) await symlink(resvgSource, resvgTarget);
    const companionProbe = spawnSync(process.execPath, ["--input-type=module", "-e", "import('@knowledge-forge-ai/tfsb-raster-resvg').then((value)=>console.log(JSON.stringify(value.descriptor)))"], { cwd: consumer, encoding: "utf8" });
    expect(companionProbe.status, companionProbe.stderr).toBe(0);
    const available = initialize(service, "1.1", "1.1", consumer); expect(available.result.capabilities.brand.raster).toMatchObject({ available: true, adapterId: "resvg-png-v1", rendererVersion: "2.6.2", platformClaim: "darwin-arm64" });
    expect(available.result.capabilities.brand.methods).toMatchObject({ qaBaselinePlan: true, exportPlan: true });
    await writeFile(join(companionInstalled, "index.js"), "this is not valid JavaScript\n");
    const corrupt = initialize(service, "1.1", "1.1", consumer); expect(corrupt.result.capabilities.brand.raster).toEqual({ available: false });
    await rm(companionInstalled, { recursive: true, force: true });
    const missing = initialize(service, "1.1", "1.1", consumer); expect(missing.result.capabilities.brand.raster).toEqual({ available: false });
    const legacy = initialize(service, "1.0", "1.0", consumer); expect(legacy.result.capabilities).not.toHaveProperty("brand");
  });
});
