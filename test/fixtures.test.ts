import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseSvg, serializeSvg } from "../src/index.js";
import { readRepoFile, unwrap } from "./helpers.js";

const candidateFixtureDirectory = fileURLToPath(
  new URL("./fixtures/tftn-icon-candidate-v1/", import.meta.url),
);
const candidateFixtures = readdirSync(candidateFixtureDirectory)
  .filter((name) => name.endsWith(".svg"))
  .sort();

const productionFixtureDirectory = fileURLToPath(
  new URL("./fixtures/tftn-production-v1/", import.meta.url),
);
const productionFixtures = readdirSync(productionFixtureDirectory)
  .filter((name) => name.endsWith(".svg"))
  .sort();

describe("Terminal Nova candidate fixture round trips", () => {
  it("covers the exact six checked-in candidate SVG fixtures", () => {
    expect(candidateFixtures).toEqual([
      "favicon.svg",
      "mark-monochrome-dark.svg",
      "mark-monochrome-light.svg",
      "theme-forge-terminal-nova-horizontal.svg",
      "theme-forge-terminal-nova-mark.svg",
      "theme-forge-terminal-nova-stacked.svg",
    ]);
  });

  it.each(candidateFixtures)("round-trips candidate fixture %s semantically and byte-stably", (name) => {
    const original = unwrap(
      parseSvg(readRepoFile(`test/fixtures/tftn-icon-candidate-v1/${name}`), name),
    );
    const canonical = unwrap(serializeSvg(original, name));
    const rebuilt = unwrap(parseSvg(canonical, `canonical:${name}`));
    expect(rebuilt).toEqual(original);
    expect(unwrap(serializeSvg(rebuilt, `repeat:${name}`))).toBe(canonical);
  });
});

describe("Terminal Nova current production fixture round trips", () => {
  it("covers the exact ten checked-in current production SVG fixtures", () => {
    expect(productionFixtures).toEqual([
      "favicon-on-dark.svg",
      "favicon-on-light.svg",
      "mark-monochrome-dark.svg",
      "mark-monochrome-light.svg",
      "theme-forge-terminal-nova-horizontal-on-dark.svg",
      "theme-forge-terminal-nova-horizontal-on-light.svg",
      "theme-forge-terminal-nova-mark-on-dark.svg",
      "theme-forge-terminal-nova-mark-on-light.svg",
      "theme-forge-terminal-nova-stacked-on-dark.svg",
      "theme-forge-terminal-nova-stacked-on-light.svg",
    ]);
  });

  it.each(productionFixtures)("round-trips production fixture %s semantically and byte-stably", (name) => {
    const original = unwrap(
      parseSvg(readRepoFile(`test/fixtures/tftn-production-v1/${name}`), name),
    );
    const canonical = unwrap(serializeSvg(original, name));
    const rebuilt = unwrap(parseSvg(canonical, `canonical:${name}`));
    expect(rebuilt).toEqual(original);
    expect(unwrap(serializeSvg(rebuilt, `repeat:${name}`))).toBe(canonical);
  });
});
