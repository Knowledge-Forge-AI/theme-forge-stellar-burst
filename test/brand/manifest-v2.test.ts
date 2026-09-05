import { describe, expect, it } from "vitest";

import { computeRawSha256 } from "../../src/digests.js";
import {
  parseBundleManifest,
  parseBundleManifestV2,
  serializeBundleManifestV2,
  type BundleManifestV2,
} from "../../src/index.js";
import { readRepoFile } from "../helpers.js";

describe("generic manifest schema 2 parser, serializer, and version dispatch", () => {
  it("matches golden vector 7 raw bytes and digest", () => {
    const rawJson = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/bundle/tfsb-manifest.json");
    const parsed = parseBundleManifest(rawJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.schemaVersion).toBe(2);
    if (parsed.value.schemaVersion !== 2) return;
    const manifest = parsed.value;
    expect(manifest.kind).toBe("tfsb-bundle-manifest");
    expect(manifest.projectName).toBe("core-fixture");
    expect(manifest.files.length).toBe(5);

    expect(manifest.files[0]).toEqual({
      type: "asset",
      path: "assets/fixture-mark-on-dark.svg",
      assetId: "fixture-mark-on-dark",
      sha256: "1068a15abd03564d4a48257825914baa14ae26990aad96c0c8f46e2d5a27a15b",
    });
    expect(manifest.files[1]).toEqual({
      type: "asset",
      path: "assets/fixture-mark-on-light.svg",
      assetId: "fixture-mark-on-light",
      sha256: "a1bf2b63584d6c5e7832d2e7c29f9137f6f15c4a0d004b9e71c1ee599d75d75f",
    });
    expect(manifest.files[2]).toEqual({
      type: "file",
      path: "brand/brand-package.toml",
      sha256: "d205c6db34f0af25d6657a8133593d1d67b50dda8e4cfc34973450dd141c7bd4",
    });
    expect(manifest.files[3]).toEqual({
      type: "file",
      path: "brand/brand.toml",
      sha256: "1017ebaca28269b4d4397e84bf29696ddea3f615ef1a8e5a6d67606a369c8b41",
    });
    expect(manifest.files[4]).toEqual({
      type: "companion",
      path: "companions/GUIDANCE.md",
      sha256: "10a61401be21913c99086526840a27a24991815db9d7044ac1668787e737a9d3",
    });

    const serialized = serializeBundleManifestV2(manifest);
    expect(serialized).toBe(rawJson);

    const byteDigest = computeRawSha256(Buffer.from(serialized, "utf8"));
    expect(byteDigest).toBe("53ece77670595a24f49bbdfb0af0498e093e5a08366ecaff090814a02c9f70e8");
  });

  it("dispatches between schema 1 and schema 2 cleanly and fails on unknown versions", () => {
    const v1Json = JSON.stringify({
      kind: "tfsb-bundle-manifest",
      schemaVersion: 1,
      generator: { name: "test", version: "1.0.0" },
      files: [
        { type: "asset", name: "test.svg", assetId: "test", sha256: "0".repeat(64) },
      ],
    });
    const parsedV1 = parseBundleManifest(v1Json);
    expect(parsedV1.ok).toBe(true);
    if (parsedV1.ok) expect(parsedV1.value.schemaVersion).toBe(1);

    const v2Json = JSON.stringify({
      kind: "tfsb-bundle-manifest",
      schemaVersion: 2,
      generator: { name: "test", version: "1.0.0" },
      files: [
        { type: "asset", path: "assets/test.svg", assetId: "test", sha256: "0".repeat(64) },
      ],
    });
    const parsedV2 = parseBundleManifest(v2Json);
    expect(parsedV2.ok).toBe(true);
    if (parsedV2.ok) expect(parsedV2.value.schemaVersion).toBe(2);

    const v3Json = JSON.stringify({
      kind: "tfsb-bundle-manifest",
      schemaVersion: 3,
      generator: { name: "test", version: "1.0.0" },
      files: [],
    });
    const parsedV3 = parseBundleManifest(v3Json);
    expect(parsedV3.ok).toBe(false);
    if (!parsedV3.ok) expect(parsedV3.diagnostics[0]!.code).toBe("MANIFEST_UNSUPPORTED_VERSION");
  });

  it("rejects Windows reserved device names in path components", () => {
    const makeV2 = (path: string) => JSON.stringify({
      kind: "tfsb-bundle-manifest",
      schemaVersion: 2,
      generator: { name: "test", version: "1.0.0" },
      files: [{ type: "file", path, sha256: "0".repeat(64) }],
    });

    const reserved = ["con", "prn.txt", "aux.svg", "nul", "com1", "COM9.dat", "lpt1.log"];
    for (const name of reserved) {
      const res = parseBundleManifestV2(makeV2(`brand/${name}`));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.diagnostics[0]!.code).toBe("MANIFEST_INVALID_PATH");
    }
  });

  it("rejects whitespace and trailing dots in path components", () => {
    const makeV2 = (path: string) => JSON.stringify({
      kind: "tfsb-bundle-manifest",
      schemaVersion: 2,
      generator: { name: "test", version: "1.0.0" },
      files: [{ type: "file", path, sha256: "0".repeat(64) }],
    });

    expect(parseBundleManifestV2(makeV2("brand/ test.toml")).ok).toBe(false);
    expect(parseBundleManifestV2(makeV2("brand/test.toml ")).ok).toBe(false);
    expect(parseBundleManifestV2(makeV2("brand/test.toml.")).ok).toBe(false);
  });

  it("detects case-folded / portable path collisions and duplicate asset IDs", () => {
    const collisionJson = JSON.stringify({
      kind: "tfsb-bundle-manifest",
      schemaVersion: 2,
      generator: { name: "test", version: "1.0.0" },
      files: [
        { type: "file", path: "brand/GUIDANCE.md", sha256: "0".repeat(64) },
        { type: "file", path: "brand/guidance.md", sha256: "0".repeat(64) },
      ],
    });
    const resCol = parseBundleManifestV2(collisionJson);
    expect(resCol.ok).toBe(false);
    if (!resCol.ok) expect(resCol.diagnostics[0]!.code).toBe("MANIFEST_COLLISION");

    const duplicateAssetJson = JSON.stringify({
      kind: "tfsb-bundle-manifest",
      schemaVersion: 2,
      generator: { name: "test", version: "1.0.0" },
      files: [
        { type: "asset", path: "assets/dark-mark.svg", assetId: "shared-id", sha256: "0".repeat(64) },
        { type: "asset", path: "assets/light-mark.svg", assetId: "shared-id", sha256: "0".repeat(64) },
      ],
    });
    const resDupAsset = parseBundleManifestV2(duplicateAssetJson);
    expect(resDupAsset.ok).toBe(false);
    if (!resDupAsset.ok) expect(resDupAsset.diagnostics[0]!.code).toBe("MANIFEST_COLLISION");
  });

  it("enforces strict UTF-8 ascending sorting of files array", () => {
    const unsortedJson = JSON.stringify({
      kind: "tfsb-bundle-manifest",
      schemaVersion: 2,
      generator: { name: "test", version: "1.0.0" },
      files: [
        { type: "file", path: "brand/brand.toml", sha256: "0".repeat(64) },
        { type: "asset", path: "assets/mark.svg", assetId: "mark", sha256: "0".repeat(64) },
      ],
    });
    const resUnsorted = parseBundleManifestV2(unsortedJson);
    expect(resUnsorted.ok).toBe(false);
    if (!resUnsorted.ok) expect(resUnsorted.diagnostics[0]!.code).toBe("MANIFEST_UNSORTED_FILES");
  });
});
