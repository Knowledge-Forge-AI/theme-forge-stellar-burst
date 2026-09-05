import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeDirectorySnapshot,
  createDirectorySnapshot,
} from "../src/directory-snapshot.js";
import {
  SHARD_MEMBERSHIP_BASIS,
  SHARD_PROFILE,
  computeShardMembershipDigest,
  disposeShardManifestOutputPlan,
  parseShardManifest,
  planShard,
  planShardManifestOutput,
  publishShardManifest,
  serializeShardManifest,
  type ShardManifestV1,
} from "../src/shard.js";
import { parseSourceMap } from "../src/source-map.js";
import { firstCode, unwrap } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const DIGEST_A = `sha256:${"a".repeat(64)}` as const;
const DIGEST_B = `sha256:${"b".repeat(64)}` as const;
const DIGEST_C = `sha256:${"c".repeat(64)}` as const;

function manifest(): ShardManifestV1 {
  const assets = [
    { sourcePath: "a.svg", assetId: "a", sourceDigest: DIGEST_A, sourceBytes: 3 },
    { sourcePath: "b.svg", assetId: "b", sourceDigest: DIGEST_B, sourceBytes: 5 },
  ] as const;
  return {
    schemaVersion: 1,
    collectionId: "icons",
    sourceMapBasis: "tfsb-source-map-v1",
    sourceMapDigest: DIGEST_A,
    sourceSnapshotBasis: "tfsb-directory-snapshot-v1",
    sourceSnapshotDigest: DIGEST_B,
    membershipBasis: SHARD_MEMBERSHIP_BASIS,
    membershipDigest: computeShardMembershipDigest("icons", assets),
    assetCount: 2,
    selectedBytes: 8,
    profile: SHARD_PROFILE,
    directlyImportable: 1,
    normalizationRequired: 1,
    unsupported: 0,
    unsafe: 0,
    assets,
  };
}

function sourceMap(identity = "basename") {
  return unwrap(parseSourceMap(`schema_version = 1
source_root = "."

[[collection]]
id = "icons"
name = "Icons"
root = "icons"
identity = "${identity}"
prefix = ""
include_paths = []
include_trees = ["."]
exclude_paths = []
exclude_trees = []
`));
}

function directSvg(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" role="img" aria-labelledby="title desc"><title id="title">Title</title><desc id="desc">Description</desc><path d="M0 0L1 1"/></svg>`;
}

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-shard-"));
  roots.push(root);
  await mkdir(join(root, "icons"), { recursive: true });
  await Promise.all(Object.entries(files).map(([path, contents]) => writeFile(join(root, "icons", path), contents)));
  return realpath(root);
}

