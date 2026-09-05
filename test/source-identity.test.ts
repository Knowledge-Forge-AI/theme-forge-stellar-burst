import { describe, expect, it } from "vitest";

import {
  deriveSourceMapId,
  deriveSourceMapIdentities,
  evaluateSourceMapSelection,
  parseSourceMap,
  validatePortablePath,
  type SourceMapV1,
} from "../src/index.js";
import { firstCode, unwrap } from "./helpers.js";

function map(body: string): SourceMapV1 {
  return unwrap(parseSourceMap(`schema_version = 1\nsource_root = "."\n${body}`));
}

const collection = `[[collection]]
id = "icons"
name = "Icons"
root = "icons"
identity = "relative-path"
prefix = ""
include_paths = []
include_trees = ["."]
exclude_paths = []
exclude_trees = []
`;

describe("source-map identity and selection", () => {
  it("derives explicit, basename, and relative-path exact goldens", () => {
    expect(unwrap(deriveSourceMapId("activity.svg", "basename", "outline-"))).toBe("outline-activity");
    expect(unwrap(deriveSourceMapId("brands/30 Seconds/default.svg", "relative-path"))).toBe("brands-30-seconds-default");
    expect(unwrap(deriveSourceMapId("chosen.svg", "explicit", "", "chosen-id"))).toBe("chosen-id");
    expect(firstCode(deriveSourceMapId("chosen.svg", "explicit"))).toBe("SOURCE_IDENTITY_OVERRIDE_REQUIRED");
  });

  it("allows hidden names while rejecting forbidden path forms", () => {
    expect(validatePortablePath(".hidden/file.svg").ok).toBe(true);
    for (const path of ["icons/ leading.svg", "icons/.", "icons/..", "icons/trailing. ", "icons/trailing.", "icons\\bad.svg", "/icons/a.svg", "icons/CON.svg", "icons/a\u0000.svg"]) {
      expect(validatePortablePath(path).ok, path).toBe(false);
    }
  });

  it("fails a relative-path collision and accepts an exact reviewed override", () => {
    const selected = unwrap(evaluateSourceMapSelection(map(collection), [
      { sourcePath: "icons/a/b.svg" },
      { sourcePath: "icons/a-b.svg" },
    ]));
    expect(firstCode(deriveSourceMapIdentities(map(collection), selected))).toBe("SOURCE_IDENTITY_COLLISION");
    const resolvedMap = map(`${collection}\n[[collection.entry]]\nsource_path = "a-b.svg"\nasset_id = "a-b-flat"\n`);
    const resolvedSelection = unwrap(evaluateSourceMapSelection(resolvedMap, [
      { sourcePath: "icons/a/b.svg" }, { sourcePath: "icons/a-b.svg" },
    ]));
    expect(unwrap(deriveSourceMapIdentities(resolvedMap, resolvedSelection)).map((item) => item.assetId)).toEqual(["a-b-flat", "a-b"]);
  });

  it("enforces the exact 64-byte source-map ID boundary without repair", () => {
    expect(unwrap(deriveSourceMapId(`${"a".repeat(64)}.svg`, "basename"))).toHaveLength(64);
    const failed = deriveSourceMapId(`${"a".repeat(65)}.svg`, "basename");
    expect(firstCode(failed)).toBe("SOURCE_IDENTITY_TOO_LONG");
    expect(JSON.stringify(failed)).not.toMatch(/hash|suffix|truncate/i);
    expect(firstCode(deriveSourceMapId("a.svg", "basename", "missing-trailing-hyphen"))).toBe("SOURCE_MAP_INVALID_PREFIX");
  });

  it("makes Tabler same basenames disjoint only through collection prefixes", () => {
    expect(unwrap(deriveSourceMapId("accessible.svg", "basename", "outline-"))).toBe("outline-accessible");
    expect(unwrap(deriveSourceMapId("accessible.svg", "basename", "filled-"))).toBe("filled-accessible");
    expect(unwrap(deriveSourceMapId("accessible.svg", "basename"))).toBe("accessible");
  });

  it("rejects portable-case collisions and cross-collection ownership", () => {
    const one = map(collection);
    expect(firstCode(evaluateSourceMapSelection(one, [
      { sourcePath: "icons/A.svg" }, { sourcePath: "icons/a.svg" },
    ]))).toBe("SOURCE_PATH_COLLISION");
    const two = map(`${collection}\n${collection.replace('id = "icons"', 'id = "other"')}`);
    expect(firstCode(evaluateSourceMapSelection(two, [{ sourcePath: "icons/a.svg" }]))).toBe("SOURCE_PATH_MULTIPLE_COLLECTIONS");
  });

  it("applies path, tree, and reasoned-entry exclusions before identity derivation", () => {
    const selectedMap = map(`[[collection]]
id = "icons"
name = "Icons"
root = "icons"
identity = "basename"
prefix = ""
include_paths = ["exact.svg"]
include_trees = ["tree"]
exclude_paths = ["tree/exact-excluded.svg"]
exclude_trees = ["tree/excluded"]

[[collection.entry]]
source_path = "tree/reasoned.svg"
exclude = true
reason = "Not part of the reviewed collection"
`);
    const selection = unwrap(evaluateSourceMapSelection(selectedMap, [
      { sourcePath: "icons/exact.svg" },
      { sourcePath: "icons/tree/kept.svg" },
      { sourcePath: "icons/tree/exact-excluded.svg" },
      { sourcePath: "icons/tree/excluded/hidden.svg" },
      { sourcePath: "icons/tree/reasoned.svg" },
    ]));
    expect(selection.map((item) => item.sourcePath)).toEqual(["icons/exact.svg", "icons/tree/kept.svg"]);
  });

  it("requires an explicit override for every selected SVG and rejects selected uppercase suffixes", () => {
    const explicit = map(`[[collection]]
id = "icons"
name = "Icons"
root = "icons"
identity = "explicit"
prefix = ""
include_paths = []
include_trees = ["."]
exclude_paths = []
exclude_trees = []

[[collection.entry]]
source_path = "a.svg"
asset_id = "a"
`);
    const selection = unwrap(evaluateSourceMapSelection(explicit, [
      { sourcePath: "icons/a.svg" },
      { sourcePath: "icons/b.svg" },
    ]));
    expect(firstCode(deriveSourceMapIdentities(explicit, selection))).toBe("SOURCE_IDENTITY_OVERRIDE_REQUIRED");
    expect(firstCode(evaluateSourceMapSelection(map(collection), [{ sourcePath: "icons/upper.SVG" }]))).toBe("SOURCE_MAP_INVALID_SVG_PATH");
  });
});
