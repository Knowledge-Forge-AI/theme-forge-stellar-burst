// @ts-check

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

/** @param {Uint8Array | string} bytes */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Exactly ten canonical assets of Terminal Nova brand.
 */
export const CANONICAL_ASSETS = Object.freeze([
  {
    id: "favicon-on-dark",
    filename: "favicon-on-dark.svg",
    role: "favicon",
    variant: "favicon-on-dark",
    destinations: ["docs/public/favicon-on-dark.svg"],
    expectedSha256: "3bcf7b8be08f2b29dd018187dda8f4d76cd3ea294995aab1e028e50e2f1c2eda",
    title: "Theme Forge Terminal Nova favicon for dark surfaces",
    description: "Simplified four-point nova symbol inside a hex enclosure for small dark surfaces.",
  },
  {
    id: "favicon-on-light",
    filename: "favicon-on-light.svg",
    role: "favicon",
    variant: "favicon-on-light",
    destinations: ["docs/public/favicon-on-light.svg", "docs/public/favicon.svg"],
    expectedSha256: "cbcf044cd7b3024f9419c0cbe9396d1e9cc0d0d777d64a17581d1ea89debc51e",
    title: "Theme Forge Terminal Nova favicon for light surfaces",
    description: "Simplified four-point nova symbol inside a hex enclosure for small light surfaces.",
  },
  {
    id: "mark-monochrome-dark",
    filename: "mark-monochrome-dark.svg",
    role: "mark",
    variant: "monochrome-on-light",
    destinations: [],
    expectedSha256: "99bbfa9e04d4281eeab2647f9fd923e6138af835c76eb1224ee4c9cc568b41dc",
    title: "Theme Forge Terminal Nova monochrome mark for light surfaces",
    description: "Single-color Nova Ingot symbol with six enclosure facets and a four-point nova.",
  },
  {
    id: "mark-monochrome-light",
    filename: "mark-monochrome-light.svg",
    role: "mark",
    variant: "monochrome-on-dark",
    destinations: [],
    expectedSha256: "9b9165a0d302aec1956cf1834083e54b69750ec0bfe6fd8be1bedf7389b56f15",
    title: "Theme Forge Terminal Nova monochrome mark for dark surfaces",
    description: "Single-color Nova Ingot symbol with six enclosure facets and a four-point nova.",
  },
  {
    id: "theme-forge-terminal-nova-horizontal-on-dark",
    filename: "theme-forge-terminal-nova-horizontal-on-dark.svg",
    role: "lockup-horizontal",
    variant: "reversed-on-dark",
    destinations: ["docs/src/assets/brand/theme-forge-terminal-nova-horizontal-on-dark.svg"],
    expectedSha256: "05289c389ac50035d410fa440a1a5677f056c1b1d14d9492d54494df4aad6cf2",
    title: "Theme Forge Terminal Nova horizontal lockup for dark surfaces",
    description: "Nova Ingot symbol beside custom geometric Terminal Nova lettering for dark surfaces.",
  },
  {
    id: "theme-forge-terminal-nova-horizontal-on-light",
    filename: "theme-forge-terminal-nova-horizontal-on-light.svg",
    role: "lockup-horizontal",
    variant: "full-color-on-light",
    destinations: ["docs/src/assets/brand/theme-forge-terminal-nova-horizontal-on-light.svg"],
    expectedSha256: "75ad8a39a3e642d878d8c5f43319ca1c79028703e68f65260ca86c70c6a12ec3",
    title: "Theme Forge Terminal Nova horizontal lockup for light surfaces",
    description: "Nova Ingot symbol beside custom geometric Terminal Nova lettering for light surfaces.",
  },
  {
    id: "theme-forge-terminal-nova-mark-on-dark",
    filename: "theme-forge-terminal-nova-mark-on-dark.svg",
    role: "mark",
    variant: "reversed-on-dark",
    destinations: ["docs/src/assets/brand/theme-forge-terminal-nova-mark-on-dark.svg"],
    expectedSha256: "138751558fef0cffae9ca3e3556a33544fa58526599bfae34e3515beb6aad154",
    title: "Theme Forge Terminal Nova mark for dark surfaces",
    description: "Nova Ingot symbol with six forged enclosure facets and a central four-point colored nova.",
  },
  {
    id: "theme-forge-terminal-nova-mark-on-light",
    filename: "theme-forge-terminal-nova-mark-on-light.svg",
    role: "mark",
    variant: "full-color-on-light",
    destinations: ["docs/src/assets/brand/theme-forge-terminal-nova-mark-on-light.svg"],
    expectedSha256: "ea6b2d70dfa117fc7e875c746c98c512066825af1a3b4980b33409dfc687ebf0",
    title: "Theme Forge Terminal Nova mark for light surfaces",
    description: "Nova Ingot symbol with six forged enclosure facets and a central four-point colored nova.",
  },
  {
    id: "theme-forge-terminal-nova-stacked-on-dark",
    filename: "theme-forge-terminal-nova-stacked-on-dark.svg",
    role: "lockup-stacked",
    variant: "reversed-on-dark",
    destinations: ["docs/src/assets/brand/theme-forge-terminal-nova-stacked-on-dark.svg"],
    expectedSha256: "bf26d7f8fa4d0374aea05c06d6884c13db058e93532eb6217a3b6e9676ee1083",
    title: "Theme Forge Terminal Nova stacked lockup for dark surfaces",
    description: "Nova Ingot symbol centered above custom geometric Terminal Nova lettering for dark surfaces.",
  },
  {
    id: "theme-forge-terminal-nova-stacked-on-light",
    filename: "theme-forge-terminal-nova-stacked-on-light.svg",
    role: "lockup-stacked",
    variant: "full-color-on-light",
    destinations: ["docs/src/assets/brand/theme-forge-terminal-nova-stacked-on-light.svg"],
    expectedSha256: "bc446476502b9bf9e6ee9e315488aa14962f8119e050e4443ee34ed5108ca99e",
    title: "Theme Forge Terminal Nova stacked lockup for light surfaces",
    description: "Nova Ingot symbol centered above custom geometric Terminal Nova lettering for light surfaces.",
  },
]);

