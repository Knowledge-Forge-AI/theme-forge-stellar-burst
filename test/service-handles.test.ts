import { mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { computeSha256 } from "../src/digests.js";
import { computeNormalizationPolicyDigest } from "../src/normalization-policy.js";
import { AuthorityLedger } from "../src/service-protocol/authority-ledger.js";
import { HandleRegistry } from "../src/service-protocol/handles.js";
import { parseNormalizationMap } from "../src/normalization-map.js";
import { computeShardMembershipDigest, serializeShardManifest, SHARD_MEMBERSHIP_BASIS, SHARD_PROFILE, type ShardManifestV1 } from "../src/shard.js";
import { computeSourceMapDigest, parseSourceMap } from "../src/source-map.js";
import { makeTempDir, unwrap } from "./helpers.js";

const roots: string[] = [];
function temp(): string { const root = realpathSync(makeTempDir("tfsb-service-handles-")); roots.push(root); return root; }
function project(root: string): void {
  mkdirSync(join(root, ".tfsb/assets"), { recursive: true });
  writeFileSync(join(root, ".tfsb/project.toml"), 'schema_version = 1\nname = "Handle project"\n\n[build]\ndirectory = "dist"\n');
}
function sourceMap(): string {
  return `schema_version = 1
source_root = "."

[[collection]]
id = "icons"
name = "Icons"
root = "icons"
identity = "basename"
prefix = ""
include_paths = []
include_trees = ["."]
exclude_paths = []
exclude_trees = []
`;
}
function normalizationMap(): string {
  return `schema_version = 1

[defaults]
unlabelled_mode = "decorative"
`;
}
function shardManifest(): string {
  const assets = [
    { sourcePath: "a.svg", assetId: "a", sourceDigest: `sha256:${"a".repeat(64)}`, sourceBytes: 3 },
  ] as const;
  const value: ShardManifestV1 = {
    schemaVersion: 1,
    collectionId: "icons",
    sourceMapBasis: "tfsb-source-map-v1",
    sourceMapDigest: `sha256:${"b".repeat(64)}`,
    sourceSnapshotBasis: "tfsb-directory-snapshot-v1",
    sourceSnapshotDigest: `sha256:${"c".repeat(64)}`,
    membershipBasis: SHARD_MEMBERSHIP_BASIS,
    membershipDigest: computeShardMembershipDigest("icons", assets),
    assetCount: 1,
    selectedBytes: 3,
    profile: SHARD_PROFILE,
    directlyImportable: 1,
    normalizationRequired: 0,
    unsupported: 0,
    unsafe: 0,
    assets,
  };
  return serializeShardManifest(value);
}
function code(error: unknown): string | undefined { return (error as { symbolicCode?: string }).symbolicCode; }

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("studio session-local root handles", () => {
  it("rejects wrong-kind, random, and cross-registry handles", async () => {
    const root = temp(); project(root); const source = join(root, "source"); mkdirSync(source); writeFileSync(join(source, "a.svg"), "<svg/>");
    const first = new HandleRegistry(); const second = new HandleRegistry();
    const openedProject = await first.openProject(root) as { projectHandle: string };
    const openedSource = await first.openSource(source) as { sourceHandle: string };
    await expect(first.source(openedProject.projectHandle)).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_HANDLE_INVALID");
    await expect(first.project(openedSource.sourceHandle)).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_HANDLE_INVALID");
    await expect(first.project("project_random")).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_HANDLE_INVALID");
    await expect(second.project(openedProject.projectHandle)).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_HANDLE_INVALID");
  });

  it("rejects symlink roots and intermediate components", async () => {
    const root = temp(); const actual = join(root, "actual"); project(actual);
    const direct = join(root, "project-link"); symlinkSync(actual, direct, "dir");
    await expect(new HandleRegistry().openProject(direct)).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_INVALID");
    const parent = join(root, "parent"); mkdirSync(parent); const linkedParent = join(root, "parent-link"); symlinkSync(parent, linkedParent, "dir");
    project(join(parent, "child"));
    await expect(new HandleRegistry().openProject(join(linkedParent, "child"))).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_INVALID");
  });

  it("invalidates a handle when the opened root is persistently retargeted", async () => {
    const parent = temp(); const root = join(parent, "project"); project(root);
    const registry = new HandleRegistry(); const opened = await registry.openProject(root) as { projectHandle: string };
    renameSync(root, join(parent, "original")); project(root);
    await expect(registry.project(opened.projectHandle)).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_INVALID");
  });

  it("preserves existing defaults and returns the closed import-target variant", async () => {
    const root = temp(); project(root);
    const registry = new HandleRegistry();
    const existing = await registry.openProject(root) as Record<string, unknown>;
    expect(existing).toMatchObject({ rootKind: "project", schemaVersion: 1, name: "Handle project" });
    expect(existing).not.toHaveProperty("state");

    const target = join(root, "target"); mkdirSync(target);
    const opened = await registry.openProject(target, "import-target") as Record<string, unknown>;
    expect(Object.keys(opened).sort()).toEqual(["projectHandle", "rootKind", "state"]);
    expect(opened).toMatchObject({ rootKind: "project", state: "uninitialized" });
    const handle = opened.projectHandle as string;
    await expect(registry.project(handle)).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_HANDLE_INVALID");
    expect(() => registry.laneFor("project", handle)).toThrow();
    await expect(registry.importTarget(handle)).resolves.toMatchObject({ state: "uninitialized", root: target });
    mkdirSync(join(target, ".tfsb"));
    await expect(registry.importTarget(handle)).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_INVALID");

    const replacement = join(root, "replacement"); mkdirSync(replacement);
    const replacementOpened = await registry.openProject(replacement, "import-target") as { readonly projectHandle: string };
    renameSync(replacement, join(root, "replacement-original")); mkdirSync(replacement);
    await expect(registry.importTarget(replacementOpened.projectHandle)).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_INVALID");
  });

  it("opens all typed auxiliary purposes with production semantic digests", async () => {
    const root = temp();
    const mapPath = join(root, "map.toml");
    const normalizationPath = join(root, "normalization.toml");
    const shardPath = join(root, "shard.toml");
    writeFileSync(mapPath, sourceMap()); writeFileSync(normalizationPath, normalizationMap()); writeFileSync(shardPath, shardManifest());
    const registry = new HandleRegistry();

    const sourceMapResult = await registry.openSource(mapPath, { purpose: "source-map" }) as Record<string, unknown>;
    const normalizationResult = await registry.openSource(normalizationPath, { purpose: "normalization-map" }) as Record<string, unknown>;
    const shardResult = await registry.openSource(shardPath, { purpose: "shard-manifest" }) as Record<string, unknown>;
    for (const result of [sourceMapResult, normalizationResult, shardResult]) {
      expect(Object.keys(result).sort()).toEqual(["authorityKind", "byteDigest", "byteLength", "capabilities", "rootKind", "semanticDigest", "sourceHandle"]);
      expect(result).toMatchObject({ rootKind: "source", capabilities: { analyze: false, mutationAuthority: true } });
    }
    expect(sourceMapResult.authorityKind).toBe("source-map");
    expect(normalizationResult.authorityKind).toBe("normalization-map");
    expect(shardResult.authorityKind).toBe("shard-manifest");
    const mapValue = (await registry.auxiliarySource(sourceMapResult.sourceHandle as string, "source-map"));
    const normalizationValue = (await registry.auxiliarySource(normalizationResult.sourceHandle as string, "normalization-map"));
    const shardValue = (await registry.auxiliarySource(shardResult.sourceHandle as string, "shard-manifest"));
    expect(mapValue.bytes).toBe(mapValue.snapshot.bytes);
    expect(mapValue.byteDigest).toBe(computeSha256(mapValue.bytes));
    expect(mapValue.semanticDigest).toBe(computeSourceMapDigest(unwrap(parseSourceMap(sourceMap()))));
    expect(normalizationValue.semanticDigest).toBe(computeNormalizationPolicyDigest(unwrap(parseNormalizationMap(normalizationMap()))));
    expect(shardValue.semanticDigest).toBe(computeSha256(Buffer.from(shardManifest(), "utf8")));
  });

  it("rejects cross-kind, wrong-purpose, unsafe, malformed, and oversized auxiliary sources", async () => {
    const root = temp(); const source = join(root, "source"); mkdirSync(source); writeFileSync(join(source, "a.svg"), "<svg/>");
    const mapPath = join(root, "map.toml"); writeFileSync(mapPath, sourceMap());
    const registry = new HandleRegistry();
    const content = await registry.openSource(source) as { readonly sourceHandle: string };
    const auxiliary = await registry.openSource(mapPath, "source-map") as { readonly sourceHandle: string };
    await expect(registry.auxiliarySource(content.sourceHandle, "source-map")).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_HANDLE_INVALID");
    await expect(registry.auxiliarySource(auxiliary.sourceHandle, "normalization-map")).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_HANDLE_INVALID");
    await expect(registry.auxiliarySource("source_random", "source-map")).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_HANDLE_INVALID");

    const linkedParent = join(root, "linked"); symlinkSync(root, linkedParent, "dir");
    await expect(registry.openSource(join(linkedParent, "map.toml"), "source-map")).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_INVALID");
    writeFileSync(mapPath, Buffer.from([0xff, 0xfe]));
    await expect(new HandleRegistry().openSource(mapPath, "source-map")).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_INVALID");
    writeFileSync(mapPath, "schema_version = 1\n");
    await expect(new HandleRegistry().openSource(mapPath, "source-map")).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_INVALID");
    writeFileSync(mapPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    await expect(new HandleRegistry().openSource(mapPath, "source-map")).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_INVALID");
  });

  it("rejects auxiliary byte drift and releases shared ledger reservations exactly once", async () => {
    const root = temp(); const mapPath = join(root, "map.toml"); writeFileSync(mapPath, sourceMap());
    const bytes = Buffer.byteLength(sourceMap(), "utf8");
    const ledger = new AuthorityLedger({ maxRetainedBytes: bytes });
    const registry = new HandleRegistry(ledger);
    const opened = await registry.openSource(mapPath, "source-map") as { readonly sourceHandle: string };
    expect(ledger.retainedBytes).toBe(bytes);
    await expect(registry.openSource(mapPath, "source-map")).rejects.toSatisfy((error: unknown) => code(error) === "REQUEST_BUSY");
    writeFileSync(mapPath, `${sourceMap()}\n# formatting-only drift\n`);
    await expect(registry.auxiliarySource(opened.sourceHandle, "source-map")).rejects.toSatisfy((error: unknown) => code(error) === "ROOT_INVALID");
    registry.clear(); registry.clear();
    expect(ledger.retainedBytes).toBe(0);
    expect(ledger.activeReservations).toBe(0);
    writeFileSync(mapPath, sourceMap());
    await expect(registry.openSource(mapPath, "source-map")).resolves.toMatchObject({ authorityKind: "source-map" });
  });

  it("derives only the fixed source-contained map path for a directory content handle", async () => {
    const root = temp(); const source = join(root, "source"); mkdirSync(source); writeFileSync(join(source, "a.svg"), "<svg/>");
    const registry = new HandleRegistry();
    const opened = await registry.openSource(source) as { readonly sourceHandle: string };
    await expect(registry.sourceContainedMapPath(opened.sourceHandle)).resolves.toBe(join(source, ".tfsb-source-map.toml"));
    const archiveLike = join(root, "not-directory"); writeFileSync(archiveLike, "not zip");
    await expect(registry.openSource(archiveLike)).rejects.toThrow();
  });
});
