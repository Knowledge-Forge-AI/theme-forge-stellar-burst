import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildProject, installProject } from "../../src/index.js";
import { createConsumerBundle, createConsumerProject } from "./consumer-test-helper.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function adoptionConsumer(producerRoot: string): Promise<string> {
  const root = await createConsumerProject();
  await cp(`${producerRoot}/.tfsb/assets/fixture-mark-on-light.toml`, `${root}/.tfsb/assets/fixture-mark-on-light.toml`);
  await mkdir(`${root}/.tfsb/companions`, { recursive: true });
  await cp(`${producerRoot}/GUIDANCE.md`, `${root}/.tfsb/companions/GUIDANCE.md`);
  const project = `${root}/.tfsb/project.toml`;
  await writeFile(project, `${await readFile(project, "utf8")}\n[[install]]\nasset = "fixture-mark-on-light"\ndestinations = ["public/fixture-mark.svg"]\n\n[[companion]]\nfile = "GUIDANCE.md"\ndestinations = ["GUIDANCE-BRAND.md"]\n`);
  await buildProject(root); await installProject(root);
  return root;
}

describe("packed consumer distribution", () => {
  it("qualifies local-bundle, npm-installed, and adoption consumers from the candidate tarball", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "tfsb-consumer-packed-")); roots.push(scratch);
    const producer = await createConsumerBundle({ npmPackage: { name: "@fixture/core-brand", version: "0.4.0-fixture.1" } }); roots.push(producer.root);
    const localRoot = await createConsumerProject(), npmRoot = await createConsumerProject(), adoptRoot = await adoptionConsumer(producer.root); roots.push(localRoot, npmRoot, adoptRoot);
    const carrier = join(scratch, "carrier"); await mkdir(join(carrier, "brand"), { recursive: true });
    await writeFile(join(carrier, "package.json"), JSON.stringify({ name: "@fixture/core-brand", version: "0.4.0-fixture.1" }));
    await cp(producer.archive, join(carrier, "brand", "tfsb-brand-bundle.zip"));

    const packDestination = join(scratch, "pack"); await mkdir(packDestination);
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", packDestination], { cwd: process.cwd(), encoding: "utf8" })) as [{ filename: string }];
    const packageRoot = join(scratch, "node_modules", "@knowledge-forge-ai", "theme-forge-stellar-burst"); await mkdir(packageRoot, { recursive: true });
    execFileSync("tar", ["-xzf", join(packDestination, packed[0]!.filename), "--strip-components=1", "-C", packageRoot]);
    for (const dependency of ["@xmldom", "fflate", "smol-toml"]) {
      const source = join(process.cwd(), "node_modules", dependency), target = join(scratch, "node_modules", dependency);
      if (existsSync(source) && !existsSync(target)) await symlink(source, target);
    }
    const modulePath = join(packageRoot, "dist", "index.js"), script = join(scratch, "qualify.mjs");
    await writeFile(script, `
import assert from "node:assert/strict";
import * as api from ${JSON.stringify(modulePath)};
const profile = "core-fixture-brand/basic";
const localRoot = ${JSON.stringify(localRoot)}, npmRoot = ${JSON.stringify(npmRoot)}, adoptRoot = ${JSON.stringify(adoptRoot)};
const archive = ${JSON.stringify(producer.archive)}, carrier = ${JSON.stringify(carrier)};
const localPlan = await api.planConsumerInstall({ root: localRoot, sourceBundles: [archive], profiles: [profile] });
await api.executeConsumerInstallPlan(localPlan);
assert.equal((await api.inspectConsumerState({ root: localRoot })).status, "source-unavailable");
assert.equal((await api.inspectConsumerState({ root: localRoot, sourceBundles: [archive] })).status, "ok");
assert.equal((await api.executeConsumerSyncPlan(await api.planConsumerSync({ root: localRoot, sourceBundles: [archive] }))).writtenOutputs, 0);
await api.executeConsumerInstallPlan(await api.planConsumerInstall({ root: npmRoot, sourcePackages: [carrier], profiles: [profile] }));
assert.equal((await api.inspectConsumerState({ root: npmRoot, sourcePackages: [carrier] })).status, "ok");
const beforeAsset = await (await import("node:fs/promises")).readFile(adoptRoot + "/public/fixture-mark.svg");
await api.executeConsumerAdoptionPlan(await api.planConsumerAdoption({ root: adoptRoot, sourceBundles: [archive], profiles: [profile] }));
assert.deepEqual(await (await import("node:fs/promises")).readFile(adoptRoot + "/public/fixture-mark.svg"), beforeAsset);
assert.equal((await api.inspectConsumerState({ root: adoptRoot, sourceBundles: [archive] })).status, "ok");
assert.equal("getVerifiedConsumerPackageAuthority" in api, false);
`);
    execFileSync(process.execPath, [script], { cwd: scratch, stdio: "pipe" });
    expect(await readFile(join(localRoot, "GUIDANCE-BRAND.md"), "utf8")).toContain("Core Fixture");
    expect(await readFile(join(npmRoot, ".tfsb", "brand.lock.json"), "utf8")).toContain('"kind":"npm-installed"');
  }, 30_000);
});
