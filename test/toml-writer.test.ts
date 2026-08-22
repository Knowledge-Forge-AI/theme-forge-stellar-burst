import { describe, expect, it } from "vitest";

import {
  parseAssetToml,
  parseProjectToml,
  serializeAssetToml,
  serializeProjectToml,
} from "../src/index.js";
import { readRepoFile, unwrap } from "./helpers.js";

describe("human-oriented schema-1 TOML writer", () => {
  it("emits deterministic project TOML with stable field order", () => {
    const project = unwrap(
      parseProjectToml(`
name = "Example"
schema_version = 1
[build]
directory = "brand/dist"
[[install]]
destinations = ["docs/b.svg", "docs/a.svg"]
asset = "mark"
`),
    );
    expect(serializeProjectToml(project)).toMatchInlineSnapshot(`
      "schema_version = 1
      name = \"Example\"

      [build]
      directory = \"brand/dist\"

      [[install]]
      asset = \"mark\"
      destinations = [
        \"docs/b.svg\",
        \"docs/a.svg\",
      ]
      "
    `);
    expect(unwrap(parseProjectToml(serializeProjectToml(project)))).toEqual(project);
  });

  it.each(["favicon", "mark", "lockup-horizontal"])(
    "round-trips the curated %s example deterministically",
    (name) => {
      const model = unwrap(
        parseAssetToml(readRepoFile(`docs/examples/v0.1/assets/${name}.toml`)),
      );
      const first = serializeAssetToml(model);
      const second = serializeAssetToml(unwrap(parseAssetToml(first)));
      expect(second).toBe(first);
      expect(unwrap(parseAssetToml(first))).toEqual(model);
    },
  );

  it("keeps generated asset TOML readable and schema-owned", () => {
    const model = unwrap(
      parseAssetToml(readRepoFile("docs/examples/v0.1/assets/mark.toml")),
    );
    const output = serializeAssetToml(model);
    expect(output).toContain("[canvas]");
    expect(output).toContain("[accessibility]");
    expect(output).toContain("stops = [\n  { offset = 0, color = \"#FF8A3D\" },");
    expect(output).toContain('d = """\nM128 76\nC131 106 143 119 174 128');
    expect(output).toContain('description = """\n');
    expect(output).not.toMatch(/xml|attributes|children|node_type/i);
    expect(output.indexOf("[canvas]")).toBeLessThan(output.indexOf("[accessibility]"));
    expect(output.indexOf("[accessibility]")).toBeLessThan(
      output.indexOf("[[definitions.linear_gradients]]"),
    );
  });

  it("escapes U+007F DEL in basic and multiline strings so output remains valid TOML", () => {
    const model = unwrap(
      parseAssetToml(readRepoFile("docs/examples/v0.1/assets/mark.toml")),
    );
    const withDel = {
      ...model,
      svg: {
        ...model.svg,
        accessibility: {
          ...model.svg.accessibility,
          title: "Nova\u007fMark",
        },
      },
    };
    const emitted = serializeAssetToml(withDel);
    expect(emitted).toContain('title = "Nova\\u007FMark"');
    const parsed = unwrap(parseAssetToml(emitted));
    expect(parsed.svg.accessibility.title).toBe("Nova\u007fMark");
  });
});
