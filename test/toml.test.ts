import { describe, expect, it } from "vitest";

import { parseAssetToml, parseProjectToml } from "../src/index.js";
import { firstCode, readRepoFile, unwrap } from "./helpers.js";

const VALID_ASSET = `
schema_version = 1
id = "sample"
filename = "sample.svg"

[canvas]
width = 10
height = 10
view_box = "0 0 10 10"

[accessibility]
title = "Sample"
title_id = "sample-title"
description = "Sample description"
description_id = "sample-desc"

[[elements]]
type = "path"
d = "M0 0L10 10"
`;

describe("schema-1 TOML decoding", () => {
  it("parses the checked-in project and asset examples", () => {
    const project = unwrap(
      parseProjectToml(readRepoFile("docs/examples/v0.1/project.toml"), "project.toml"),
    );
    expect(project.installs).toHaveLength(3);
    for (const name of ["favicon", "mark", "lockup-horizontal"]) {
      expect(
        parseAssetToml(
          readRepoFile(`docs/examples/v0.1/assets/${name}.toml`),
          `${name}.toml`,
        ).ok,
      ).toBe(true);
    }
  });

  it.each([
    ["unsupported version", VALID_ASSET.replace("schema_version = 1", "schema_version = 2"), "SCHEMA_UNSUPPORTED_VERSION"],
    ["missing field", VALID_ASSET.replace('view_box = "0 0 10 10"\n', ""), "SCHEMA_MISSING_KEY"],
    ["unknown root key", `${VALID_ASSET}\nunknown = true\n`, "SCHEMA_UNKNOWN_KEY"],
    ["unknown nested key", VALID_ASSET.replace('view_box = "0 0 10 10"', 'view_box = "0 0 10 10"\nunknown = true'), "SCHEMA_UNKNOWN_KEY"],
    ["invalid enum", VALID_ASSET.replace("view_box = \"0 0 10 10\"", "view_box = \"0 0 10 10\"\nshape_rendering = \"pretty\""), "SCHEMA_INVALID_ENUM"],
    ["invalid dimension", VALID_ASSET.replace("width = 10", "width = 0"), "SCHEMA_INVALID_RANGE"],
    ["invalid viewBox extent", VALID_ASSET.replace("0 0 10 10", "0 0 -10 10"), "SCHEMA_INVALID_RANGE"],
    ["hex or binary viewBox number", VALID_ASSET.replace('view_box = "0 0 10 10"', 'view_box = "0 0 0x20 0b1010"'), "SCHEMA_INVALID_NUMBER"],
    ["unsupported transform", VALID_ASSET.replace("d = \"M0 0L10 10\"", "d = \"M0 0L10 10\"\ntransform = \"rotate(5)\""), "SCHEMA_INVALID_TRANSFORM"],
    ["comma-separated transform", VALID_ASSET.replace("d = \"M0 0L10 10\"", "d = \"M0 0L10 10\"\ntransform = \"translate(1, 2)\""), "SCHEMA_INVALID_TRANSFORM"],
  ])("rejects %s", (_name, text, code) => {
    expect(firstCode(parseAssetToml(text))).toBe(code);
  });

  it("rejects a fallback without gradient paint", () => {
    const text = VALID_ASSET.replace(
      'd = "M0 0L10 10"',
      'fill = "#000000"\nfill_fallback = "#FFFFFF"\nd = "M0 0L10 10"',
    );
    expect(firstCode(parseAssetToml(text))).toBe("SCHEMA_INVALID_PAINT_FALLBACK");
  });

  it("rejects malformed group unions", () => {
    const text = VALID_ASSET.replace(
      'type = "path"\nd = "M0 0L10 10"',
      'type = "group"\npaths = [{ d = "M0 0L1 1" }]\nuses = [{ href = "#p" }]',
    );
    expect(firstCode(parseAssetToml(text))).toBe("SCHEMA_INVALID_UNION");
  });

  it("keeps definition groups paths-only", () => {
    const text = VALID_ASSET.replace(
      "[[elements]]",
      '[definitions]\ngroups = [{ id = "bad", uses = [{ href = "#p" }] }]\n\n[[elements]]',
    );
    expect(firstCode(parseAssetToml(text))).toBe("SCHEMA_UNKNOWN_KEY");
  });

  it("requires named path definitions", () => {
    const text = VALID_ASSET.replace(
      "[[elements]]",
      '[definitions]\npaths = [{ d = "M0 0L1 1" }]\n\n[[elements]]',
    );
    expect(firstCode(parseAssetToml(text))).toBe("SCHEMA_MISSING_KEY");
  });

  it("rejects duplicate install declarations and destinations", () => {
    const base = `
schema_version = 1
name = "Example"
[build]
directory = "brand/dist"
`;
    const duplicateAsset = `${base}
[[install]]
asset = "mark"
destinations = ["docs/a.svg"]
[[install]]
asset = "mark"
destinations = ["docs/b.svg"]
`;
    expect(firstCode(parseProjectToml(duplicateAsset))).toBe("SCHEMA_DUPLICATE_INSTALL");

    const duplicateDestination = `${base}
[[install]]
asset = "mark"
destinations = ["docs/a.svg"]
[[install]]
asset = "favicon"
destinations = ["docs/a.svg"]
`;
    expect(firstCode(parseProjectToml(duplicateDestination))).toBe(
      "SCHEMA_DUPLICATE_DESTINATION",
    );

    const emptyDestinations = `${base}\n[[install]]\nasset = "mark"\ndestinations = []\n`;
    expect(firstCode(parseProjectToml(emptyDestinations))).toBe("SCHEMA_INVALID_RANGE");
  });

  it("rejects unsupported project schema versions before field decoding", () => {
    expect(firstCode(parseProjectToml("schema_version = 2\nunknown = true\n"))).toBe(
      "SCHEMA_UNSUPPORTED_VERSION",
    );
  });

  it("rejects malformed TOML without exposing parser exception text", () => {
    const result = parseAssetToml("schema_version = [");
    expect(firstCode(result)).toBe("TOML_SYNTAX");
    if (!result.ok) expect(result.diagnostics[0]?.message).toBe("Invalid TOML syntax.");
  });
});
