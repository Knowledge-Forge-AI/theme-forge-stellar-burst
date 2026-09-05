import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bundleBrandProject, compareBrandSnapshots, importBrandProject } from "../../src/index.js";
import { inspectVerifiedBrandArchive } from "../../src/brand/brand-import.js";
import { createConsumerBundle, PROFILE_TOML } from "./consumer-test-helper.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("consumer profiles in bundle and import", () => {
  it("cross-checks manifest records and preserves exact profile bytes through import and rebundle", async () => {
    const producer = await createConsumerBundle(); roots.push(producer.root);
    const snapshot = await inspectVerifiedBrandArchive({ archive: producer.archive, root: producer.root });
    expect(snapshot.brand.consumerProfilesModel?.profiles[0]?.qualifiedId).toBe("core-fixture-brand/basic");

    const imported = await mkdtemp(join(tmpdir(), "tfsb-consumer-import-")); roots.push(imported);
    const plan = await importBrandProject({ archive: producer.archive, root: imported });
    expect(plan.consumerProfilesModel?.profiles).toHaveLength(1);
    expect(await readFile(join(imported, ".tfsb", "consumer-profiles.toml"), "utf8")).toBe(PROFILE_TOML);
    const rebundle = await bundleBrandProject({ root: imported, output: "rebundle.zip" });
    expect(rebundle.domainCount).toBeGreaterThan(1);
    const again = await inspectVerifiedBrandArchive({ archive: join(imported, "rebundle.zip"), root: imported });
    expect(again.brand.consumerProfilesModel).toEqual(snapshot.brand.consumerProfilesModel);
    expect(again.brand.consumerProfilesDigest).toBe(snapshot.brand.consumerProfilesDigest);
  });

  it("emits typed consumer profile and domain changes in the existing diff section", async () => {
    const before = await createConsumerBundle(), after = await createConsumerBundle({ profileToml: PROFILE_TOML.replace('id = "basic"\nversion = 1', 'id = "basic"\nversion = 2') }); roots.push(before.root, after.root);
    const result = compareBrandSnapshots(await inspectVerifiedBrandArchive({ archive: before.archive, root: before.root }), await inspectVerifiedBrandArchive({ archive: after.archive, root: after.root }));
    expect(result.consumerProfiles.status).toBe("available");
    expect(result.consumerProfiles.records.map((entry) => entry.id)).toEqual(["core-fixture-brand/basic", "domain"]);
    expect(result.consumerProfiles.records.every((entry) => entry.change === "changed")).toBe(true);
  });
});