describe("shard manifest schema 1", () => {
  it("canonicalizes fixed fields and uses the frozen membership vector", () => {
    const value = manifest();
    const reversed = { ...value, assets: [...value.assets].reverse() };
    const canonical = serializeShardManifest(reversed);
    expect(canonical).toContain("schema_version = 1\ncollection_id = \"icons\"");
    expect(canonical.indexOf('source_path = "a.svg"')).toBeLessThan(canonical.indexOf('source_path = "b.svg"'));
    expect(canonical.endsWith("\n")).toBe(true);
    expect(canonical.endsWith("\n\n")).toBe(false);
    expect(serializeShardManifest(unwrap(parseShardManifest(canonical)))).toBe(canonical);
    expect(computeShardMembershipDigest("icons", value.assets)).toBe("sha256:1df182c94f1a9e2341032520d42e872163a7d9114600cc8908298a2fcf3c5050");
    expect(canonical).not.toContain("normalization_policy_");
  });

  it("normalizes reordered assets and validates optional policy fields as a pair", () => {
    const canonical = serializeShardManifest(manifest());
    const marker = "\n[[asset]]\n";
    const [header, first, second] = canonical.split(marker);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const reordered = `${header}${marker}${second!.trimEnd()}${marker}${first!.trimEnd()}\n`;
    expect(serializeShardManifest(unwrap(parseShardManifest(reordered)))).toBe(canonical);
    expect(firstCode(parseShardManifest(canonical.replace(
      "\n[[asset]]",
      '\nnormalization_policy_basis = "tfsb-normalization-policy-v1"\n\n[[asset]]',
    )))).toBe("SHARD_INVALID_NORMALIZATION_SUMMARY");
  });

  it("rejects unknown/version/tampered summary and digest fields", () => {
    const canonical = serializeShardManifest(manifest());
    expect(firstCode(parseShardManifest(`unknown = true\n${canonical}`))).toBe("SHARD_UNKNOWN_FIELD");
    expect(firstCode(parseShardManifest(canonical.replace("schema_version = 1", "schema_version = 2")))).toBe("SHARD_UNSUPPORTED_VERSION");
    expect(firstCode(parseShardManifest(canonical.replace("asset_count = 2", "asset_count = 1")))).toBe("SHARD_SUMMARY_MISMATCH");
    expect(firstCode(parseShardManifest(canonical.replace("selected_bytes = 8", "selected_bytes = 9")))).toBe("SHARD_SUMMARY_MISMATCH");
    expect(firstCode(parseShardManifest(canonical.replace(/membership_digest = "[^"]+"/, `membership_digest = "${DIGEST_C}"`)))).toBe("SHARD_MEMBERSHIP_MISMATCH");
    expect(firstCode(parseShardManifest(canonical
      .replace("directly_importable = 1", "directly_importable = 0")
      .replace("unsupported = 0", "unsupported = 1")))).toBe("SHARD_UNMATERIALIZABLE");
  });

  it("rejects path and ID duplicates while keeping membership independent of bytes", () => {
    const canonical = serializeShardManifest(manifest());
    expect(firstCode(parseShardManifest(canonical.replace('source_path = "b.svg"', 'source_path = "a.svg"')))).toBe("SHARD_DUPLICATE_SOURCE_PATH");
    expect(firstCode(parseShardManifest(canonical.replace('asset_id = "b"', 'asset_id = "a"')))).toBe("SHARD_DUPLICATE_ASSET_ID");

    const parsed = unwrap(parseShardManifest(canonical));
    const changed: ShardManifestV1 = {
      ...parsed,
      selectedBytes: 9,
      assets: parsed.assets.map((asset, index) => index === 0 ? { ...asset, sourceBytes: 4, sourceDigest: DIGEST_C } : asset),
    };
    expect(computeShardMembershipDigest(changed)).toBe(parsed.membershipDigest);
    expect(unwrap(parseShardManifest(serializeShardManifest(changed))).membershipDigest).toBe(parsed.membershipDigest);
  });
});

describe("read-only shard planning", () => {
  it("plans exact collection-relative paths with real analyzer classifications", async () => {
    const root = await fixture({
      "nested.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Needs a label</title><path d="M0 0L1 1"/></svg>',
      "direct.svg": directSvg(),
    });
    const result = await planShard(root, sourceMap(), "icons", ["nested.svg", "direct.svg"]);
    const planned = unwrap(result);
    expect(planned.assets.map((asset) => asset.sourcePath)).toEqual(["direct.svg", "nested.svg"]);
    expect(planned.assets.map((asset) => asset.assetId)).toEqual(["direct", "nested"]);
    expect(planned.assetCount).toBe(2);
    expect(planned.directlyImportable).toBe(1);
    expect(planned.normalizationRequired).toBe(1);
    expect(planned.unsupported).toBe(0);
    expect(planned.unsafe).toBe(0);
    expect(planned.selectedBytes).toBe(Buffer.byteLength(directSvg()) + Buffer.byteLength('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Needs a label</title><path d="M0 0L1 1"/></svg>'));
    expect(JSON.stringify(planned)).not.toContain(root);
    expect(planned.normalizationPolicyDigest).toBeUndefined();

    const authenticated = unwrap(await createDirectorySnapshot(root, sourceMap(), ["icons"], {
      selectedPaths: ["icons/nested.svg", "icons/direct.svg"],
    }));
    try {
      expect(planned.sourceSnapshotDigest).toBe(authenticated.inventoryDigest);
    } finally {
      closeDirectorySnapshot(authenticated);
    }
  });

  it("fails closed for unsafe and unsupported selected sources", async () => {
    const unsafeRoot = await fixture({ "unsafe.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script><path d="M0 0L1 1"/></svg>' });
    expect(firstCode(await planShard(unsafeRoot, sourceMap(), "icons", ["unsafe.svg"]))).toBe("SHARD_UNSAFE_SOURCE");
    const unsupportedRoot = await fixture({ "unsupported.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><symbol id="s"><path d="M0 0L1 1"/></symbol></svg>' });
    expect(firstCode(await planShard(unsupportedRoot, sourceMap(), "icons", ["unsupported.svg"]))).toBe("SHARD_UNSUPPORTED_SOURCE");
  });

  it("enforces numeric ceilings for asset count and byte limits during parsing and planning", async () => {
    const canonical = serializeShardManifest(manifest());
    // Parse bounds: asset count 0 and 129
    expect(firstCode(parseShardManifest(canonical.replace("asset_count = 2", "asset_count = 0")))).toBe("RESOURCE_LIMIT_EXCEEDED");
    expect(firstCode(parseShardManifest(canonical.replace("asset_count = 2", "asset_count = 129")))).toBe("RESOURCE_LIMIT_EXCEEDED");
    // Parse bounds: aggregate bytes > 32 MiB
    expect(firstCode(parseShardManifest(canonical.replace("selected_bytes = 8", `selected_bytes = ${32 * 1024 * 1024 + 1}`)))).toBe("RESOURCE_LIMIT_EXCEEDED");
    // Parse bounds: single asset bytes > 8 MiB
    expect(firstCode(parseShardManifest(canonical.replace("source_bytes = 3", `source_bytes = ${8 * 1024 * 1024 + 1}`)))).toBe("RESOURCE_LIMIT_EXCEEDED");

    // Plan bounds: > 128 paths
    const tooManyPaths = Array.from({ length: 129 }, (_, i) => `icon-${i}.svg`);
    const root = await fixture({ "direct.svg": directSvg() });
    expect(firstCode(await planShard(root, sourceMap(), "icons", tooManyPaths))).toBe("RESOURCE_LIMIT_EXCEEDED");

    // Plan bounds: selection aggregate bytes > 32 MiB
    const largeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Big</title><desc>${"x".repeat(8 * 1024 * 1024 - 100)}</desc><path d="M0 0L1 1"/></svg>`;
    const bigRoot = await fixture({
      "big1.svg": largeSvg,
      "big2.svg": largeSvg,
      "big3.svg": largeSvg,
      "big4.svg": largeSvg,
      "big5.svg": largeSvg,
    });
    expect(firstCode(await planShard(bigRoot, sourceMap(), "icons", ["big1.svg", "big2.svg", "big3.svg", "big4.svg", "big5.svg"]))).toBe("RESOURCE_LIMIT_EXCEEDED");
  });
});

describe("shard manifest output", () => {
  it("publishes only to an absent sibling target and never overwrites", async () => {
    const root = await fixture({ "direct.svg": directSvg() });
    const value = manifest();
    const unique = root.slice(root.lastIndexOf("/") + 1);
    const target = join(dirname(root), `${unique}-manifest.toml`);
    roots.push(target);
    const plan = await planShardManifestOutput(value, target, root);
    await publishShardManifest(plan);
    const before = await readFile(target, "utf8");
    expect(before).toBe(serializeShardManifest(value));
    await expect(planShardManifestOutput(value, target, root)).rejects.toMatchObject({ diagnostic: { code: "SHARD_OUTPUT_EXISTS" } });
    expect(await readFile(target, "utf8")).toBe(before);
    await expect(planShardManifestOutput(value, join(root, "inside.toml"), root)).rejects.toMatchObject({ diagnostic: { code: "SHARD_OUTPUT_INVALID" } });

    const outputParent = join(dirname(root), `${unique}-output`);
    await mkdir(outputParent);
    roots.push(outputParent);
    const changedTarget = join(outputParent, "manifest.toml");
    const changedPlan = await planShardManifestOutput(value, changedTarget, root);
    await rm(outputParent, { recursive: true, force: true });
    await mkdir(outputParent);
    await expect(publishShardManifest(changedPlan)).rejects.toMatchObject({ diagnostic: { code: "SHARD_OUTPUT_INVALID" } });
    expect(await readdir(outputParent)).toEqual([]);
  });

  it("rejects forged or spread output plans lacking authentic private internals", async () => {
    const root = await fixture({ "direct.svg": directSvg() });
    const value = manifest();
    const unique = root.slice(root.lastIndexOf("/") + 1);
    const target = join(dirname(root), `${unique}-spread-target.toml`);
    roots.push(target);
    const plan = await planShardManifestOutput(value, target, root);

    // Spreading a valid plan produces a clone lacking private registry internals
    const spreadPlan = { ...plan };
    await expect(publishShardManifest(spreadPlan)).rejects.toMatchObject({ diagnostic: { code: "SHARD_OUTPUT_INVALID" } });

    // Forging a plan with matching dev/ino/mode is rejected without authentic descriptor handle
    const forgedPlan = {
      manifest: plan.manifest,
      sourceRoot: plan.sourceRoot,
      targetPath: plan.targetPath,
      parentPath: plan.parentPath,
      parentIdentity: { ...plan.parentIdentity },
    };
    await expect(publishShardManifest(forgedPlan as typeof plan)).rejects.toMatchObject({ diagnostic: { code: "SHARD_OUTPUT_INVALID" } });

    // Clean up original plan
    await disposeShardManifestOutputPlan(plan);
  });

  it("rejects publishing the same output plan twice", async () => {
    const root = await fixture({ "direct.svg": directSvg() });
    const value = manifest();
    const unique = root.slice(root.lastIndexOf("/") + 1);
    const target = join(dirname(root), `${unique}-once-target.toml`);
    roots.push(target);
    const plan = await planShardManifestOutput(value, target, root);
    const result = await publishShardManifest(plan);
    expect(result.published).toBe(true);
    expect(result.cleanupResidue).toBeNull();

    // Re-publishing the same plan instance is rejected
    await expect(publishShardManifest(plan)).rejects.toMatchObject({ diagnostic: { code: "SHARD_OUTPUT_INVALID" } });
  });

  it("disposes unconsumed plans safely and idempotently without leaking descriptors", async () => {
    const root = await fixture({ "direct.svg": directSvg() });
    const value = manifest();
    const unique = root.slice(root.lastIndexOf("/") + 1);
    const target = join(dirname(root), `${unique}-dispose-target.toml`);
    roots.push(target);
    const plan = await planShardManifestOutput(value, target, root);
    await disposeShardManifestOutputPlan(plan);
    // Idempotent disposal
    await disposeShardManifestOutputPlan(plan);
    // Disposed plan cannot be published
    await expect(publishShardManifest(plan)).rejects.toMatchObject({ diagnostic: { code: "SHARD_OUTPUT_INVALID" } });
  });

  it("rejects publication if parent directory was deleted without recreation", async () => {
    const root = await fixture({ "direct.svg": directSvg() });
    const value = manifest();
    const unique = root.slice(root.lastIndexOf("/") + 1);
    const outputParent = join(dirname(root), `${unique}-parent-removed`);
    await mkdir(outputParent);
    roots.push(outputParent);
    const target = join(outputParent, "manifest.toml");
    const plan = await planShardManifestOutput(value, target, root);
    await rm(outputParent, { recursive: true, force: true });
    await expect(publishShardManifest(plan)).rejects.toMatchObject({ diagnostic: { code: "SHARD_OUTPUT_INVALID" } });
  });

  it("leaves no partial temporary files on failed publication", async () => {
    const root = await fixture({ "direct.svg": directSvg() });
    const value = manifest();
    const unique = root.slice(root.lastIndexOf("/") + 1);
    const outputParent = join(dirname(root), `${unique}-parent-partial`);
    await mkdir(outputParent);
    roots.push(outputParent);
    const target = join(outputParent, "manifest.toml");
    const plan = await planShardManifestOutput(value, target, root);

    // Create target concurrently to cause EEXIST on publish link
    await writeFile(target, "existing", "utf8");
    await expect(publishShardManifest(plan)).rejects.toMatchObject({ diagnostic: { code: "SHARD_OUTPUT_EXISTS" } });
    const remaining = await readdir(outputParent);
    expect(remaining).toEqual(["manifest.toml"]);
    expect(await readFile(target, "utf8")).toBe("existing");
  });
});
