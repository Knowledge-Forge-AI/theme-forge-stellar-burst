import { describe, expect, it } from "vitest";

import {
  computeSourceMapDigest,
  parseSourceMap,
  serializeSourceMap,
} from "../src/index.js";
import { firstCode, readRepoFile, unwrap } from "./helpers.js";

const examples = [
  "terminal-nova-source-map.toml",
  "simple-icons-source-map.toml",
  "lucide-source-map.toml",
  "tabler-source-map.toml",
  "collision-override-source-map.toml",
] as const;
const vectors: Readonly<Record<(typeof examples)[number], string>> = {
  "terminal-nova-source-map.toml": "sha256:c5f42e8e133378c737c557b96c510d62905a541f6eecf9cc3396ef7c4c4d2064",
  "simple-icons-source-map.toml": "sha256:c6e3749f4116e2d2edc0f14455aeaf7dd20ce83332dbe95b85e602a4ff877e89",
  "lucide-source-map.toml": "sha256:1d7bb317ea2a84f9551cd0607473a1e9f5ca54e8deb2eba5f50607745dc1d5db",
  "tabler-source-map.toml": "sha256:50be30153e6338cb724460ffb09d591d759a4246dc2f4604e486ab2f76917533",
  "collision-override-source-map.toml": "sha256:5a7f07e48597c32ef83ff5df5573a9763119c0bcad41e9d6d184e9f55b921e1a",
};

describe("source-map schema 1", () => {
  it("canonically converges every TFSB41 source-map example", () => {
    for (const name of examples) {
      const parsed = unwrap(parseSourceMap(readRepoFile(`docs/examples/v0.4/${name}`), name));
      const canonical = serializeSourceMap(parsed);
      expect(serializeSourceMap(unwrap(parseSourceMap(canonical)))).toBe(canonical);
      expect(computeSourceMapDigest(unwrap(parseSourceMap(canonical)))).toBe(computeSourceMapDigest(parsed));
      expect(computeSourceMapDigest(parsed)).toBe(vectors[name]);
      expect(canonical.endsWith("\n")).toBe(true);
      expect(canonical.endsWith("\n\n")).toBe(false);
    }
  });

  it("does not reflect an absolute parser label into diagnostics", () => {
    const result = parseSourceMap("invalid", "/private/source-map.toml");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("/private/");
  });

  it("makes formatting and comments non-semantic but semantic edits authoritative", () => {
    const compact = `schema_version=1\nsource_root="."\n[[collection]]\nid="icons"\nname="Icons"\nroot="icons"\nidentity="basename"\nprefix=""\ninclude_paths=[]\ninclude_trees=["."]\nexclude_paths=[]\nexclude_trees=[]\n`;
    const formatted = `# comment\nschema_version = 1\nsource_root = "."\n\n[[collection]]\nname = "Icons"\nid = "icons"\nroot = "icons"\nidentity = "basename"\nprefix = ""\ninclude_paths = []\ninclude_trees = [ "." ]\nexclude_paths = []\nexclude_trees = []\n`;
    const changed = formatted.replace('name = "Icons"', 'name = "Other"');
    expect(computeSourceMapDigest(unwrap(parseSourceMap(compact)))).toBe(computeSourceMapDigest(unwrap(parseSourceMap(formatted))));
    expect(computeSourceMapDigest(unwrap(parseSourceMap(changed)))).not.toBe(computeSourceMapDigest(unwrap(parseSourceMap(formatted))));
  });

  it("rejects open schema, duplicate TOML keys, unsupported strategy, and invalid root", () => {
    const base = readRepoFile("docs/examples/v0.4/simple-icons-source-map.toml");
    expect(firstCode(parseSourceMap(`${base}\nunknown = true\n`))).toBe("SOURCE_MAP_UNKNOWN_FIELD");
    expect(firstCode(parseSourceMap(base.replace("schema_version = 1", "schema_version = 1\nschema_version = 1")))).toBe("SOURCE_MAP_INVALID_TOML");
    expect(firstCode(parseSourceMap(base.replace('identity = "basename"', 'identity = "hybrid"')))).toBe("SOURCE_MAP_INVALID_IDENTITY");
    expect(firstCode(parseSourceMap(base.replace('source_root = "."', 'source_root = ".."')))).toBe("SOURCE_MAP_INVALID_ROOT");
    expect(firstCode(parseSourceMap(base.replace('include_trees = ["."]', 'include_trees = ["icons", "icons"]')))).toBe("SOURCE_MAP_PATH_COLLISION");
    expect(firstCode(parseSourceMap(base.replace('prefix = ""', 'prefix = "not-terminated"')))).toBe("SOURCE_MAP_INVALID_PREFIX");
    expect(firstCode(parseSourceMap(base.replace('include_trees = ["."]', 'include_trees = []')))).toBe("SOURCE_MAP_EMPTY_SELECTION");
  });

  it("requires entries to be exactly overrides or reasoned exclusions", () => {
    const base = readRepoFile("docs/examples/v0.4/collision-override-source-map.toml");
    expect(firstCode(parseSourceMap(base.replace('asset_id = "a-b-flat"', 'asset_id = "a-b-flat"\nunknown = true')))).toBe("SOURCE_MAP_INVALID_ENTRY");
    expect(firstCode(parseSourceMap(base.replace('asset_id = "a-b-flat"', 'asset_id = "a-b-flat"\nexclude = true\nreason = "mixed"')))).toBe("SOURCE_MAP_INVALID_ENTRY");
  });

  it("rejects normalization and bundle documents as source maps", () => {
    expect(parseSourceMap(readRepoFile("docs/examples/v0.3/normalization-map-schema-1.toml")).ok).toBe(false);
    expect(parseSourceMap('schema_version = 1\nkind = "tfsb-bundle-manifest"\n').ok).toBe(false);
  });
});
