import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { computeSha256 } from "../src/digests.js";
import { createRasterIllustrationRecord } from "../src/illustration/v1.js";
import { createRasterDerivativeRecipe } from "../src/illustration/derivative.js";
import { createIllustrationConsumerProfile, parseIllustrationConsumerLock, serializeIllustrationConsumerProfile } from "../src/illustration/carrier-v1.js";
import { writeIllustrationCarrier } from "../src/illustration/carrier-write.js";
import { disposeIllustrationSource, getIllustrationPayload, revalidateIllustrationSource, verifyIllustrationSource } from "../src/illustration/carrier-source.js";
import { disposeIllustrationPlan, executeIllustrationInstallPlan, ILLUSTRATION_LOCK_FILENAME, ILLUSTRATION_PROFILE_FILENAME, planIllustrationInstall } from "../src/illustration/consumer-plan.js";
import { runIllustrationConsumerCli } from "../src/illustration/consumer-cli.js";

// Synthetic one-pixel RGBA PNGs. These are decoder/ownership fixtures, never
// evidence of provider generation, visual quality, or mathematical correctness.
const PNGS = [
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGM4IcLVAAAD9QFnRkI9XAAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgCjjRAAADLQGjj1egLwAAAABJRU5ErkJggg==",
].map(value => Buffer.from(value, "base64"));
const owned: string[] = [];
afterEach(async () => { for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "tfsb-illustration-managed-"));
  await chmod(root, 0o700); owned.push(root); return root;
}
function artwork(index = 0) {
  const bytes = PNGS[index]!;
  const recipe = createRasterDerivativeRecipe({ recipeId: "hero-web", recipeRevision: 1,
    sourceSha256: computeSha256(bytes), sourceMime: "image/png",
    output: { mime: "image/png", width: 1, height: 1, fit: "contain-pad", colorSpace: "srgb", metadata: "stripped", alpha: "preserve", quality: 88, method: 6, filter: "Lanczos" },
    processor: { kind: "imagemagick", executable: "magick", version: "7.1.2-23", binarySha256: null, closureSha256: null, identityScope: "same-host-version-only" } });
  const record = createRasterIllustrationRecord({ illustrationId: "synthetic-hero", revision: index + 1, operation: "import",
    characters: [{ id: "synthetic", revision: 1 }], style: { id: "fixture", revision: 1 }, provider: null, model: null,
    source: { sha256: computeSha256(bytes), mime: "image/png", byteLength: bytes.length, dimensions: { width: 1, height: 1 }, alpha: "straight" },
    references: [], lineage: { parentDigest: null }, exportRecipes: [{ id: recipe.recipeId, recipeSha256: recipe.recipeDigest, mime: "image/png", width: 1, height: 1, alpha: "straight" }] });
  return { bytes, recipe, record };
}
async function fixture() {
  const root = await temporary(); const site = join(root, "site"); const carrier = join(root, "carrier-one");
  await mkdir(site); await writeFile(join(site, "index.html"), "<main>Unmanaged consumer content</main>\n");
  const profile = createIllustrationConsumerProfile({ id: "fixture-site", packageId: "fixture-art", illustrationId: "synthetic-hero", mappings: [{ derivativeId: "hero-web", destination: "public/hero.png" }] });
  await writeFile(join(site, ILLUSTRATION_PROFILE_FILENAME), serializeIllustrationConsumerProfile(profile));
  const art = artwork();
  await writeIllustrationCarrier({ directory: carrier, packageId: "fixture-art", revision: 1, record: art.record, derivatives: [{ recipe: art.recipe, bytes: art.bytes }] });
  return { root, site, carrier, art, profile };
}

