import { describe, expect, it } from "vitest";

import { parseAssetToml, parseProjectToml, parseSvg } from "../src/index.js";
import { readRepoFile, unwrap } from "./helpers.js";

const examples = [
  ["favicon", "favicon.svg"],
  ["mark", "theme-forge-terminal-nova-mark.svg"],
  ["lockup-horizontal", "theme-forge-terminal-nova-horizontal.svg"],
] as const;

describe("checked-in example language", () => {
  it.each(["check-result.json", "reconcile-result.json", "preview-result.json"])("parses the v0.2 %s machine-result example", (name) => {
    const value = JSON.parse(readRepoFile(`docs/examples/v0.2/${name}`)) as Record<string, unknown>;
    expect(value.schemaVersion).toBe(1);
    expect(["check", "reconcile", "preview"]).toContain(value.command);
    expect(value).toHaveProperty("diagnostics");
    expect(value).toHaveProperty("data");
  });

  it("parses the v0.2 provenance.json example", () => {
    const value = JSON.parse(readRepoFile("docs/examples/v0.2/provenance.json")) as Record<string, unknown>;
    expect(value.kind).toBe("tfsb-import-provenance");
    expect(value.schemaVersion).toBe(1);
    expect(Array.isArray(value.records)).toBe(true);
  });

  it("parses the v0.2 tfsb-manifest.json example", () => {
    const value = JSON.parse(readRepoFile("docs/examples/v0.2/tfsb-manifest.json")) as Record<string, unknown>;
    expect(value.kind).toBe("tfsb-bundle-manifest");
    expect(value.schemaVersion).toBe(1);
    expect(value.generator).toEqual({
      name: "@knowledge-forge-ai/theme-forge-stellar-burst",
      version: "0.2.0",
    });
  });

  it("parses v0.1 project.toml", () => {
    const project = unwrap(parseProjectToml(readRepoFile("docs/examples/v0.1/project.toml")));
    expect(project.name).toBe("Theme Forge Terminal Nova");
  });

  it("parses v0.2 project.toml with unchanged schema-1 parser", () => {
    const project = unwrap(parseProjectToml(readRepoFile("docs/examples/v0.2/project.toml")));
    expect(project.name).toBe("theme-forge-terminal-nova");
    expect(project.schemaVersion).toBe(1);
  });

  it.each(examples)("normalizes %s TOML to the fixture SVG model", (asset, fixture) => {
    const fromToml = unwrap(
      parseAssetToml(readRepoFile(`docs/examples/v0.1/assets/${asset}.toml`), `${asset}.toml`),
    );
    const fromSvg = unwrap(
      parseSvg(
        readRepoFile(`test/fixtures/tftn-icon-candidate-v1/${fixture}`),
        fixture,
      ),
    );
    expect(fromToml.svg).toEqual(fromSvg);
  });

  it("validates the README representative asset TOML example", () => {
    const readme = readRepoFile("README.md");
    const match = readme.match(
      /### Asset configuration \(`\.tfsb\/assets\/favicon\.toml`\)\s+```toml\n([\s\S]*?)```/,
    );
    expect(match).not.toBeNull();
    const asset = unwrap(parseAssetToml(match![1]!, "README.md:favicon.toml"));
    expect(asset.id).toBe("favicon");
    expect(asset.filename).toBe("favicon.svg");
    expect(asset.svg.accessibility.title).toBe("Application Favicon");
    expect(asset.svg.accessibility.titleId).toBe("app-favicon-title");
    expect(asset.svg.accessibility.description).toBe("Application brand favicon.");
    expect(asset.svg.accessibility.descriptionId).toBe("app-favicon-desc");
  });

  it("validates the README representative project TOML examples", () => {
    const readme = readRepoFile("README.md");
    const projectMatch = readme.match(
      /### Project configuration \(`\.tfsb\/project\.toml`\)\s+```toml\n([\s\S]*?)```/,
    );
    expect(projectMatch).not.toBeNull();
    const project = unwrap(parseProjectToml(projectMatch![1]!, "README.md:project.toml"));
    expect(project.name).toBe("My Application Brand");
    expect(project.installs).toHaveLength(1);

    const companionMatch = readme.match(
      /Then configure the companion installation in `\.tfsb\/project\.toml`:\s+```toml\n([\s\S]*?)```/,
    );
    expect(companionMatch).not.toBeNull();
    const combined = `${projectMatch![1]!}\n${companionMatch![1]!}`;
    const combinedProject = unwrap(parseProjectToml(combined, "README.md:combined.toml"));
    expect(combinedProject.companions).toHaveLength(1);
    expect(combinedProject.companions[0]?.file).toBe("README.md");
    expect(combinedProject.companions[0]?.destinations).toEqual(["README-BRAND.md"]);
  });
});