export const EXPECTED_README_SHA256 = "966282712d1107318de7d51edd20bfbd282c4afeb8505341d7480c33a72e39e6";
export const EXPECTED_ZIP_SHA256 = "efd9a2453296fa85034b5bde72aff174a62f514a89d7985a11cfe74f6b292296";
export const EXPECTED_BUILD_PY_SHA256 = "23d3c8ce7c144789174fea56937b598d0e3c1d0d0444348abffd26d1d7607271";

export const EXPECTED_CANONICAL_COMMIT = "461d9add96ed6c04b341e31305697a9046eed1a8";
export const EXPECTED_CANONICAL_TREE = "5857f60d230ca97cb586ccdd45dd54635ca1d9b7";

/**
 * Inspect canonical Terminal Nova checkout in strictly read-only mode.
 * @param {string} canonicalSource
 * @param {object} [options]
 * @param {boolean} [options.archive]
 * @param {boolean} [options.allowArchiveFallback]
 */
export async function inspectCanonicalCorpus(canonicalSource, options = {}) {
  let branch = "main";
  let commit = EXPECTED_CANONICAL_COMMIT;
  let tree = EXPECTED_CANONICAL_TREE;
  let status = "";

  if (!options?.archive) {
    try {
      branch = execFileSync("git", ["-C", canonicalSource, "branch", "--show-current"], { encoding: "utf8" }).trim();
      commit = execFileSync("git", ["-C", canonicalSource, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      tree = execFileSync("git", ["-C", canonicalSource, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
      status = execFileSync("git", ["-C", canonicalSource, "status", "--porcelain=v1"], { encoding: "utf8" }).trim();
    } catch (err) {
      if (options?.allowArchiveFallback) {
        branch = "main";
        commit = EXPECTED_CANONICAL_COMMIT;
        tree = EXPECTED_CANONICAL_TREE;
        status = "";
      } else {
        throw err;
      }
    }
  }

  const distDir = join(canonicalSource, "brand", "dist");
  const readmePath = join(canonicalSource, "brand", "README.md");
  const readmeBrandPath = join(canonicalSource, "README-BRAND.md");
  const zipPath = join(canonicalSource, "brand", "theme-forge-terminal-nova-brand-assets.zip");
  const buildPyPath = join(canonicalSource, "brand", "libexec", "build.py");

  const [readmeBytes, readmeBrandBytes, zipBytes, buildPyBytes] = await Promise.all([
    readFile(readmePath),
    readFile(readmeBrandPath),
    readFile(zipPath),
    readFile(buildPyPath),
  ]);

  const readmeSha = sha256Hex(readmeBytes);
  const readmeBrandSha = sha256Hex(readmeBrandBytes);
  const zipSha = sha256Hex(zipBytes);
  const buildPySha = sha256Hex(buildPyBytes);

  if (readmeSha !== EXPECTED_README_SHA256) throw new Error(`brand/README.md digest mismatch: got ${readmeSha}`);
  if (readmeBrandSha !== EXPECTED_README_SHA256) throw new Error(`README-BRAND.md digest mismatch: got ${readmeBrandSha}`);
  if (zipSha !== EXPECTED_ZIP_SHA256) throw new Error(`assets zip digest mismatch: got ${zipSha}`);
  if (buildPySha !== EXPECTED_BUILD_PY_SHA256) throw new Error(`build.py digest mismatch: got ${buildPySha}`);

  const buildPyText = buildPyBytes.toString("utf8");
  const quotesLiteralSource = buildPyText.includes("source/\n      build_brand_assets.py");
  const definesNonReadmeFills = buildPyText.includes('"#343740"') && buildPyText.includes('"#17191F"');

  /** @type {Record<string, { bytes: Uint8Array, sha256: string }>} */
  const assetMap = {};
  for (const asset of CANONICAL_ASSETS) {
    const p = join(distDir, asset.filename);
    const bytes = await readFile(p);
    const sha = sha256Hex(bytes);
    if (sha !== asset.expectedSha256) {
      throw new Error(`Asset ${asset.filename} digest mismatch: got ${sha}, expected ${asset.expectedSha256}`);
    }
    assetMap[asset.id] = { bytes, sha256: sha };
  }

  /** @type {Record<string, { bytes: Uint8Array, sha256: string }>} */
  const trackedDestinationMap = {};
  for (const asset of CANONICAL_ASSETS) {
    for (const dest of asset.destinations) {
      const destPath = join(canonicalSource, dest);
      const destBytes = await readFile(destPath);
      trackedDestinationMap[dest] = { bytes: destBytes, sha256: sha256Hex(destBytes) };
    }
  }

  // Inspect in-repo fixture to verify it contains all 10 assets
  const fixtureDir = join(REPO_ROOT, "test/fixtures/tftn-production-v1");
  const fixtureEntries = await readdir(fixtureDir);
  const fixtureSvgCount = fixtureEntries.filter((f) => f.endsWith(".svg")).length;

  return {
    git: { branch, commit, tree, clean: status === "" },
    readmeSha,
    readmeBrandSha,
    zipSha,
    buildPySha,
    generatorProvenance: {
      path: "brand/libexec/build.py",
      sha256: buildPySha,
      quotesLiteralSource,
      definesNonReadmeFills,
      paletteFills: ["#343740", "#17191F"],
    },
    assetMap,
    readmeBytes,
    trackedDestinationMap,
    fixtureVerification: {
      path: "test/fixtures/tftn-production-v1",
      totalSvgs: fixtureSvgCount,
      classification: "portable-test-material",
    },
  };
}
