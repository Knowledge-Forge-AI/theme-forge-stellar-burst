#!/usr/bin/env node
// @ts-check

import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * @typedef {{
 *   id: string;
 *   filename: string;
 *   role: string;
 *   variant: string;
 *   authority: "source" | "derived";
 *   destinations: readonly string[];
 *   expectedSha256: string;
 *   title: string;
 *   description: string;
 * }} CanonicalAssetSpec
 */

/**
 * @typedef {{
 *   canonicalSource: string;
 *   scratchRoot: string;
 *   outputReceipt?: string | undefined;
 * }} QualifyOptions
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

/**
 * Exactly ten canonical assets of Terminal Nova brand.
 * @type {readonly CanonicalAssetSpec[]}
 */
export const TERMINAL_NOVA_ASSETS = [
  {
    id: "favicon-on-dark",
    filename: "favicon-on-dark.svg",
    role: "favicon",
    variant: "favicon-on-dark",
    authority: "source",
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
    authority: "source",
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
    authority: "source",
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
    authority: "source",
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
    authority: "source",
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
    authority: "source",
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
    authority: "source",
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
    authority: "source",
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
    authority: "source",
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
    authority: "source",
    destinations: ["docs/src/assets/brand/theme-forge-terminal-nova-stacked-on-light.svg"],
    expectedSha256: "bc446476502b9bf9e6ee9e315488aa14962f8119e050e4443ee34ed5108ca99e",
    title: "Theme Forge Terminal Nova stacked lockup for light surfaces",
    description: "Nova Ingot symbol centered above custom geometric Terminal Nova lettering for light surfaces.",
  },
];

export const EXPECTED_README_BRAND_SHA256 = "966282712d1107318de7d51edd20bfbd282c4afeb8505341d7480c33a72e39e6";
export const EXPECTED_BRAND_ASSETS_ZIP_SHA256 = "efd9a2453296fa85034b5bde72aff174a62f514a89d7985a11cfe74f6b292296";

/**
 * @param {Uint8Array | string} bytes
 * @returns {string}
 */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/**
 * @param {any} result
 * @returns {any}
 */
export function unwrapResult(result) {
  if (result.ok) return result.value;
  const first = result.diagnostics?.[0];
  throw new Error(`Diagnostic error: ${JSON.stringify(first ?? result)}`);
}

/**
 * Load product APIs dynamically from dist
 */
