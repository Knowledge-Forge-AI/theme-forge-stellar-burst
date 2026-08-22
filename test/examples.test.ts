import { describe, expect, it } from "vitest";

import { parseAssetToml, parseProjectToml, parseSvg } from "../src/index.js";
import { readRepoFile, unwrap } from "./helpers.js";

const examples = [
  ["favicon", "favicon.svg"],
  ["mark", "theme-forge-terminal-nova-mark.svg"],
  ["lockup-horizontal", "theme-forge-terminal-nova-horizontal.svg"],
] as const;

describe("checked-in example language", () => {
  it("parses project.toml", () => {
    const project = unwrap(parseProjectToml(readRepoFile("docs/examples/v0.1/project.toml")));
    expect(project.name).toBe("Theme Forge Terminal Nova");
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