describe("managed saved-raster consumer", () => {
  it("retains verified source authority and refuses same-byte inode substitution", async () => {
    const f = await fixture(); const source = await verifyIllustrationSource(f.carrier);
    try {
      const copy = getIllustrationPayload(source, "hero-web"); copy[0] = 0;
      expect(Buffer.from(getIllustrationPayload(source, "hero-web"))).toEqual(f.art.bytes);
      const payload = join(f.carrier, "derivatives/hero-web.png");
      await rename(payload, payload + ".original"); await writeFile(payload, f.art.bytes);
      await expect(revalidateIllustrationSource(source)).rejects.toMatchObject({ code: "ILLUSTRATION_SOURCE_CHANGED" });
    } finally { await disposeIllustrationSource(source); }
    expect(() => getIllustrationPayload(source, "hero-web")).toThrow();
  });

  it("rejects unknown carrier entries, symlinked carriers and invalid pre-creation input", async () => {
    const f = await fixture();
    await writeFile(join(f.carrier, "unexpected.txt"), "private-fixture");
    await expect(verifyIllustrationSource(f.carrier)).rejects.toMatchObject({ code: "ILLUSTRATION_SOURCE_INVALID" });
    await symlink(f.carrier, join(f.root, "alias"));
    await expect(verifyIllustrationSource(join(f.root, "alias"))).rejects.toThrow();
    const absent = join(f.root, "invalid-carrier");
    await expect(writeIllustrationCarrier({ directory: absent, packageId: "fixture-art", revision: 1, record: f.art.record,
      derivatives: [{ recipe: f.art.recipe, bytes: Uint8Array.of(1, 2, 3) }] })).rejects.toMatchObject({ code: "ILLUSTRATION_CARRIER_INPUT_INVALID" });
    await expect(lstat(absent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs exact bytes, preserves unmanaged content, and repeats as a zero-write no-op", async () => {
    const f = await fixture();
    const before = await readFile(join(f.site, "index.html"));
    const first = await planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier });
    const result = await executeIllustrationInstallPlan(first);
    expect(result.writtenOutputs).toBe(1);
    expect(await readFile(join(f.site, "public/hero.png"))).toEqual(f.art.bytes);
    expect(await readFile(join(f.site, "index.html"))).toEqual(before);
    const lockPath = join(f.site, ILLUSTRATION_LOCK_FILENAME);
    async function lockSnapshot() {
      const handle = await open(lockPath, "r");
      try {
        return { bytes: await handle.readFile(), inode: (await handle.stat()).ino };
      } finally {
        await handle.close();
      }
    }
    const lockBefore = await lockSnapshot();
    const again = await planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier });
    expect((await executeIllustrationInstallPlan(again)).writtenOutputs).toBe(0);
    expect(await lockSnapshot()).toEqual(lockBefore);
    expect((await readdir(f.site)).some(name => name === ".tfsb.lock" || name.includes("transaction-"))).toBe(false);
    await expect(executeIllustrationInstallPlan(first)).rejects.toMatchObject({ code: "ILLUSTRATION_INVALID_PLAN" });
  });

  it("syncs a deliberately selected successor only over exact managed bytes", async () => {
    const f = await fixture();
    await executeIllustrationInstallPlan(await planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier }));
    const next = artwork(1); const successor = join(f.root, "carrier-two");
    await writeIllustrationCarrier({ directory: successor, packageId: "fixture-art", revision: 2, record: next.record, derivatives: [{ recipe: next.recipe, bytes: next.bytes }] });
    await expect(planIllustrationInstall({ root: f.site, sourceDirectory: successor })).rejects.toMatchObject({ code: "ILLUSTRATION_USE_SYNC" });
    const plan = await planIllustrationInstall({ root: f.site, sourceDirectory: successor, operation: "sync" });
    expect((await executeIllustrationInstallPlan(plan)).writtenOutputs).toBe(1);
    expect(await readFile(join(f.site, "public/hero.png"))).toEqual(next.bytes);
    const lock = parseIllustrationConsumerLock(await readFile(join(f.site, ILLUSTRATION_LOCK_FILENAME)));
    expect(lock.mappings[0]!.sha256).toBe(computeSha256(next.bytes));
  });

  it("allows explicit additive sync and refuses mapping removals without deleting old assets", async () => {
    const f = await fixture();
    await executeIllustrationInstallPlan(await planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier }));
    const second = createRasterDerivativeRecipe({ recipeId: "hero-second", recipeRevision: 1,
      sourceSha256: f.art.recipe.sourceSha256, sourceMime: "image/png", output: f.art.recipe.output, processor: f.art.recipe.processor });
    const { digest: previousDigest, ...base } = f.art.record;
    const record = createRasterIllustrationRecord({ ...base, revision: 2, exportRecipes: [
      { id: second.recipeId, recipeSha256: second.recipeDigest, mime: "image/png", width: 1, height: 1, alpha: "straight" }, ...base.exportRecipes,
    ] });
    expect(record.digest).not.toBe(previousDigest);
    const source = join(f.root, "expanded-carrier");
    await writeIllustrationCarrier({ directory: source, packageId: "fixture-art", revision: 2, record,
      derivatives: [{ recipe: second, bytes: f.art.bytes }, { recipe: f.art.recipe, bytes: f.art.bytes }] });
    const profile = createIllustrationConsumerProfile({ id: "fixture-site", packageId: "fixture-art", illustrationId: "synthetic-hero", mappings: [
      { derivativeId: "hero-second", destination: "public/second.png" }, ...f.profile.mappings,
    ] });
    await writeFile(join(f.site, ILLUSTRATION_PROFILE_FILENAME), serializeIllustrationConsumerProfile(profile));
    const plan = await planIllustrationInstall({ root: f.site, sourceDirectory: source, operation: "sync" });
    expect((await executeIllustrationInstallPlan(plan)).writtenOutputs).toBe(1);
    expect(await readFile(join(f.site, "public/second.png"))).toEqual(f.art.bytes);
    await writeFile(join(f.site, ILLUSTRATION_PROFILE_FILENAME), serializeIllustrationConsumerProfile(f.profile));
    await expect(planIllustrationInstall({ root: f.site, sourceDirectory: source, operation: "sync" })).rejects.toMatchObject({ code: "ILLUSTRATION_MAPPING_REMOVAL_UNSUPPORTED" });
    expect(await readFile(join(f.site, "public/second.png"))).toEqual(f.art.bytes);
  });

  it("binds package and illustration identities and refuses carrier rollback or revision reuse", async () => {
    const f = await fixture(); const wrongPackage = join(f.root, "foreign-carrier");
    await writeIllustrationCarrier({ directory: wrongPackage, packageId: "different-package", revision: 1, record: f.art.record,
      derivatives: [{ recipe: f.art.recipe, bytes: f.art.bytes }] });
    await expect(planIllustrationInstall({ root: f.site, sourceDirectory: wrongPackage })).rejects.toMatchObject({ code: "ILLUSTRATION_SOURCE_IDENTITY_MISMATCH" });
    const { digest: previousDigest, ...base } = f.art.record;
    const foreignRecord = createRasterIllustrationRecord({ ...base, illustrationId: "different-illustration" });
    expect(foreignRecord.digest).not.toBe(previousDigest);
    const wrongIllustration = join(f.root, "different-illustration");
    await writeIllustrationCarrier({ directory: wrongIllustration, packageId: "fixture-art", revision: 1, record: foreignRecord,
      derivatives: [{ recipe: f.art.recipe, bytes: f.art.bytes }] });
    await expect(planIllustrationInstall({ root: f.site, sourceDirectory: wrongIllustration })).rejects.toMatchObject({ code: "ILLUSTRATION_SOURCE_IDENTITY_MISMATCH" });
    await executeIllustrationInstallPlan(await planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier }));
    const next = artwork(1); const newer = join(f.root, "newer");
    await writeIllustrationCarrier({ directory: newer, packageId: "fixture-art", revision: 2, record: next.record,
      derivatives: [{ recipe: next.recipe, bytes: next.bytes }] });
    await executeIllustrationInstallPlan(await planIllustrationInstall({ root: f.site, sourceDirectory: newer, operation: "sync" }));
    await expect(planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier, operation: "sync" })).rejects.toMatchObject({ code: "ILLUSTRATION_SOURCE_ROLLBACK" });
    const reused = join(f.root, "reused-revision");
    await writeIllustrationCarrier({ directory: reused, packageId: "fixture-art", revision: 2, record: f.art.record,
      derivatives: [{ recipe: f.art.recipe, bytes: f.art.bytes }] });
    await expect(planIllustrationInstall({ root: f.site, sourceDirectory: reused, operation: "sync" })).rejects.toMatchObject({ code: "ILLUSTRATION_CARRIER_REVISION_REUSED" });
    expect(await readFile(join(f.site, "public/hero.png"))).toEqual(next.bytes);
  });

  it("reports metadata-only updates as changed while retaining identical image bytes", async () => {
    const f = await fixture();
    await executeIllustrationInstallPlan(await planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier }));
    const { digest: previousDigest, ...base } = f.art.record;
    const record = createRasterIllustrationRecord({ ...base, revision: 2 });
    expect(record.digest).not.toBe(previousDigest);
    const successor = join(f.root, "metadata-only-carrier");
    await writeIllustrationCarrier({ directory: successor, packageId: "fixture-art", revision: 2, record,
      derivatives: [{ recipe: f.art.recipe, bytes: f.art.bytes }] });
    const result = await executeIllustrationInstallPlan(await planIllustrationInstall({ root: f.site, sourceDirectory: successor, operation: "sync" }));
    expect(result).toMatchObject({ writtenOutputs: 0, changed: true });
    expect(await readFile(join(f.site, "public/hero.png"))).toEqual(f.art.bytes);
    expect((await executeIllustrationInstallPlan(await planIllustrationInstall({ root: f.site, sourceDirectory: successor }))).changed).toBe(false);
  });

  it("refuses unmanaged collisions and edited or missing managed files without overwriting", async () => {
    const f = await fixture(); await mkdir(join(f.site, "public"));
    await writeFile(join(f.site, "public/hero.png"), f.art.bytes);
    await expect(planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier })).rejects.toMatchObject({ code: "ILLUSTRATION_DESTINATION_COLLISION" });
    await rm(join(f.site, "public/hero.png"));
    await executeIllustrationInstallPlan(await planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier }));
    await writeFile(join(f.site, "public/hero.png"), "manual edit");
    await expect(planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier, operation: "sync" })).rejects.toMatchObject({ code: "ILLUSTRATION_MANAGED_DRIFT" });
    expect(await readFile(join(f.site, "public/hero.png"), "utf8")).toBe("manual edit");
    await rm(join(f.site, "public/hero.png"));
    await expect(planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier, operation: "sync" })).rejects.toMatchObject({ code: "ILLUSTRATION_MANAGED_DRIFT" });
  });

  it("rechecks source and profile before mutation, and rejects forged plans", async () => {
    const f = await fixture(); const plan = await planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier });
    await expect(executeIllustrationInstallPlan(JSON.parse(JSON.stringify(plan)))).rejects.toMatchObject({ code: "ILLUSTRATION_INVALID_PLAN" });
    await writeFile(join(f.carrier, "derivatives/hero-web.png"), PNGS[1]!);
    await expect(executeIllustrationInstallPlan(plan)).rejects.toThrow();
    await expect(lstat(join(f.site, "public/hero.png"))).rejects.toMatchObject({ code: "ENOENT" });
    const g = await fixture(); const next = await planIllustrationInstall({ root: g.site, sourceDirectory: g.carrier });
    await writeFile(join(g.site, ILLUSTRATION_PROFILE_FILENAME), "changed profile");
    await expect(executeIllustrationInstallPlan(next)).rejects.toThrow();
    await expect(lstat(join(g.site, ILLUSTRATION_LOCK_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps active plan authority until execution ends and refuses disposed source validation", async () => {
    const f = await fixture(); const plan = await planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier });
    let activeChecked = false;
    await executeIllustrationInstallPlan(plan, { async beforeStage() {
      activeChecked = true;
      await expect(disposeIllustrationPlan(plan)).rejects.toMatchObject({ code: "ILLUSTRATION_PLAN_ACTIVE" });
    } });
    expect(activeChecked).toBe(true);
    const source = await verifyIllustrationSource(f.carrier);
    const pending = expect(revalidateIllustrationSource(source)).rejects.toMatchObject({ code: "ILLUSTRATION_SOURCE_DISPOSED" });
    await disposeIllustrationSource(source); await pending;
  });

  it("rolls back a pre-lock failure using the shared transaction", async () => {
    const f = await fixture(); const plan = await planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier });
    await expect(executeIllustrationInstallPlan(plan, { beforeLockPromotion() { throw new Error("synthetic fault"); } })).rejects.toMatchObject({ diagnostic: { code: "ILLUSTRATION_TRANSACTION_ROLLED_BACK" } });
    await expect(lstat(join(f.site, "public/hero.png"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(f.site, ILLUSTRATION_LOCK_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(f.site, "index.html"), "utf8")).toContain("Unmanaged consumer content");
  });

  it("rejects a replaced target parent and mismatched destination extensions", async () => {
    const f = await fixture(); await mkdir(join(f.site, "public"));
    const plan = await planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier });
    await rename(join(f.site, "public"), join(f.site, "former-public")); await mkdir(join(f.site, "public"));
    await expect(executeIllustrationInstallPlan(plan)).rejects.toThrow();
    const g = await fixture();
    const profile = createIllustrationConsumerProfile({ id: "fixture-site", packageId: "fixture-art", illustrationId: "synthetic-hero", mappings: [{ derivativeId: "hero-web", destination: "public/hero.webp" }] });
    await writeFile(join(g.site, ILLUSTRATION_PROFILE_FILENAME), serializeIllustrationConsumerProfile(profile));
    await expect(planIllustrationInstall({ root: g.site, sourceDirectory: g.carrier })).rejects.toMatchObject({ code: "ILLUSTRATION_DESTINATION_TYPE_MISMATCH" });
    const h = await fixture(); const pending = await planIllustrationInstall({ root: h.site, sourceDirectory: h.carrier });
    await disposeIllustrationPlan(pending);
    await expect(executeIllustrationInstallPlan(pending)).rejects.toThrow();
  });

  it("refuses destination parents owned by the source, including case aliases where supported", async () => {
    const f = await fixture(); const source = join(f.site, "carrier");
    await writeIllustrationCarrier({ directory: source, packageId: "fixture-art", revision: 1, record: f.art.record,
      derivatives: [{ recipe: f.art.recipe, bytes: f.art.bytes }] });
    let alias = "carrier";
    if (await lstat(join(f.site, "CARRIER")).then(() => true, () => false)) alias = "CARRIER";
    const profile = createIllustrationConsumerProfile({ id: "fixture-site", packageId: "fixture-art", illustrationId: "synthetic-hero",
      mappings: [{ derivativeId: "hero-web", destination: `${alias}/future/hero.png` }] });
    await writeFile(join(f.site, ILLUSTRATION_PROFILE_FILENAME), serializeIllustrationConsumerProfile(profile));
    await expect(planIllustrationInstall({ root: f.site, sourceDirectory: source })).rejects.toMatchObject({ code: "ILLUSTRATION_SOURCE_DESTINATION_COLLISION" });
    const verified = await verifyIllustrationSource(source); await disposeIllustrationSource(verified);
  });

  it("runs the declared directory-carrier and consumer CLI without exposing private input paths", async () => {
    const f = await fixture(); const request = join(f.root, "private-request.json");
    await writeFile(request, JSON.stringify({ packageId: "fixture-art", revision: 1, recordPath: "carrier-one/record.json",
      derivatives: [{ recipePath: "carrier-one/recipes/hero-web.json", sourcePath: "carrier-one/derivatives/hero-web.png" }] }));
    const output = { stdout: "", stderr: "" };
    const io = { stdout(value: string) { output.stdout += value; }, stderr(value: string) { output.stderr += value; } };
    const run = async (args: string[], code = 0) => {
      output.stdout = ""; output.stderr = "";
      const actual = await runIllustrationConsumerCli([...args, "--json"], f.root, io);
      expect(actual, output.stdout).toBe(code);
      expect(output.stdout + output.stderr).not.toContain(f.root);
      expect(output.stdout + output.stderr).not.toContain("private-request");
      return JSON.parse(output.stdout);
    };
    const created = await run(["carrier-create", "--request", request, "--directory", "cli-carrier"]);
    expect(created.data.masterEntrySlot).toBe(false);
    expect(created.data).not.toHaveProperty("privateMastersIncluded");
    expect((await run(["carrier-inspect", "--directory", "cli-carrier"])).state).toBe("verified");
    await rm(join(f.site, ILLUSTRATION_PROFILE_FILENAME));
    const init = ["consumer-init", "--root", f.site, "--id", "fixture-site", "--package", "fixture-art", "--illustration", "synthetic-hero", "--mapping", "hero-web=public/hero.png"];
    expect((await run(init)).state).toBe("configured");
    await run(init, 3);
    expect((await run(["consumer-plan", "--root", f.site, "--carrier", "cli-carrier"])).data.serializedPlanIsExecutionAuthority).toBe(false);
    expect((await run(["install", "--root", f.site, "--carrier", "cli-carrier"])).data.writtenOutputs).toBe(1);
    expect((await run(["install", "--root", f.site, "--carrier", "cli-carrier"])).state).toBe("unchanged");
    await writeFile(join(f.site, "public/hero.png"), "synthetic operator edit");
    output.stdout = ""; output.stderr = "";
    expect(await runIllustrationConsumerCli(["sync", "--root", f.site, "--carrier", "cli-carrier"], f.root, io)).toBe(3);
    expect(output.stderr).toContain("ILLUSTRATION_MANAGED_DRIFT");
    expect(output.stderr).not.toContain(f.root);
    expect(await readFile(join(f.site, "public/hero.png"), "utf8")).toBe("synthetic operator edit");
  });

  it("reports recovery residue before missing-output drift or unowned-output collision", async () => {
    for (const missing of ["output", "lock"] as const) {
      const f = await fixture();
      await executeIllustrationInstallPlan(await planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier }));
      const target = missing === "output" ? join(f.site, "public/hero.png") : join(f.site, ILLUSTRATION_LOCK_FILENAME);
      const backup = missing === "output"
        ? join(f.site, "public/.hero.png.tfsb-illustration-backup-" + "a".repeat(32))
        : join(f.site, "..tfsb-illustration.lock.json.tfsb-illustration-backup-" + "a".repeat(32));
      const bytes = await readFile(target);
      await rename(target, backup);
      await expect(planIllustrationInstall({ root: f.site, sourceDirectory: f.carrier }))
        .rejects.toMatchObject({ code: "ILLUSTRATION_RECOVERY_REQUIRED" });
      expect(await readFile(backup)).toEqual(bytes);
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
