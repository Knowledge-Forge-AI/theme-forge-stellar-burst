import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BUNDLE_MANIFEST_FILENAME,
  BUNDLE_MANIFEST_KIND,
  BUNDLE_MANIFEST_SCHEMA_VERSION,
  parseBundleManifest,
  serializeBundleManifest,
  unwrapBundleManifest,
  type BundleManifestV1,
} from "../src/index.js";
import { readRepoFile, unwrap } from "./helpers.js";

describe("bundle manifest parser and serializer", () => {
  it("parses the checked-in docs/examples/v0.2/tfsb-manifest.json example", () => {
    const json = readRepoFile("docs/examples/v0.2/tfsb-manifest.json");
    const manifest = unwrapBundleManifest(parseBundleManifest(json));
    expect(manifest.kind).toBe("tfsb-bundle-manifest");
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.generator.name).toBe("@knowledge-forge-ai/theme-forge-stellar-burst");
    expect(manifest.generator.version).toBe("0.2.0");
    expect(manifest.projectName).toBe("theme-forge-terminal-nova");
    expect(manifest.files).toHaveLength(4);
    expect(manifest.files[0]?.name).toBe("README.md");
    expect(manifest.files[0]?.type).toBe("companion");
    expect(manifest.files[1]?.name).toBe("favicon-on-light.svg");
    expect(manifest.files[1]?.type).toBe("asset");
  });

  it("round-trips the checked-in manifest byte-stably", () => {
    const json = readRepoFile("docs/examples/v0.2/tfsb-manifest.json");
    const manifest = unwrapBundleManifest(parseBundleManifest(json));
    const serialized = serializeBundleManifest(manifest);
    expect(serialized).toBe(json);
  });

  it("serializes with fixed key ordering, 2-space indentation, and final LF", () => {
    const manifest: BundleManifestV1 = {
      kind: "tfsb-bundle-manifest",
      schemaVersion: 1,
      generator: {
        name: "@knowledge-forge-ai/theme-forge-stellar-burst",
        version: "0.1.0",
      },
      projectName: "sample-project",
      files: [
        {
          type: "companion",
          name: "LICENSE.txt",
          sha256: "a".repeat(64),
        },
        {
          type: "asset",
          name: "icon.svg",
          assetId: "icon" as any,
          sha256: "b".repeat(64),
        },
      ],
    };
    const serialized = serializeBundleManifest(manifest);
    expect(serialized.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(serialized);
    expect(Object.keys(parsed)).toEqual(["kind", "schemaVersion", "generator", "projectName", "files"]);
    expect(Object.keys(parsed.generator)).toEqual(["name", "version"]);
    expect(Object.keys(parsed.files[0])).toEqual(["type", "name", "sha256"]);
    expect(Object.keys(parsed.files[1])).toEqual(["type", "name", "assetId", "sha256"]);
  });

  it("sorts files by UTF-8 byte order on serialization", () => {
    const manifest: BundleManifestV1 = {
      kind: "tfsb-bundle-manifest",
      schemaVersion: 1,
      generator: {
        name: "@knowledge-forge-ai/theme-forge-stellar-burst",
        version: "0.1.0",
      },
      files: [
        {
          type: "asset",
          name: "zeta.svg",
          assetId: "zeta" as any,
          sha256: "1".repeat(64),
        },
        {
          type: "companion",
          name: "ALPHA.txt",
          sha256: "2".repeat(64),
        },
        {
          type: "asset",
          name: "beta.svg",
          assetId: "beta" as any,
          sha256: "3".repeat(64),
        },
      ],
    };
    const serialized = serializeBundleManifest(manifest);
    const reparsed = unwrapBundleManifest(parseBundleManifest(serialized));
    expect(reparsed.files.map((f) => f.name)).toEqual(["ALPHA.txt", "beta.svg", "zeta.svg"]);
  });
});

