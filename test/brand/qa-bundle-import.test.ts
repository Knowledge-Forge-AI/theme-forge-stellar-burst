import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { bundleBrandProject, computeAssetSemanticDigest, computeRawSha256, computeSvgOutputDigest, importBrandProject, loadCanonicalProject, parseBrandBundleManifest } from "../../src/index.js";
import { runCli } from "../../src/cli.js";
import { readRepoFile } from "../helpers.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function io() { return { stdout: (_text: string) => undefined, stderr: (_text: string) => undefined }; }
function capture() { let stdout = "", stderr = ""; return { io: { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } }, stdout: () => stdout, stderr: () => stderr }; }

async function sourceProject(): Promise<{ root: string; baseline: Uint8Array }> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-qa-bundle-")); roots.push(root);
  await mkdir(join(root, ".tfsb", "assets"), { recursive: true });
  await mkdir(join(root, ".tfsb", "companions"), { recursive: true });
  for (const file of ["project.toml", "brand.toml", "brand-package.toml"]) await writeFile(join(root, ".tfsb", file), readRepoFile(`docs/examples/v0.4/brand-system/core-minimal/.tfsb/${file}`));
  for (const file of ["fixture-mark-on-dark.toml", "fixture-mark-on-light.toml"]) await writeFile(join(root, ".tfsb", "assets", file), readRepoFile(`docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/${file}`));
  const guidance = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/GUIDANCE.md");
  await writeFile(join(root, "GUIDANCE.md"), guidance); await writeFile(join(root, ".tfsb", "companions", "GUIDANCE.md"), guidance);
  expect(await runCli(["build"], root, io())).toBe(0);
  const initial = await loadCanonicalProject(root, "check");
  const asset = initial.assets.find((entry) => entry.id === "fixture-mark-on-light")!;
  const svg = initial.outputs.get(asset.filename)!;
  const baseline = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  const brandPath = join(root, ".tfsb", "brand.toml");
  await writeFile(brandPath, (await readFile(brandPath, "utf8")).replace("qa = false", "qa = true"));
  const qa = `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "release"
renderer = "required"
formats = ["json", "markdown", "html"]
cases = ["golden"]
[[cases]]
id = "golden"
kind = "baseline"
asset = "fixture-mark-on-light"
sizes = [[2, 2]]
backgrounds = ["transparent"]
baseline_path = ".tfsb/brand-baselines/release/golden.png"
baseline_digest = "sha256:${computeRawSha256(baseline)}"
renderer_id = "fake"
renderer_version = "1"
platform_claim = "portable"
canonical_asset_digest = "${computeAssetSemanticDigest(asset)}"
svg_digest = "${computeSvgOutputDigest(Buffer.from(svg).toString("utf8"))}"
`;
  await writeFile(join(root, ".tfsb", "brand-qa.toml"), qa);
  await mkdir(join(root, ".tfsb", "brand-baselines", "release"), { recursive: true });
  await writeFile(join(root, ".tfsb", "brand-baselines", "release", "golden.png"), baseline);
  const placeholder = await loadCanonicalProject(root, "check");
  const packagePath = join(root, ".tfsb", "brand-package.toml");
  await writeFile(packagePath, (await readFile(packagePath, "utf8")).replace(/brand_system_digest = "sha256:[0-9a-f]{64}"/u, `brand_system_digest = "${placeholder.brand!.brandSystemDigest}"`));
  return { root, baseline };
}

describe("QA baseline brand bundle/import authority", () => {
  it("preserves QA, manifest cross-links, and exact baseline bytes through import and rebundle", async () => {
    const source = await sourceProject();
    await bundleBrandProject({ root: source.root, output: "qa.zip" });
    const archive = await readFile(join(source.root, "qa.zip"));
    const zip = unzipSync(archive);
    expect(zip["brand/brand-qa.toml"]).toBeDefined();
    expect(zip["baselines/release/golden.png"]).toEqual(source.baseline);
    const manifest = parseBrandBundleManifest(new TextDecoder().decode(zip["tfsb-brand-manifest.json"]!));
    expect(manifest.ok && manifest.value.qaBaselines?.[0]).toMatchObject({ profileId: "release", caseId: "golden", bundlePath: "baselines/release/golden.png" });

    const target = await mkdtemp(join(tmpdir(), "tfsb-qa-import-")); roots.push(target);
    await importBrandProject({ archive: join(source.root, "qa.zip"), root: target });
    expect(await readFile(join(target, ".tfsb", "brand-baselines", "release", "golden.png"))).toEqual(Buffer.from(source.baseline));
    await bundleBrandProject({ root: target, output: "rebundle.zip" });
    const rebundled = unzipSync(await readFile(join(target, "rebundle.zip")));
    expect(rebundled["baselines/release/golden.png"]).toEqual(source.baseline);
  });

  it("rejects missing and tampered QA baseline payloads", async () => {
    const source = await sourceProject();
    await writeFile(join(source.root, ".tfsb", "brand-baselines", "release", "golden.png"), new Uint8Array([1]));
    await expect(bundleBrandProject({ root: source.root, output: "bad.zip" })).rejects.toThrow(/digest/u);
  });

  it("compares a verified brand archive read-only through the additive CLI mode", async () => {
    const source = await sourceProject();
    await bundleBrandProject({ root: source.root, output: "qa.zip" });
    const result = capture();
    const exit = await runCli(["diff", "--brand-archive", join(source.root, "qa.zip"), "--json"], source.root, result.io);
    expect(exit, result.stderr() || result.stdout()).toBe(0);
    expect(JSON.parse(result.stdout())).toMatchObject({ command: "diff", exitCode: 0, data: { schema: "tfsb.brand-diff", status: "equal" } });
    expect(result.stderr()).toBe("");
  });
});
