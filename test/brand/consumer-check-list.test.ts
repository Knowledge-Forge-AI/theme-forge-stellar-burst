import { readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { checkProject, createConsumerBrandLock, executeConsumerInstallPlan, inspectConsumerState, listProject, parseConsumerBrandLock, planConsumerInstall, serializeConsumerBrandLock } from "../../src/index.js";
import { runCli } from "../../src/cli.js";
import { createConsumerBundle, createConsumerProject, PROFILE_ID } from "./consumer-test-helper.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function capture() { let stdout = "", stderr = ""; return { io: { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } }, stdout: () => stdout, stderr: () => stderr }; }

describe("consumer check and list", () => {
  it("reports offline integrity without treating source-unavailable as generic drift", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const before = await checkProject(consumer);
    await executeConsumerInstallPlan(await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] }));
    expect((await inspectConsumerState({ root: consumer })).status).toBe("source-unavailable");
    expect((await inspectConsumerState({ root: consumer })).exitCode).toBe(0);
    const after = await checkProject(consumer);
    expect(after.drift).toBe(before.drift);
    expect(after.consumer?.status).toBe("source-unavailable");
    const listed = await listProject(consumer);
    expect(listed.consumer?.packages[0]?.packageId).toBe("core-fixture-brand");
    expect(JSON.stringify(listed.consumer)).not.toContain(producer.archive);
  });

  it("uses the closed drift and invalid exit taxonomy", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    await executeConsumerInstallPlan(await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] }));
    await writeFile(`${consumer}/public/fixture-mark.svg`, "drift");
    expect(await inspectConsumerState({ root: consumer })).toMatchObject({ status: "drift", exitCode: 2 });
    const lockPath = `${consumer}/.tfsb/brand.lock.json`;
    await writeFile(lockPath, (await readFile(lockPath, "utf8")).replace('"schemaVersion":1', '"schemaVersion":2'));
    expect(await inspectConsumerState({ root: consumer })).toMatchObject({ status: "invalid", exitCode: 1 });
  });

  it("cross-checks locked profile identity against a supplied verified source", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    await executeConsumerInstallPlan(await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] }));
    const lockPath = `${consumer}/.tfsb/brand.lock.json`;
    const parsed = parseConsumerBrandLock(await readFile(lockPath, "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
    const original = parsed.value;
    const firstPackage = original.packages[0]!;
    const forged = createConsumerBrandLock({
      schema: original.schema,
      schemaVersion: original.schemaVersion,
      consumerProjectDigest: original.consumerProjectDigest,
      packages: [{ ...firstPackage, profiles: [{ ...firstPackage.profiles[0]!, digest: `sha256:${"0".repeat(64)}` }] }],
      toolVersion: original.toolVersion,
    });
    await writeFile(lockPath, serializeConsumerBrandLock(forged));
    expect(await inspectConsumerState({ root: consumer })).toMatchObject({ status: "source-unavailable", exitCode: 0 });
    expect(await inspectConsumerState({ root: consumer, sourceBundles: [producer.archive] })).toMatchObject({ status: "stale", exitCode: 2 });
  });

  it("reports ok with empty inventory on a fresh uninstalled consumer", async () => {
    const consumer = await createConsumerProject(); roots.push(consumer);
    const local = `schema = "tfsb.consumer-profiles"\nschema_version = 1\n[[profiles]]\nid = "local"\nversion = 1\ncompatible_package = "core-fixture-brand"\n[[profiles.outputs]]\nasset = "fixture-mark-on-light"\ndestination = "public/local.svg"\nrequirement = "required"\ncollision = "error"\n`;
    await writeFile(`${consumer}/.tfsb/consumer-profiles.toml`, local);
    const state = await inspectConsumerState({ root: consumer });
    expect(state.status).toBe("ok");
    expect(state.exitCode).toBe(0);
    expect(state.packages).toEqual([]);
    expect(state.mappings).toEqual([]);
    expect(state.localProfiles).toEqual(["core-fixture-brand/local"]);

    const cliCheck = capture();
    expect(await runCli(["consumer", "check", "--root", consumer, "--json"], process.cwd(), cliCheck.io)).toBe(0);
    expect(JSON.parse(cliCheck.stdout())).toMatchObject({ command: "consumer", status: "ok" });

    const cliList = capture();
    expect(await runCli(["consumer", "list", "--root", consumer, "--json"], process.cwd(), cliList.io)).toBe(0);
    expect(JSON.parse(cliList.stdout())).toMatchObject({ command: "consumer", status: "ok" });
  });

  it("detects collision status on explicit-ownership overlap and unsafe destination entry", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    await executeConsumerInstallPlan(await planConsumerInstall({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] }));

    // Explicit project install declaration overlapping with locked destination triggers collision
    const { cp } = await import("node:fs/promises");
    await cp(`${producer.root}/.tfsb/assets/fixture-mark-on-light.toml`, `${consumer}/.tfsb/assets/fixture-mark-on-light.toml`);
    const projectToml = await readFile(`${consumer}/.tfsb/project.toml`, "utf8");
    await writeFile(`${consumer}/.tfsb/project.toml`, `${projectToml}\n[[install]]\nasset = "fixture-mark-on-light"\ndestinations = ["public/fixture-mark.svg"]\n`);
    const collisionOverlap = await inspectConsumerState({ root: consumer });
    expect(collisionOverlap.status).toBe("collision");
    expect(collisionOverlap.exitCode).toBe(2);

    // Restore project.toml
    await writeFile(`${consumer}/.tfsb/project.toml`, projectToml);

    // Symlink destination triggers collision
    const { symlink, unlink } = await import("node:fs/promises");
    await unlink(`${consumer}/public/fixture-mark.svg`);
    await symlink(`${consumer}/GUIDANCE-BRAND.md`, `${consumer}/public/fixture-mark.svg`);
    const collisionSymlink = await inspectConsumerState({ root: consumer });
    expect(collisionSymlink.status).toBe("collision");
    expect(collisionSymlink.exitCode).toBe(2);
  });

  it("routes nested CLI operations with deterministic private-path-free JSON", async () => {
    const producer = await createConsumerBundle(), consumer = await createConsumerProject(); roots.push(producer.root, consumer);
    const install = capture();
    expect(await runCli(["consumer", "install", "--source-bundle", producer.archive, "--profile", PROFILE_ID, "--root", consumer, "--json"], process.cwd(), install.io)).toBe(0);
    expect(JSON.parse(install.stdout())).toMatchObject({ command: "consumer", status: "ok" });
    expect(install.stdout()).not.toContain(producer.archive);
    const check = capture();
    expect(await runCli(["consumer", "check", "--root", consumer, "--json"], process.cwd(), check.io)).toBe(0);
    expect(check.stdout()).toContain("source-unavailable");
    await writeFile(`${consumer}/public/fixture-mark.svg`, "drift");
    const drift = capture();
    expect(await runCli(["consumer", "check", "--root", consumer, "--json"], process.cwd(), drift.io)).toBe(2);
    const invalid = capture();
    expect(await runCli(["consumer", "list", "--source-bundle", producer.archive], consumer, invalid.io)).toBe(1);
    expect(invalid.stderr()).toContain("does not accept source options");
  });
});