describe("bundle manifest validation failure matrix", () => {
  const validManifest = {
    kind: "tfsb-bundle-manifest",
    schemaVersion: 1,
    generator: {
      name: "@knowledge-forge-ai/theme-forge-stellar-burst",
      version: "0.1.0",
    },
    projectName: "valid-project",
    files: [
      {
        type: "companion",
        name: "README.md",
        sha256: "0".repeat(64),
      },
      {
        type: "asset",
        name: "logo.svg",
        assetId: "logo",
        sha256: "1".repeat(64),
      },
    ],
  };

  const expectFailure = (input: unknown, code: string) => {
    const json = typeof input === "string" ? input : JSON.stringify(input);
    const result = parseBundleManifest(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.code).toBe(code);
    }
  };

  it("rejects invalid JSON", () => {
    expectFailure("{ invalid json }", "MANIFEST_INVALID_JSON");
  });

  it("rejects non-object root", () => {
    expectFailure("[]", "MANIFEST_INVALID_TYPE");
    expectFailure('"hello"', "MANIFEST_INVALID_TYPE");
  });

  it("rejects unknown top-level fields", () => {
    expectFailure({ ...validManifest, unknownField: "bad" }, "MANIFEST_UNKNOWN_FIELD");
  });

  it("rejects unsupported kind", () => {
    expectFailure({ ...validManifest, kind: "other-kind" }, "MANIFEST_UNSUPPORTED_KIND");
  });

  it("rejects unsupported schemaVersion", () => {
    expectFailure({ ...validManifest, schemaVersion: 2 }, "MANIFEST_UNSUPPORTED_VERSION");
  });

  it("rejects invalid generator structure or unknown fields", () => {
    expectFailure({ ...validManifest, generator: "string" }, "MANIFEST_INVALID_TYPE");
    expectFailure(
      { ...validManifest, generator: { name: "pkg", version: "1.0", extra: true } },
      "MANIFEST_UNKNOWN_FIELD",
    );
    expectFailure(
      { ...validManifest, generator: { name: "", version: "1.0" } },
      "MANIFEST_INVALID_GENERATOR",
    );
    expectFailure(
      { ...validManifest, generator: { name: "pkg", version: "   " } },
      "MANIFEST_INVALID_GENERATOR",
    );
  });

  it("rejects invalid projectName", () => {
    expectFailure({ ...validManifest, projectName: "   " }, "MANIFEST_INVALID_PROJECT_NAME");
    expectFailure({ ...validManifest, projectName: "bad\nname" }, "MANIFEST_INVALID_PROJECT_NAME");
  });

  it("rejects invalid record types", () => {
    expectFailure(
      {
        ...validManifest,
        files: [{ type: "unknown", name: "test.txt", sha256: "0".repeat(64) }],
      },
      "MANIFEST_INVALID_RECORD_TYPE",
    );
  });

  it("rejects unknown record fields", () => {
    expectFailure(
      {
        ...validManifest,
        files: [{ type: "companion", name: "README.md", sha256: "0".repeat(64), extra: true }],
      },
      "MANIFEST_UNKNOWN_FIELD",
    );
    expectFailure(
      {
        ...validManifest,
        files: [{ type: "asset", name: "logo.svg", assetId: "logo", sha256: "0".repeat(64), extra: true }],
      },
      "MANIFEST_UNKNOWN_FIELD",
    );
  });

  it("rejects invalid assetId", () => {
    expectFailure(
      {
        ...validManifest,
        files: [{ type: "asset", name: "logo.svg", assetId: "Logo_Invalid", sha256: "0".repeat(64) }],
      },
      "MANIFEST_INVALID_ASSET_ID",
    );
    expectFailure(
      {
        ...validManifest,
        files: [{ type: "asset", name: "logo.svg", assetId: "logo--double", sha256: "0".repeat(64) }],
      },
      "MANIFEST_INVALID_ASSET_ID",
    );
  });

  it("rejects asset filename without .svg", () => {
    expectFailure(
      {
        ...validManifest,
        files: [{ type: "asset", name: "logo.png", assetId: "logo", sha256: "0".repeat(64) }],
      },
      "MANIFEST_INVALID_FILENAME",
    );
  });

  it("rejects unsupported companion filename", () => {
    expectFailure(
      {
        ...validManifest,
        files: [{ type: "companion", name: "script.js", sha256: "0".repeat(64) }],
      },
      "MANIFEST_INVALID_FILENAME",
    );
  });

  it("rejects nested or unsafe paths", () => {
    expectFailure(
      {
        ...validManifest,
        files: [{ type: "asset", name: "sub/logo.svg", assetId: "logo", sha256: "0".repeat(64) }],
      },
      "MANIFEST_INVALID_FILENAME",
    );
    expectFailure(
      {
        ...validManifest,
        files: [{ type: "asset", name: "../logo.svg", assetId: "logo", sha256: "0".repeat(64) }],
      },
      "MANIFEST_INVALID_FILENAME",
    );
  });

  it("rejects reserved manifest filename as data entry", () => {
    expectFailure(
      {
        ...validManifest,
        files: [{ type: "companion", name: "tfsb-manifest.json", sha256: "0".repeat(64) }],
      },
      "MANIFEST_INVALID_FILENAME",
    );
  });

  it("rejects invalid sha256 digests", () => {
    expectFailure(
      {
        ...validManifest,
        files: [{ type: "companion", name: "README.md", sha256: "0".repeat(63) }],
      },
      "MANIFEST_INVALID_DIGEST",
    );
    expectFailure(
      {
        ...validManifest,
        files: [{ type: "companion", name: "README.md", sha256: "A".repeat(64) }],
      },
      "MANIFEST_INVALID_DIGEST",
    );
    expectFailure(
      {
        ...validManifest,
        files: [{ type: "companion", name: "README.md", sha256: `sha256:${"0".repeat(64)}` }],
      },
      "MANIFEST_INVALID_DIGEST",
    );
  });

  it("rejects duplicate asset IDs", () => {
    expectFailure(
      {
        ...validManifest,
        files: [
          { type: "asset", name: "a-logo.svg", assetId: "logo", sha256: "0".repeat(64) },
          { type: "asset", name: "b-logo.svg", assetId: "logo", sha256: "1".repeat(64) },
        ],
      },
      "MANIFEST_COLLISION",
    );
  });

  it("rejects portable entry name collisions", () => {
    expectFailure(
      {
        ...validManifest,
        files: [
          { type: "companion", name: "readme.md", sha256: "0".repeat(64) },
          { type: "companion", name: "README.MD", sha256: "1".repeat(64) },
        ],
      },
      "MANIFEST_COLLISION",
    );
  });

  it("rejects unsorted files array", () => {
    expectFailure(
      {
        ...validManifest,
        files: [
          { type: "asset", name: "zebra.svg", assetId: "zebra", sha256: "0".repeat(64) },
          { type: "asset", name: "apple.svg", assetId: "apple", sha256: "1".repeat(64) },
        ],
      },
      "MANIFEST_UNSORTED_FILES",
    );
  });
});