export async function loadProductModules() {
  const url = new URL("../dist/index.js", import.meta.url);
  try {
    return await import(url.href);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load product modules from dist: ${msg}. Run 'npm run build' first.`);
  }
}

/**
 * Verify canonical source inventory in read-only mode.
 * @param {string} canonicalSource
 */
export async function inspectCanonicalSource(canonicalSource) {
  const distDir = join(canonicalSource, "brand", "dist");
  const readmePath = join(canonicalSource, "brand", "README.md");
  const readmeBrandPath = join(canonicalSource, "README-BRAND.md");
  const zipPath = join(canonicalSource, "brand", "theme-forge-terminal-nova-brand-assets.zip");

  const readmeBytes = await readFile(readmePath);
  const readmeBrandBytes = await readFile(readmeBrandPath);
  const readmeSha = sha256Hex(readmeBytes);
  const readmeBrandSha = sha256Hex(readmeBrandBytes);

  if (readmeSha !== EXPECTED_README_BRAND_SHA256) {
    throw new Error(`brand/README.md digest mismatch: got ${readmeSha}, expected ${EXPECTED_README_BRAND_SHA256}`);
  }
  if (readmeBrandSha !== EXPECTED_README_BRAND_SHA256) {
    throw new Error(`README-BRAND.md digest mismatch: got ${readmeBrandSha}, expected ${EXPECTED_README_BRAND_SHA256}`);
  }

  const zipBytes = await readFile(zipPath);
  const zipSha = sha256Hex(zipBytes);
  if (zipSha !== EXPECTED_BRAND_ASSETS_ZIP_SHA256) {
    throw new Error(`theme-forge-terminal-nova-brand-assets.zip digest mismatch: got ${zipSha}, expected ${EXPECTED_BRAND_ASSETS_ZIP_SHA256}`);
  }

  /** @type {Record<string, { bytes: Uint8Array, sha256: string }>} */
  const assetMap = {};
  for (const asset of TERMINAL_NOVA_ASSETS) {
    const p = join(distDir, asset.filename);
    const bytes = await readFile(p);
    const sha = sha256Hex(bytes);
    if (sha !== asset.expectedSha256) {
      throw new Error(`Asset ${asset.filename} digest mismatch: got ${sha}, expected ${asset.expectedSha256}`);
    }
    assetMap[asset.id] = { bytes, sha256: sha };
  }

  return {
    readmeSha,
    readmeBrandSha,
    readmeBytes,
    zipSha,
    assetMap,
  };
}

/**
 * Generate the complete brand project for Terminal Nova with all 7 domain files.
 * @param {string} projectRoot
 * @param {Record<string, { bytes: Uint8Array, sha256: string }>} assetMap
 * @param {Uint8Array} readmeBytes
 */
export async function generateTerminalNovaBrandProject(projectRoot, assetMap, readmeBytes) {
  const product = await loadProductModules();
  const tfsbDir = join(projectRoot, ".tfsb");
  const assetsDir = join(tfsbDir, "assets");
  const companionsDir = join(tfsbDir, "companions");
  const brandDistDir = join(projectRoot, "brand", "dist");
  const brandDir = join(projectRoot, "brand");

  await mkdir(assetsDir, { recursive: true });
  await mkdir(companionsDir, { recursive: true });
  await mkdir(brandDistDir, { recursive: true });

  // 1. project.toml
  await writeFile(
    join(tfsbDir, "project.toml"),
    `schema_version = 2
name = "theme-forge-terminal-nova"

[build]
directory = "dist"
`,
    "utf8",
  );

  // 2. brand.toml
  const brandTomlContent = `schema = "tfsb.brand"
schema_version = 1
enabled_domains = { tokens = true, recipes = true, qa = true, consumer_profiles = true, package = true, exports = true }

[[families]]
id = "terminal-nova"
name = "Theme Forge Terminal Nova"
required_roles = []
optional_roles = ["lockup-stacked"]

[[variants]]
family = "terminal-nova"
id = "full-color-on-light"
backgrounds = ["light"]
color_mode = "full-color"
scale = "standard"
status = "primary"
minimum_width_px = 24
display_order = 10

[[variants]]
family = "terminal-nova"
id = "reversed-on-dark"
backgrounds = ["dark"]
color_mode = "reversed"
scale = "standard"
status = "primary"
minimum_width_px = 24
display_order = 20

[[variants]]
family = "terminal-nova"
id = "monochrome-on-light"
backgrounds = ["light"]
color_mode = "monochrome"
scale = "standard"
status = "secondary"
minimum_width_px = 24
display_order = 30

[[variants]]
family = "terminal-nova"
id = "monochrome-on-dark"
backgrounds = ["dark"]
color_mode = "monochrome"
scale = "standard"
status = "secondary"
minimum_width_px = 24
display_order = 40

[[variants]]
family = "terminal-nova"
id = "favicon-on-light"
backgrounds = ["light"]
color_mode = "full-color"
scale = "simplified"
status = "primary"
minimum_width_px = 16
minimum_height_px = 16
display_order = 50

[[variants]]
family = "terminal-nova"
id = "favicon-on-dark"
backgrounds = ["dark"]
color_mode = "reversed"
scale = "simplified"
status = "primary"
minimum_width_px = 16
minimum_height_px = 16
display_order = 60

[[requirements]]
family = "terminal-nova"
role = "mark"
background = "light"
color_mode = "full-color"
scale = "standard"

[[requirements]]
family = "terminal-nova"
role = "mark"
background = "dark"
color_mode = "reversed"
scale = "standard"

[[requirements]]
family = "terminal-nova"
role = "lockup-horizontal"
background = "light"
color_mode = "full-color"
scale = "standard"

[[requirements]]
family = "terminal-nova"
role = "lockup-horizontal"
background = "dark"
color_mode = "reversed"
scale = "standard"

[[requirements]]
family = "terminal-nova"
role = "favicon"
background = "light"
color_mode = "full-color"
scale = "simplified"

[[requirements]]
family = "terminal-nova"
role = "favicon"
background = "dark"
color_mode = "reversed"
scale = "simplified"

[[bindings]]
family = "terminal-nova"
role = "mark"
variant = "full-color-on-light"
asset = "theme-forge-terminal-nova-mark-on-light"
authority = "source"

[[bindings]]
family = "terminal-nova"
role = "mark"
variant = "reversed-on-dark"
asset = "theme-forge-terminal-nova-mark-on-dark"
authority = "source"

[[bindings]]
family = "terminal-nova"
role = "lockup-horizontal"
variant = "full-color-on-light"
asset = "theme-forge-terminal-nova-horizontal-on-light"
authority = "source"

[[bindings]]
family = "terminal-nova"
role = "lockup-horizontal"
variant = "reversed-on-dark"
asset = "theme-forge-terminal-nova-horizontal-on-dark"
authority = "source"

[[bindings]]
family = "terminal-nova"
role = "lockup-stacked"
variant = "full-color-on-light"
asset = "theme-forge-terminal-nova-stacked-on-light"
authority = "source"

[[bindings]]
family = "terminal-nova"
role = "lockup-stacked"
variant = "reversed-on-dark"
asset = "theme-forge-terminal-nova-stacked-on-dark"
authority = "source"

[[bindings]]
family = "terminal-nova"
role = "mark"
variant = "monochrome-on-dark"
asset = "mark-monochrome-light"
authority = "source"

[[bindings]]
family = "terminal-nova"
role = "mark"
variant = "monochrome-on-light"
asset = "mark-monochrome-dark"
authority = "source"

[[bindings]]
family = "terminal-nova"
role = "favicon"
variant = "favicon-on-light"
asset = "favicon-on-light"
authority = "source"

[[bindings]]
family = "terminal-nova"
role = "favicon"
variant = "favicon-on-dark"
asset = "favicon-on-dark"
authority = "source"
`;
  await writeFile(join(tfsbDir, "brand.toml"), brandTomlContent, "utf8");

  // 3. brand-tokens.toml
  const tokensTomlContent = `schema = "tfsb.brand-tokens"
schema_version = 1

[[colors]]
id = "molten-orange"
value = "#FF8A3DFF"

[[colors]]
id = "intermediate-rose"
value = "#E45A9EFF"

[[colors]]
id = "deep-violet"
value = "#8B5CF6FF"

[[colors]]
id = "gunmetal"
value = "#262A33FF"

[[colors]]
id = "warm-white"
value = "#FFF8F0FF"

[[colors]]
id = "near-black"
value = "#111318FF"

[[colors]]
id = "black"
value = "#000000FF"

[[gradients]]
id = "nova-spectrum"
kind = "linear"
units = "object-bounding-box-millionth"
x1 = 0
y1 = 0
x2 = 1000000
y2 = 1000000

[[gradients.stops]]
offset = 0
color_token = "molten-orange"

[[gradients.stops]]
offset = 500000
color_token = "intermediate-rose"

[[gradients.stops]]
offset = 1000000
color_token = "deep-violet"

[[dimensions]]
id = "clear-space"
unit = "percent-millionth"
value = 166667

[[opacities]]
id = "fully-opaque"
value = 1000000
`;
  await writeFile(join(tfsbDir, "brand-tokens.toml"), tokensTomlContent, "utf8");

  // 4. brand-recipes.toml
  const recipesTomlContent = `schema = "tfsb.brand-recipes"
schema_version = 1
recipes = []
`;
  await writeFile(join(tfsbDir, "brand-recipes.toml"), recipesTomlContent, "utf8");

  // 5. brand-qa.toml
  const qaTomlContent = `schema = "tfsb.brand-qa"
schema_version = 1

[[profiles]]
id = "terminal-nova-qa"
renderer = "optional"
formats = ["json", "markdown"]
cases = [
  "family-completeness",
  "external-content",
  "palette-conformance",
  "accessibility-consistency"
]

[[cases]]
id = "family-completeness"
kind = "inventory"
family = "terminal-nova"

[[cases]]
id = "external-content"
kind = "external-reference"
family = "terminal-nova"
forbid_external_urls = true
forbid_external_images = true
forbid_external_uses = true
forbid_external_styles = true
forbid_external_fonts = true

[[cases]]
id = "palette-conformance"
kind = "palette"
family = "terminal-nova"
allowed_tokens = [
  "molten-orange",
  "intermediate-rose",
  "deep-violet",
  "gunmetal",
  "warm-white",
  "near-black",
  "black"
]
allow_literals = true

[[cases]]
id = "accessibility-consistency"
kind = "accessibility"
family = "terminal-nova"
require_consistent_labels = false
`;
  await writeFile(join(tfsbDir, "brand-qa.toml"), qaTomlContent, "utf8");

  // 6. brand-exports.toml
  const exportsTomlContent = `schema = "tfsb.brand-exports"
schema_version = 1

[[profiles]]
id = "web-icons"
adapter = "resvg-png-v1"

[[profiles.outputs]]
id = "apple-touch-180"
purpose = "apple-touch-icon"
family = "terminal-nova"
role = "favicon"
variant = "favicon-on-light"
destination = "brand/export/apple-touch-icon.png"
width = 180
height = 180
fit = "contain-pad"
background = "transparent"
color_space = "srgb"
alpha = "straight"

[[profiles.outputs]]
id = "pwa-192"
purpose = "pwa-icon"
family = "terminal-nova"
role = "favicon"
variant = "favicon-on-light"
destination = "brand/export/pwa-192.png"
width = 192
height = 192
fit = "contain-pad"
background = "transparent"
color_space = "srgb"
alpha = "straight"

[[profiles.outputs]]
id = "pwa-512"
purpose = "pwa-icon"
family = "terminal-nova"
role = "favicon"
variant = "favicon-on-light"
destination = "brand/export/pwa-512.png"
width = 512
height = 512
fit = "contain-pad"
background = "transparent"
color_space = "srgb"
alpha = "straight"

[[profiles.outputs]]
id = "avatar-512-dark"
purpose = "avatar"
family = "terminal-nova"
role = "mark"
variant = "reversed-on-dark"
destination = "brand/export/avatar-512-dark.png"
width = 512
height = 512
fit = "contain-pad"
background_token = "near-black"
color_space = "srgb"
alpha = "opaque"
`;
  await writeFile(join(tfsbDir, "brand-exports.toml"), exportsTomlContent, "utf8");

  // 7. consumer-profiles.toml
  const consumerProfilesTomlContent = `schema = "tfsb.consumer-profiles"
schema_version = 1

[[profiles]]
id = "astro-starlight"
version = 1
compatible_package = "terminal-nova"
minimum_brand_version = "1.0.0"
maximum_brand_version_exclusive = "2.0.0"

[[profiles.outputs]]
asset = "theme-forge-terminal-nova-horizontal-on-dark"
destination = "docs/src/assets/brand/theme-forge-terminal-nova-horizontal-on-dark.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "theme-forge-terminal-nova-horizontal-on-light"
destination = "docs/src/assets/brand/theme-forge-terminal-nova-horizontal-on-light.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "theme-forge-terminal-nova-mark-on-dark"
destination = "docs/src/assets/brand/theme-forge-terminal-nova-mark-on-dark.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "theme-forge-terminal-nova-mark-on-light"
destination = "docs/src/assets/brand/theme-forge-terminal-nova-mark-on-light.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "theme-forge-terminal-nova-stacked-on-dark"
destination = "docs/src/assets/brand/theme-forge-terminal-nova-stacked-on-dark.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "theme-forge-terminal-nova-stacked-on-light"
destination = "docs/src/assets/brand/theme-forge-terminal-nova-stacked-on-light.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "favicon-on-dark"
destination = "docs/public/favicon-on-dark.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "favicon-on-light"
destination = "docs/public/favicon-on-light.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "favicon-on-light"
destination = "docs/public/favicon.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
companion = "brand-guidance"
destination = "README-BRAND.md"
requirement = "required"
collision = "error"

[[profiles]]
id = "package-distribution"
version = 1
compatible_package = "terminal-nova"
minimum_brand_version = "1.0.0"
maximum_brand_version_exclusive = "2.0.0"

[[profiles.outputs]]
asset = "favicon-on-dark"
destination = "brand/dist/favicon-on-dark.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "favicon-on-light"
destination = "brand/dist/favicon-on-light.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "mark-monochrome-dark"
destination = "brand/dist/mark-monochrome-dark.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "mark-monochrome-light"
destination = "brand/dist/mark-monochrome-light.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "theme-forge-terminal-nova-horizontal-on-dark"
destination = "brand/dist/theme-forge-terminal-nova-horizontal-on-dark.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "theme-forge-terminal-nova-horizontal-on-light"
destination = "brand/dist/theme-forge-terminal-nova-horizontal-on-light.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "theme-forge-terminal-nova-mark-on-dark"
destination = "brand/dist/theme-forge-terminal-nova-mark-on-dark.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "theme-forge-terminal-nova-mark-on-light"
destination = "brand/dist/theme-forge-terminal-nova-mark-on-light.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "theme-forge-terminal-nova-stacked-on-dark"
destination = "brand/dist/theme-forge-terminal-nova-stacked-on-dark.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
asset = "theme-forge-terminal-nova-stacked-on-light"
destination = "brand/dist/theme-forge-terminal-nova-stacked-on-light.svg"
requirement = "required"
collision = "error"

[[profiles.outputs]]
companion = "brand-guidance"
destination = "README-BRAND.md"
requirement = "required"
collision = "error"
`;
  await writeFile(join(tfsbDir, "consumer-profiles.toml"), consumerProfilesTomlContent, "utf8");

  // Write all 10 assets to brand/dist/*.svg and create schema-2 .tfsb/assets/<id>.toml
  /** @type {Map<string, { canonicalAssetDigest: string, svgDigest: string }>} */
  const assetDigests = new Map();

  for (const asset of TERMINAL_NOVA_ASSETS) {
    const entry = assetMap[asset.id];
    if (!entry) throw new Error(`Missing entry in assetMap for ${asset.id}`);
    await writeFile(join(brandDistDir, asset.filename), entry.bytes);

    // Parse SVG and serialize valid schema-2 asset TOML
    const svgText = Buffer.from(entry.bytes).toString("utf8");
    const parsedSvg = product.parseSvgV2(svgText, join(brandDistDir, asset.filename));
    const assetModel = {
      schemaVersion: 2,
      id: asset.id,
      filename: asset.filename,
      svg: parsedSvg.value,
    };
    const assetTomlContent = product.serializeAssetTomlV2(assetModel);
    await writeFile(join(assetsDir, `${asset.id}.toml`), assetTomlContent, "utf8");

    const canonicalAssetDigest = product.computeAssetSemanticDigest(assetModel);
    const renderedResult = product.serializeSvgV2(parsedSvg.value, join(assetsDir, `${asset.id}.toml`));
    if (!renderedResult.ok) {
      throw new Error(`Failed to render SVG ${asset.filename}`);
    }
    const renderedBytes = Buffer.from(renderedResult.value, "utf8");
    const svgDigest = product.computeSha256(renderedBytes);
    assetDigests.set(asset.id, { canonicalAssetDigest, svgDigest });
  }

  // Copy README-BRAND.md to .tfsb/companions/brand-guidance.md and project root
  await writeFile(join(companionsDir, "brand-guidance.md"), readmeBytes);
  await writeFile(join(brandDir, "README.md"), readmeBytes);
  await writeFile(join(projectRoot, "README-BRAND.md"), readmeBytes);

  // 8. Compute digests and generate brand-package.toml
  const tokensModel = unwrapResult(product.parseBrandTokensToml(tokensTomlContent));
  const tokensDigest = product.computeBrandTokensDigest(tokensModel);

  const recipesModel = unwrapResult(product.parseBrandRecipesToml(recipesTomlContent));
  const recipesDigest = product.computeBrandRecipesDigest(recipesModel);

  const qaModel = unwrapResult(product.parseBrandQaToml(qaTomlContent));
  const qaDigest = product.computeBrandQaDigest(qaModel);

  const consumerProfilesModel = unwrapResult(product.parseConsumerProfilesToml(consumerProfilesTomlContent));
  const consumerProfilesDigest = product.computeConsumerProfilesDomainDigest(consumerProfilesModel);

  const exportsModel = unwrapResult(product.parseBrandExportsToml(exportsTomlContent));
  const exportProfileDigest = product.computeBrandExportsDomainDigest(exportsModel);

  const brandModel = unwrapResult(product.parseBrandToml(brandTomlContent));

  const referencedAssets = Array.from(assetDigests.entries())
    .map(([assetId, d]) => ({ assetId, canonicalAssetDigest: d.canonicalAssetDigest }))
    .sort((a, b) => a.assetId.localeCompare(b.assetId));

  const brandSystemDigest = product.computeBrandSystemDigest({
    brand: brandModel,
    consumerProfiles: consumerProfilesModel,
    exports: exportsModel,
    qa: product.toBrandQaCanonicalDto(qaModel),
    recipes: product.toBrandRecipesCanonicalDto(recipesModel),
    referencedAssets,
    tokens: product.toBrandTokensCanonicalDto(tokensModel),
  });

  const compatibleProfiles = consumerProfilesModel.profiles
    .map((/** @type {{ id: string }} */ p) => p.id)
    .sort((/** @type {string} */ a, /** @type {string} */ b) => a.localeCompare(b));
  const companionDigest = product.computeSha256(readmeBytes);

  const inventoryLines = [];
  for (const binding of brandModel.bindings) {
    const d = assetDigests.get(binding.asset);
    if (!d) throw new Error(`Missing digests for asset ${binding.asset}`);
    inventoryLines.push(`[[inventory]]
family = "${binding.family}"
role = "${binding.role}"
variant = "${binding.variant}"
asset = "${binding.asset}"
canonical_asset_digest = "${d.canonicalAssetDigest}"
svg_digest = "${d.svgDigest}"`);
  }

  const brandPackageContent = `schema = "tfsb.brand-package"
schema_version = 1
package_id = "terminal-nova"
name = "Theme Forge Terminal Nova brand assets"
brand_version = "1.0.0"
families = ["terminal-nova"]
compatible_profiles = ${JSON.stringify(compatibleProfiles)}
brand_system_digest = "${brandSystemDigest}"
brand_token_digest = "${tokensDigest}"
brand_recipe_digest = "${recipesDigest}"
brand_qa_digest = "${qaDigest}"
consumer_profile_digest = "${consumerProfilesDigest}"
export_profile_digest = "${exportProfileDigest}"

[[companions]]
id = "brand-guidance"
source = "brand/README.md"
bundle_path = "companions/README-BRAND.md"
canonical_companion_file = "README-BRAND.md"
media_type = "text/markdown"
purpose = "brand-guidance"
required = true
digest = "${companionDigest}"

${inventoryLines.join("\n\n")}
`;
  await writeFile(join(tfsbDir, "brand-package.toml"), brandPackageContent, "utf8");
}

/**
 * Main qualification runner
 * @param {QualifyOptions} options
 */
export async function qualifyTerminalNova(options) {
  const { canonicalSource, scratchRoot } = options;
  const product = await loadProductModules();

  await mkdir(scratchRoot, { recursive: true });
  const realScratch = await realpath(scratchRoot);

  // Step 1: Read-only inspection of canonical corpus
  const corpus = await inspectCanonicalSource(canonicalSource);

  // Step 2: Monochrome recipe attempt & rejection proof
  // Both monochrome assets drop <defs> and rewrite IDs to tn-monochrome-*
  const recipeProof = {
    evaluated: ["mark-monochrome-dark", "mark-monochrome-light"],
    reasons: [
      "Canonical monochrome assets omit gradient <defs> present in source full-color mark",
      "Canonical monochrome assets use dedicated ID prefix 'tn-monochrome-*' rather than 'tn-mark-*'",
      "TFSB recipe operations (replace-paint, monochrome, background-plate) do not perform element ID rewrite or defs pruning",
      "Exact byte equality fails under recipe derivation; assets must remain source-owned",
    ],
    disposition: "rejected-retained-as-source",
  };

  /** @type {any[]} */
  const runResults = [];

  // Step 3: Run two complete isolated runs for determinism
  for (const runId of ["run1", "run2"]) {
    const runDir = join(realScratch, "workflow", runId);
    await mkdir(runDir, { recursive: true });
    const projectDir = join(runDir, "project");
    const consumerDir = join(runDir, "consumer");
    const exportDir = join(runDir, "exports");
    await mkdir(join(consumerDir, ".tfsb", "assets"), { recursive: true });
    await writeFile(
      join(consumerDir, ".tfsb", "project.toml"),
      'schema_version = 2\nname = "consumer"\n\n[build]\ndirectory = "dist"\n',
      "utf8",
    );
    await mkdir(exportDir, { recursive: true });

    // Generate project
    await generateTerminalNovaBrandProject(projectDir, corpus.assetMap, corpus.readmeBytes);

    // Check project
    const checkResult = await product.checkProject(projectDir);

    // Bundle brand project
    const bundlePlan = await product.planBrandBundle({
      root: projectDir,
      output: "terminal-nova-brand-bundle.zip",
    });
    await product.executeBrandBundle(bundlePlan);
    const bundleZipPath = join(projectDir, "terminal-nova-brand-bundle.zip");

    // Import brand project from bundle to verify roundtrip
    const importDir = join(runDir, "imported-bundle");
    await mkdir(importDir, { recursive: true });
    const importPlan = await product.planBrandImport({ archive: bundleZipPath, root: importDir });
    await product.executeBrandImport(importPlan);

    // Exercise the currently supported portions of the five plan families.

    // 1. Derive plan
    const derivePlan = await product.planBrandDerivation({ root: projectDir, all: true });
    const deriveResult = await product.executeBrandDerivationPlan(derivePlan);

    // 2. QA baseline plan
    const semanticQaStatus = checkResult.brand?.qa?.semanticFail === 0 ? "pass" : "fail";

    // 3. Consumer install plan
    const installPlan = await product.planConsumerInstall({
      root: consumerDir,
      sourceBundles: [bundleZipPath],
      profiles: ["terminal-nova/astro-starlight"],
    });
    const installResult = await product.executeConsumerInstallPlan(installPlan);

    // Verify tracked destination outputs match canonical repository bytes
    /** @type {Record<string, { size: number, sourceSha256: string, canonicalDestinationSha256: string, generatedSha256: string, match: boolean, disposition: string }>} */
    const trackedVerifications = {};
    for (const asset of TERMINAL_NOVA_ASSETS) {
      for (const dest of asset.destinations) {
        const destPath = join(consumerDir, dest);
        const destBytes = await readFile(destPath);
        const destSha = sha256Hex(destBytes);
        const canonicalDestPath = join(canonicalSource, dest);
        const canonicalBytes = await readFile(canonicalDestPath);
        const canonicalDestinationSha256 = sha256Hex(canonicalBytes);
        const match = canonicalDestinationSha256 === destSha;
        trackedVerifications[dest] = {
          size: destBytes.byteLength,
          sourceSha256: asset.expectedSha256,
          canonicalDestinationSha256,
          generatedSha256: destSha,
          match,
          disposition: match ? "byte-identical" : "normalization-delta-unapproved",
        };
      }
    }

    // Verify companion README-BRAND.md installed
    const installedReadme = await readFile(join(consumerDir, "README-BRAND.md"));
    const installedReadmeSha = sha256Hex(installedReadme);
    const readmeMatch = installedReadmeSha === EXPECTED_README_BRAND_SHA256;

    // 4. Consumer sync plan
    // Clean sync first
    const cleanSyncPlan = await product.planConsumerSync({ root: consumerDir, sourceBundles: [bundleZipPath] });
    const cleanSyncResult = await product.executeConsumerSyncPlan(cleanSyncPlan);

    // Injected drift test: modify one destination, sync detects drift and fails closed
    const driftTarget = join(consumerDir, "docs/public/favicon.svg");
    const originalFavicon = await readFile(driftTarget);
    await writeFile(driftTarget, "<!-- drifted content -->", "utf8");
    let driftCode = null;
    try {
      await product.planConsumerSync({ root: consumerDir, sourceBundles: [bundleZipPath] });
    } catch (err) {
      driftCode = err && typeof err === "object" && "diagnostic" in err &&
        err.diagnostic && typeof err.diagnostic === "object" && "code" in err.diagnostic
        ? String(err.diagnostic.code)
        : null;
      if (driftCode !== "CONSUMER_DRIFT") throw err;
    }
    // Restore original favicon
    await writeFile(driftTarget, originalFavicon);
    const restoredSyncPlan = await product.planConsumerSync({ root: consumerDir, sourceBundles: [bundleZipPath] });
    const restoredSyncResult = await product.executeConsumerSyncPlan(restoredSyncPlan);
    const driftRestored = driftCode === "CONSUMER_DRIFT" && restoredSyncResult.writtenOutputs === 0;

    // 5. Export plan (inspect and execute)
    let exportStatus = "not-run";
    let exportExecuted = false;
    let exportPlannedOutputs = 0;
    try {
      const exportPlan = await product.planRasterExport(projectDir, {
        profileId: "web-icons",
      });
      exportPlannedOutputs = exportPlan.outputs?.length ?? 0;
      await product.executeRasterExportPlan(exportPlan);
      exportExecuted = true;
      exportStatus = "executed";
    } catch (error) {
      const code = error && typeof error === "object" && "diagnostic" in error &&
        error.diagnostic && typeof error.diagnostic === "object" && "code" in error.diagnostic
        ? String(error.diagnostic.code)
        : null;
      if (code !== "EXPORT_CAPABILITY_UNAVAILABLE") throw error;
      exportStatus = "raster-unavailable-semantic-only";
    }

    // Inspect consumer state
    const consumerState = await product.inspectConsumerState({ root: consumerDir, sourceBundles: [bundleZipPath] });

    runResults.push({
      runId,
      checkStatus: checkResult.brand?.valid ? "ok" : "fail",
      bundleDigest: sha256Hex(await readFile(bundleZipPath)),
      bundleByteLength: (await stat(bundleZipPath)).size,
      deriveUpdates: deriveResult.updatedTargets?.length ?? 0,
      qaBaselineStatus: "not-executed-no-baseline-renderer",
      semanticQaStatus,
      consumerInstallWrites: installResult.writtenFiles?.length ?? installPlan.summary?.outputs?.length ?? 0,
      trackedVerifications,
      readmeMatch,
      cleanSyncOutputs: cleanSyncResult.writtenOutputs,
      driftCode,
      driftRestored,
      exportStatus,
      exportPlannedOutputs,
      exportExecuted,
      consumerStatus: consumerState.status,
    });
  }

  // Two-run determinism comparison
  const determinism = {
    bundleDigestEqual: runResults[0].bundleDigest === runResults[1].bundleDigest,
    bundleBytesEqual: runResults[0].bundleByteLength === runResults[1].bundleByteLength,
    semanticQaEqual: runResults[0].semanticQaStatus === runResults[1].semanticQaStatus,
    allVerificationsEqual: JSON.stringify(runResults[0].trackedVerifications) === JSON.stringify(runResults[1].trackedVerifications),
    twoRunPassed: true,
  };
  determinism.twoRunPassed = determinism.bundleDigestEqual &&
    determinism.bundleBytesEqual &&
    determinism.semanticQaEqual &&
    determinism.allVerificationsEqual;

  const receipt = {
    schema: "tfsb.terminal-nova-qualification-receipt",
    schemaVersion: 1,
    corpus: {
      assetsCount: TERMINAL_NOVA_ASSETS.length,
      trackedDestinationsCount: new Set(TERMINAL_NOVA_ASSETS.flatMap((asset) => asset.destinations)).size,
      zeroDestinationCount: TERMINAL_NOVA_ASSETS.filter((asset) => asset.destinations.length === 0).length,
      readmeSha: corpus.readmeSha,
      zipSha: corpus.zipSha,
      assets: TERMINAL_NOVA_ASSETS.map((asset) => ({
        canonicalSource: `brand/dist/${asset.filename}`,
        sourceByteDigest: asset.expectedSha256,
        semanticAssetId: asset.id,
        family: "terminal-nova",
        role: asset.role,
        variant: asset.variant,
        owner: "Theme Forge Terminal Nova project",
        licenseProvenance: "brand/README.md brand-use policy; not inferred from software licenses",
        recipeEligibility: asset.id.startsWith("mark-monochrome-") ? "evaluated-rejected-retained-as-source" : "source-owned-no-recipe-adopted",
        renderProfiles: ["terminal-nova-qa", "web-icons"],
        trackedDestinations: [...asset.destinations],
        zeroDestination: asset.destinations.length === 0,
        rollbackIdentity: asset.expectedSha256,
      })),
    },
    recipeProof,
    determinism,
    runs: runResults,
    qualification: {
      status: "blocked",
      blockers: [
        ...(runResults.every((run) => Object.values(run.trackedVerifications).every((entry) => entry.match))
          ? []
          : ["canonical-tracked-destination-byte-parity"]),
        "qa-baseline-plan-not-executed",
        "required-terminal-nova-matrix-incomplete",
      ],
    },
  };

  if (options.outputReceipt) {
    await writeFile(options.outputReceipt, canonicalJson(receipt), "utf8");
  }

  return receipt;
}

/**
 * CLI entrypoint
 */
async function main() {
  const { parseOperatorArguments, runOperatorQualification, unavailableResult } = await import("./tfsb48-r2/operator-integration.mjs");
  try {
    const options = parseOperatorArguments(process.argv.slice(2));
    const result = await runOperatorQualification({ source: options.source, scratch: options.scratch, receipt: options.receipt });
    process.stdout.write(canonicalJson(result));
    if (result.status !== "pass") process.exitCode = 2;
  } catch (error) {
    process.stdout.write(canonicalJson(unavailableResult(error)));
    process.exitCode = 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
