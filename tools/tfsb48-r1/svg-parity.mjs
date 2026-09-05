import * as fflate from "fflate";
// @ts-check

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CANONICAL_ASSETS, sha256Hex } from "./canonical-corpus.mjs";
import { renderSvg, descriptor as resvgDescriptor } from "../../packages/tfsb-raster-resvg/index.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

const GEOMETRY_KEYS = new Set([
  "d", "transforms", "x", "y", "cx", "cy", "r", "rx", "ry", "width", "height",
  "x1", "y1", "x2", "y2", "points", "viewBox",
]);
const PAINT_KEYS = new Set([
  "fill", "stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeMiterlimit",
  "opacity", "fillOpacity", "strokeOpacity", "fillRule", "clipRule", "linearGradients", "stops",
  "color", "offset", "fallback",
]);

/**
 * @param {any} value
 * @param {Set<string>} keys
 * @param {string} [path]
 * @param {any[]} [rows]
 */
function selectedProperties(value, keys, path = "$", rows = []) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => selectedProperties(child, keys, `${path}[${index}]`, rows));
    return rows;
  }
  if (value === null || typeof value !== "object") return rows;
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (keys.has(key)) rows.push([`${path}.${key}`, child]);
    selectedProperties(child, keys, `${path}.${key}`, rows);
  }
  return rows;
}

/**
 * @param {string} text
 * @param {RegExp} pattern
 * @param {number} [group]
 */
function matches(text, pattern, group = 0) {
  return [...text.matchAll(pattern)].map((match) => match[group] ?? "").sort();
}

/** @param {string} text */
function inspectRawSvg(text) {
  const root = text.match(/<([A-Za-z][\w:.-]*)\b([^>]*)>/);
  const rootAttributes = root?.[2] ?? "";
  const hrefValues = matches(text, /(?:href|xlink:href)\s*=\s*["']([^"']+)["']/gi, 1);
  const urlValues = matches(text, /url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi, 1);
  const ariaReferences = matches(text, /aria-(?:labelledby|describedby)\s*=\s*["']([^"']+)["']/gi, 1);
  const references = [...hrefValues.map((value) => `href:${value}`), ...urlValues.map((value) => `url:${value}`), ...ariaReferences.map((value) => `aria:${value}`)].sort();
  const externalUrls = [...hrefValues, ...urlValues].filter((value) => !value.startsWith("#") && /^[a-z][a-z0-9+.-]*:/i.test(value));
  const title = text.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
  const description = text.match(/<desc(?:\s[^>]*)?>([\s\S]*?)<\/desc>/i)?.[1]?.trim() ?? "";
  return {
    rootElement: root?.[1] ?? null,
    namespace: rootAttributes.match(/\bxmlns\s*=\s*["']([^"']+)["']/i)?.[1] ?? null,
    width: rootAttributes.match(/\bwidth\s*=\s*["']([^"']+)["']/i)?.[1] ?? null,
    height: rootAttributes.match(/\bheight\s*=\s*["']([^"']+)["']/i)?.[1] ?? null,
    viewBox: rootAttributes.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1] ?? null,
    ids: matches(text, /\bid\s*=\s*["']([^"']+)["']/gi, 1),
    references,
    accessibility: { title, description, ariaReferences },
    externalArtifacts: {
      scripts: matches(text, /<script\b/gi).length,
      events: matches(text, /\son[a-z]+\s*=/gi).length,
      styles: matches(text, /<style\b|\sstyle\s*=/gi).length,
      fonts: matches(text, /\bfont(?:-family)?\s*=/gi).length,
      images: matches(text, /<image\b/gi).length,
      externalUrls: externalUrls.sort(),
    },
  };
}

/** @param {any} document */
function inspectParsedSvg(document) {
  return {
    semanticDigestInput: document,
    structureDigest: sha256Hex(JSON.stringify(document)),
    geometryDigest: sha256Hex(JSON.stringify(selectedProperties(document, GEOMETRY_KEYS))),
    paintDigest: sha256Hex(JSON.stringify(selectedProperties(document, PAINT_KEYS))),
    canvas: document.canvas,
    accessibility: document.accessibility,
    definitionsDigest: sha256Hex(JSON.stringify(document.definitions)),
    elementsDigest: sha256Hex(JSON.stringify(document.elements)),
  };
}

/**
 * Load product APIs dynamically from dist
 */
async function loadProductModules() {
  const url = new URL("../../dist/index.js", import.meta.url);
  return await import(url.href);
}

/**
 * Pinned background colors
 */
export const BACKGROUND_COLORS = {
  transparent: null,
  white: [255, 255, 255, 255],
  warm_white: [255, 248, 240, 255], // #FFF8F0
  dark: [23, 25, 31, 255],          // #17191F terminal_dark
  charcoal: [38, 42, 51, 255],      // #262A33 gunmetal
  near_black: [17, 19, 24, 255],    // #111318 near_black
  black: [0, 0, 0, 255],
};

/**
 * Get required test renders for an asset.
 * @param {string} role
 * @param {string} variant
 */
function getRenderConfigs(role, variant) {
  const onLight = variant.includes("light") || variant.includes("on-light");
  const onDark = variant.includes("dark") || variant.includes("on-dark");

  if (role === "favicon") {
    const sizes = [
      { width: 16, height: 16 },
      { width: 24, height: 24 },
      { width: 32, height: 32 },
      { width: 48, height: 48 },
    ];
    /** @type {{ width: number, height: number, backgroundName: string, backgroundRgba: any }[]} */
    const configs = [];
    for (const s of sizes) {
      configs.push({ ...s, backgroundName: "transparent", backgroundRgba: BACKGROUND_COLORS.transparent });
      if (onLight) {
        configs.push({ ...s, backgroundName: "warm_white", backgroundRgba: BACKGROUND_COLORS.warm_white });
        configs.push({ ...s, backgroundName: "white", backgroundRgba: BACKGROUND_COLORS.white });
      }
      if (onDark) {
        configs.push({ ...s, backgroundName: "dark", backgroundRgba: BACKGROUND_COLORS.dark });
        configs.push({ ...s, backgroundName: "near_black", backgroundRgba: BACKGROUND_COLORS.near_black });
      }
    }
    return configs;
  }

  if (role === "mark") {
    const sizes = [
      { width: 64, height: 64 },
      { width: 128, height: 128 },
      { width: 256, height: 256 },
    ];
    /** @type {{ width: number, height: number, backgroundName: string, backgroundRgba: any }[]} */
    const configs = [];
    for (const s of sizes) {
      configs.push({ ...s, backgroundName: "transparent", backgroundRgba: BACKGROUND_COLORS.transparent });
      if (onLight) {
        configs.push({ ...s, backgroundName: "warm_white", backgroundRgba: BACKGROUND_COLORS.warm_white });
        configs.push({ ...s, backgroundName: "white", backgroundRgba: BACKGROUND_COLORS.white });
      }
      if (onDark) {
        configs.push({ ...s, backgroundName: "dark", backgroundRgba: BACKGROUND_COLORS.dark });
        configs.push({ ...s, backgroundName: "charcoal", backgroundRgba: BACKGROUND_COLORS.charcoal });
        configs.push({ ...s, backgroundName: "near_black", backgroundRgba: BACKGROUND_COLORS.near_black });
      }
    }
    return configs;
  }

  if (role === "lockup-horizontal") {
    // viewBox 0 0 780 156 (5:1)
    const sizes = [
      { width: 240, height: 48 },
      { width: 480, height: 96 },
      { width: 780, height: 156 },
    ];
    /** @type {{ width: number, height: number, backgroundName: string, backgroundRgba: any }[]} */
    const configs = [];
    for (const s of sizes) {
      configs.push({ ...s, backgroundName: "transparent", backgroundRgba: BACKGROUND_COLORS.transparent });
      if (onLight) {
        configs.push({ ...s, backgroundName: "warm_white", backgroundRgba: BACKGROUND_COLORS.warm_white });
        configs.push({ ...s, backgroundName: "white", backgroundRgba: BACKGROUND_COLORS.white });
      }
      if (onDark) {
        configs.push({ ...s, backgroundName: "dark", backgroundRgba: BACKGROUND_COLORS.dark });
        configs.push({ ...s, backgroundName: "charcoal", backgroundRgba: BACKGROUND_COLORS.charcoal });
        configs.push({ ...s, backgroundName: "near_black", backgroundRgba: BACKGROUND_COLORS.near_black });
      }
    }
    return configs;
  }

  if (role === "lockup-stacked") {
    // viewBox 0 0 380 320
    const sizes = [
      { width: 160, height: 135 },
      { width: 320, height: 270 },
      { width: 380, height: 320 },
    ];
    /** @type {{ width: number, height: number, backgroundName: string, backgroundRgba: any }[]} */
    const configs = [];
    for (const s of sizes) {
      configs.push({ ...s, backgroundName: "transparent", backgroundRgba: BACKGROUND_COLORS.transparent });
      if (onLight) {
        configs.push({ ...s, backgroundName: "warm_white", backgroundRgba: BACKGROUND_COLORS.warm_white });
        configs.push({ ...s, backgroundName: "white", backgroundRgba: BACKGROUND_COLORS.white });
      }
      if (onDark) {
        configs.push({ ...s, backgroundName: "dark", backgroundRgba: BACKGROUND_COLORS.dark });
        configs.push({ ...s, backgroundName: "charcoal", backgroundRgba: BACKGROUND_COLORS.charcoal });
        configs.push({ ...s, backgroundName: "near_black", backgroundRgba: BACKGROUND_COLORS.near_black });
      }
    }
    return configs;
  }

  throw new Error(`Unknown role: ${role}`);
}

/**
 * A caller-supplied corpus identity used by the R2 integration lane.  The
 * shape intentionally accepts the readback returned by either
 * `canonical-corpus.mjs` or `qualify-terminal-nova-brand.mjs`; both expose
 * the same identity facts with slightly different names.
 *
 * @typedef {object} SvgParityOptions
 * @property {readonly any[]} [assets]
 * @property {string} [artifactPrefix]
 * @property {any} [corpusProvenance]
 * @property {any} [provenance]
 */

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required.`);
  return value;
}

/** @param {unknown} value @param {string} label */
function relativeIdentityPath(value, label) {
  const path = requiredText(value, label);
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) {
    throw new Error(`${label} must be a repository-relative path.`);
  }
  return path;
}

/** @param {unknown} value @param {string} label */
function digestText(value, label) {
  const digest = requiredText(value, label);
  if (!/^(?:sha256:)?[a-f0-9]{64}$/iu.test(digest)) throw new Error(`${label} must be a SHA-256 digest.`);
  return digest.replace(/^sha256:/iu, "").toLowerCase();
}

/**
 * @param {any} value
 * @param {string[]} keys
 */
function firstObject(value, keys) {
  if (value === null || typeof value !== "object") return null;
  for (const key of keys) {
    const candidate = value[key];
    if (candidate !== null && typeof candidate === "object") return candidate;
  }
  return null;
}

/**
 * Normalize caller-provided corpus identities and fail closed when R2 asks
 * for provenance binding but leaves one of the authenticated identity facts
 * out.  The no-options R1 path deliberately remains permissive for history.
 *
 * @param {SvgParityOptions | undefined} options
 */
function normalizeProvenance(options) {
  const supplied = options?.corpusProvenance ?? options?.provenance;
  if (supplied === undefined || supplied === null) return null;
  if (typeof supplied !== "object") throw new Error("SVG parity corpus provenance must be an object.");

  const git = firstObject(supplied, ["git", "repository", "canonicalGit"])
    ?? firstObject(supplied.canonical, ["git", "repository"])
    ?? (supplied.canonical && typeof supplied.canonical === "object" ? supplied.canonical : null)
    ?? {};
  const generator = firstObject(supplied, ["generatorProvenance", "generator"])
    ?? firstObject(supplied.canonical, ["generatorProvenance", "generator"])
    ?? {};
  const commit = requiredText(git.commit ?? git.head, "corpus git commit");
  const tree = requiredText(git.tree, "corpus git tree");
  if (typeof git.clean !== "boolean") throw new Error("corpus git clean status is required.");
  const generatorPath = relativeIdentityPath(generator.path ?? generator.sourcePath, "generator path");
  const generatorSha256 = digestText(generator.sha256 ?? generator.digest, "generator SHA-256");

  const sourceIdentities = supplied.sourceIdentities ?? supplied.sources ?? supplied.assetMap ?? {};
  const destinationIdentities = supplied.destinationIdentities ?? supplied.destinations ?? supplied.trackedDestinationMap ?? {};
  if (sourceIdentities === null || typeof sourceIdentities !== "object") throw new Error("source identities must be an object.");
  if (destinationIdentities === null || typeof destinationIdentities !== "object") throw new Error("destination identities must be an object.");

  return {
    canonical: { commit, tree, clean: git.clean },
    generator: { path: generatorPath, sha256: generatorSha256 },
    sourceIdentities,
    destinationIdentities,
  };
}

/**
 * @param {any} identityMap
 * @param {string[]} keys
 * @param {string} label
 */
function suppliedIdentity(identityMap, keys, label) {
  for (const key of keys) {
    const value = identityMap[key];
    if (value !== undefined && value !== null) {
      if (typeof value === "string") return { path: key, sha256: digestText(value, `${label} SHA-256`) };
      if (typeof value !== "object") throw new Error(`${label} identity must be an object.`);
      const digest = value.sha256 ?? value.digest;
      const bytesDigest = value.bytes === undefined ? undefined : sha256Hex(value.bytes);
      const normalizedDigest = digest === undefined ? bytesDigest : digestText(digest, `${label} SHA-256`);
      if (normalizedDigest === undefined) throw new Error(`${label} SHA-256 is required.`);
      if (bytesDigest !== undefined && normalizedDigest !== bytesDigest) throw new Error(`${label} bytes and SHA-256 disagree.`);
      return { path: value.path ?? key, sha256: normalizedDigest };
    }
  }
  throw new Error(`${label} identity is missing from caller provenance.`);
}

/** @param {string | undefined} prefix */
function artifactPrefix(prefix) {
  const value = prefix ?? "tfsb48-r1-terminal-nova";
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) || value.includes("..")) {
    throw new Error("SVG parity artifactPrefix must be a simple filename prefix.");
  }
  return value;
}

/** @param {string} canonicalText @param {string} generatedText @param {boolean} structuralMatch */
function classifyLexicalDelta(canonicalText, generatedText, structuralMatch) {
  if (canonicalText === generatedText || !structuralMatch) return [];

  // These labels are emitted only when the corresponding textual feature is
  // actually different.  The final generic label is the bounded contract for
  // a semantic-preserving byte normalization, not a claim about every token.
  const labels = [];
  const canonicalVersion = /\bversion\s*=\s*["']1\.1["']/iu.test(canonicalText);
  const generatedVersion = /\bversion\s*=\s*["']1\.1["']/iu.test(generatedText);
  if (canonicalVersion !== generatedVersion) labels.push("omitted-svg-version-1.1");

  /** @param {string} text @returns {string[]} */
  const selfClosing = (text) => [...text.matchAll(/<([A-Za-z][\w:.-]*)\b[^>]*\/\s*>/gu)]
    .map((match) => match[1])
    .filter((tagName) => tagName !== undefined)
    .sort();
  if (JSON.stringify(selfClosing(canonicalText)) !== JSON.stringify(selfClosing(generatedText))) {
    labels.push("self-closing-tag-normalization");
  }

  labels.push("byte-normalization-delta");
  return labels;
}

/** @param {string} patchText */
function patchSections(patchText) {
  /** @type {Map<string, string>} */
  const sections = new Map();
  if (patchText.length === 0) return sections;
  const starts = [...patchText.matchAll(/^--- a\/(.+)\n\+\+\+ b\/(.+)(?:\n|$)/gmu)];
  if (starts.length === 0) throw new Error("Migration patch has no unified-diff sections.");
  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index];
    if (match === undefined) throw new Error("Migration patch section is missing.");
    const pathA = match[1];
    const pathB = match[2];
    if (pathA === undefined || pathB === undefined) throw new Error("Migration patch section has no paths.");
    if (pathA !== pathB) throw new Error(`Migration patch has mismatched paths: ${pathA} vs ${pathB}`);
    const start = match.index;
    const next = starts[index + 1];
    const end = next === undefined ? patchText.length : next.index;
    const section = patchText.slice(start, end);
    if (!section.includes("\n@@")) throw new Error(`Migration patch section for ${pathA} is empty.`);
    if (sections.has(pathA)) throw new Error(`Migration patch contains duplicate path ${pathA}.`);
    sections.set(pathA, section);
  }
  return sections;
}

/** @param {string[]} actual @param {string[]} expected @param {string} label */
function assertExactPathSet(actual, expected, label) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(`${label} path set mismatch: expected ${expectedSorted.join(",")}; got ${actualSorted.join(",")}`);
  }
}

/**
 * Compare canonical tracked destinations and TFSB generated SVGs.
 *
 * The two-argument form is retained for R1 historical records.  R2 callers
 * should pass `corpusProvenance` from an authenticated canonical inspection
 * and an `artifactPrefix`; in that mode every row carries the supplied
 * canonical, generator, source, and destination identities.
 *
 * @param {string} canonicalSource
 * @param {string} scratchRoot
 * @param {SvgParityOptions} [options]
 */
export async function evaluateSvgParity(canonicalSource, scratchRoot, options = {}) {
  const product = await loadProductModules();
  const distDir = join(canonicalSource, "brand", "dist");
  const assets = options.assets ?? CANONICAL_ASSETS;
  if (!Array.isArray(assets) || assets.length === 0) throw new Error("SVG parity assets must be a nonempty array.");
  const provenance = normalizeProvenance(options);
  const prefix = artifactPrefix(options.artifactPrefix);

  const trackedDestinations = assets.flatMap((asset) => asset.destinations);
  if (new Set(trackedDestinations).size !== trackedDestinations.length) throw new Error("SVG parity assets contain duplicate tracked destinations.");

  /** @type {any[]} */
  const parityRows = [];
  const migrationPatchFiles = new Map();

  for (const asset of assets) {
    if (asset.destinations.length === 0) continue;

    const sourcePath = `brand/dist/${asset.filename}`;
    const sourceFullPath = join(distDir, asset.filename);
    const sourceBytes = await readFile(sourceFullPath);
    const sourceDigest = sha256Hex(sourceBytes);
    const sourceIdentity = provenance
      ? suppliedIdentity(provenance.sourceIdentities, [asset.id, sourcePath, asset.filename], `source ${sourcePath}`)
      : null;
    if (sourceIdentity && sourceIdentity.sha256 !== sourceDigest) throw new Error(`Source identity mismatch for ${sourcePath}.`);

    // Parse source SVG using TFSB parser
    const sourceText = sourceBytes.toString("utf8");
    const parsedSvgResult = product.parseSvgV2(sourceText, sourceFullPath);
    if (!parsedSvgResult.ok) throw new Error(`Failed to parse SVG ${sourcePath}`);
    const parsedSvg = parsedSvgResult.value;

    // Serialize using TFSB serializer
    const serializedResult = product.serializeSvgV2(parsedSvg, `test/${asset.id}.toml`);
    if (!serializedResult.ok) throw new Error(`Failed to serialize SVG ${asset.id}`);
    const generatedText = serializedResult.value;
    const generatedBytes = Buffer.from(generatedText, "utf8");
    const generatedDigest = sha256Hex(generatedBytes);

    const sourceAssetModel = {
      schemaVersion: 2,
      id: asset.id,
      filename: asset.filename,
      svg: parsedSvg,
    };
    const sourceSemanticDigest = product.computeAssetSemanticDigest(sourceAssetModel);
    const generatedParsedResult = product.parseSvgV2(generatedText, `generated/${asset.filename}`);
    if (!generatedParsedResult.ok) throw new Error(`Failed to parse generated SVG ${asset.id}`);
    const generatedParsedSvg = generatedParsedResult.value;

    // Raster render configs
    const renderConfigs = getRenderConfigs(asset.role, asset.variant);

    for (const destination of asset.destinations) {
      const canonicalDestPath = join(canonicalSource, destination);
      const canonicalDestBytes = await readFile(canonicalDestPath);
      const canonicalDestDigest = sha256Hex(canonicalDestBytes);
      const destinationIdentity = provenance
        ? suppliedIdentity(provenance.destinationIdentities, [destination, sourcePath], `destination ${destination}`)
        : null;
      if (destinationIdentity && destinationIdentity.sha256 !== canonicalDestDigest) throw new Error(`Destination identity mismatch for ${destination}.`);
      const canonicalDestText = canonicalDestBytes.toString("utf8");
      const canonicalParsedResult = product.parseSvgV2(canonicalDestText, canonicalDestPath);
      if (!canonicalParsedResult.ok) throw new Error(`Failed to parse canonical destination ${destination}`);
      const canonicalParsedSvg = canonicalParsedResult.value;
      const canonicalModel = inspectParsedSvg(canonicalParsedSvg);
      const generatedModel = inspectParsedSvg(generatedParsedSvg);
      const canonicalRaw = inspectRawSvg(canonicalDestText);
      const generatedRaw = inspectRawSvg(generatedText);
      const canonicalSemanticDigest = product.computeAssetSemanticDigest({ ...sourceAssetModel, svg: canonicalParsedSvg });
      const generatedSemanticDigest = product.computeAssetSemanticDigest({ ...sourceAssetModel, svg: generatedParsedSvg });
      const structuralMatch = canonicalSemanticDigest === generatedSemanticDigest
        && canonicalModel.structureDigest === generatedModel.structureDigest
        && canonicalModel.geometryDigest === generatedModel.geometryDigest
        && canonicalModel.paintDigest === generatedModel.paintDigest
        && canonicalModel.definitionsDigest === generatedModel.definitionsDigest
        && canonicalModel.elementsDigest === generatedModel.elementsDigest
        && JSON.stringify(canonicalRaw) === JSON.stringify(generatedRaw);

      const bytesEqual = canonicalDestDigest === generatedDigest;
      const lexicalDiffs = classifyLexicalDelta(canonicalDestText, generatedText, structuralMatch);

      // Multi-resolution and multi-background raster comparison
      /** @type {any[]} */
      const rasterOutputs = [];
      let totalChangedPixels = 0;
      let minDiffX = Infinity, minDiffY = Infinity, maxDiffX = -1, maxDiffY = -1;

      for (const cfg of renderConfigs) {
        const canonicalRaster = await renderSvg({
          canonicalSvgBytes: canonicalDestBytes,
          width: cfg.width,
          height: cfg.height,
          backgroundRgba: cfg.backgroundRgba,
          alpha: cfg.backgroundRgba === null ? "straight" : "opaque",
          fit: "contain-pad",
          colorSpace: "srgb",
        });

        const generatedRaster = await renderSvg({
          canonicalSvgBytes: generatedBytes,
          width: cfg.width,
          height: cfg.height,
          backgroundRgba: cfg.backgroundRgba,
          alpha: cfg.backgroundRgba === null ? "straight" : "opaque",
          fit: "contain-pad",
          colorSpace: "srgb",
        });

        const canonicalPngDigest = sha256Hex(canonicalRaster.pngBytes);
        const generatedPngDigest = sha256Hex(generatedRaster.pngBytes);

        let pixelDiffCount = 0;
        const width = cfg.width;
        for (let i = 0; i < canonicalRaster.rgba8.length; i += 4) {
          if (
            canonicalRaster.rgba8[i] !== generatedRaster.rgba8[i] ||
            canonicalRaster.rgba8[i + 1] !== generatedRaster.rgba8[i + 1] ||
            canonicalRaster.rgba8[i + 2] !== generatedRaster.rgba8[i + 2] ||
            canonicalRaster.rgba8[i + 3] !== generatedRaster.rgba8[i + 3]
          ) {
            pixelDiffCount++;
            const pixelIndex = i / 4;
            const px = pixelIndex % width;
            const py = Math.floor(pixelIndex / width);
            if (px < minDiffX) minDiffX = px;
            if (px > maxDiffX) maxDiffX = px;
            if (py < minDiffY) minDiffY = py;
            if (py > maxDiffY) maxDiffY = py;
          }
        }

        totalChangedPixels += pixelDiffCount;
        rasterOutputs.push({
          width: cfg.width,
          height: cfg.height,
          background: cfg.backgroundName,
          canonicalPngDigest,
          generatedPngDigest,
          pixelsDifferent: pixelDiffCount,
          match: pixelDiffCount === 0,
        });
      }

      if (totalChangedPixels !== 0) {
        throw new Error(`Raster comparison failed for ${destination}: ${totalChangedPixels} changed pixels!`);
      }

      // Outcome M is a migration candidate only when the destination really
      // differs byte-for-byte.  An already canonical destination is explicit
      // parity (P), never a migration.
      const disposition = structuralMatch ? (bytesEqual ? "P" : "M") : "blocked";
      const status = disposition === "P"
        ? "qualified-exact-parity"
        : disposition === "M"
          ? "qualified-normalization-migration-candidate"
          : "blocked-structural-mismatch";
      const row = {
        assetId: asset.id,
        destination,
        canonicalSourcePath: sourcePath,
        canonicalSourceDigest: sourceDigest,
        canonicalTrackedDestinationDigest: canonicalDestDigest,
        generatedDigest,
        generatedBytes: generatedBytes.byteLength,
        bytesEqual,
        lexicalDiffClassification: lexicalDiffs,
        parsedCanonicalSourceSvgDigest: sourceSemanticDigest,
        parsedCanonicalDestinationSvgDigest: canonicalSemanticDigest,
        parsedGeneratedSvgDigest: generatedSemanticDigest,
        rootElement: { canonical: canonicalRaw.rootElement, generated: generatedRaw.rootElement },
        namespace: { canonical: canonicalRaw.namespace, generated: generatedRaw.namespace },
        dimensions: { canonical: canonicalRaw, generated: generatedRaw, parsedCanvas: canonicalModel.canvas },
        structuralComparison: {
          match: structuralMatch,
          canonicalStructureDigest: canonicalModel.structureDigest,
          generatedStructureDigest: generatedModel.structureDigest,
          canonicalDefinitionsDigest: canonicalModel.definitionsDigest,
          generatedDefinitionsDigest: generatedModel.definitionsDigest,
          canonicalElementsDigest: canonicalModel.elementsDigest,
          generatedElementsDigest: generatedModel.elementsDigest,
        },
        geometryDigest: { canonical: canonicalModel.geometryDigest, generated: generatedModel.geometryDigest },
        paintDigest: { canonical: canonicalModel.paintDigest, generated: generatedModel.paintDigest },
        definedIds: { canonical: canonicalRaw.ids, generated: generatedRaw.ids },
        references: { canonical: canonicalRaw.references, generated: generatedRaw.references },
        accessibilityMapping: { canonical: canonicalRaw.accessibility, generated: generatedRaw.accessibility, parsed: canonicalModel.accessibility },
        externalArtifactsInventory: { canonical: canonicalRaw.externalArtifacts, generated: generatedRaw.externalArtifacts },
        renderer: {
          adapterId: resvgDescriptor.adapterId,
          version: resvgDescriptor.rendererVersion,
          buildDigest: resvgDescriptor.rendererBuildDigest,
          qualificationId: resvgDescriptor.qualificationId,
          platformClaim: resvgDescriptor.platformClaim,
        },
        rasterOutputs,
        totalChangedPixels,
        pixelDifferenceBounds: totalChangedPixels === 0 ? null : { minDiffX, minDiffY, maxDiffX, maxDiffY },
        ownerProvenanceContinuity: provenance
          ? `Theme Forge Terminal Nova canonical ${provenance.canonical.commit}/${provenance.canonical.tree}; ${provenance.generator.path} ${provenance.generator.sha256}`
          : "Theme Forge Terminal Nova project; brand/libexec/build.py generator provenance preserved",
        rollbackBytesSha256: canonicalDestDigest,
        disposition,
        status,
        provenance: provenance
          ? {
            canonical: provenance.canonical,
            generator: provenance.generator,
            source: { path: sourcePath, sha256: sourceDigest },
            destination: { path: destination, sha256: canonicalDestDigest },
          }
          : null,
        evidenceReferences: [
          disposition === "P" ? "Exact canonical byte parity; no migration required" : "TFSB48-R1 Section 7 Outcome M",
          "Deterministic zero-pixel raster proof under pinned resvg-png-v1",
          structuralMatch ? "Equal parsed semantic, structure, geometry, paint, accessibility, ID, reference, and external-artifact inventories" : "Structural comparison mismatch",
        ],
      };

      parityRows.push(row);
      migrationPatchFiles.set(destination, {
        originalBytes: canonicalDestBytes,
        generatedBytes,
      });
    }
  }

  // Generate external migration patch and rollback archive in scratch directory
  const patchDir = join(scratchRoot, "terminal-nova-migration-bundle");
  await mkdir(patchDir, { recursive: true });

  const patchLines = [];
  const differingRows = parityRows.filter((row) => row.canonicalTrackedDestinationDigest !== row.generatedDigest);
  const differingDestinations = differingRows.map((row) => row.destination);
  for (const dest of differingDestinations) {
    const entry = migrationPatchFiles.get(dest);
    if (!entry) throw new Error(`Migration patch input missing for ${dest}.`);
    const origStr = entry.originalBytes.toString("utf8");
    const genStr = entry.generatedBytes.toString("utf8");

    // Write temporary files to diff
    const origFile = join(patchDir, "orig.svg");
    const genFile = join(patchDir, "gen.svg");
    await writeFile(origFile, origStr);
    await writeFile(genFile, genStr);

    try {
      const diffOut = execFileSync("diff", ["-u", `--label=a/${dest}`, `--label=b/${dest}`, origFile, genFile], { encoding: "utf8" });
      throw new Error(`Expected differing SVG bytes for ${dest}, but diff exited 0.`);
    } catch (e) {
      const errAny = /** @type {any} */ (e);
      if (errAny?.status !== 1) throw e;
      if (typeof errAny.stdout !== "string" || errAny.stdout.length === 0) throw new Error(`Migration patch section for ${dest} is empty.`);
      patchLines.push(errAny.stdout.endsWith("\n") ? errAny.stdout : `${errAny.stdout}\n`);
    }
  }

  const migrationPatch = patchLines.join("");
  const patchPath = join(scratchRoot, `${prefix}-migration.patch`);
  await writeFile(patchPath, migrationPatch, "utf8");
  const migrationPatchReadback = await readFile(patchPath, "utf8");
  if (migrationPatchReadback !== migrationPatch) throw new Error("Migration patch readback differs from the composed patch.");
  const migrationPatchSha256 = sha256Hex(migrationPatchReadback);

  const sections = patchSections(migrationPatchReadback);
  assertExactPathSet([...sections.keys()], differingDestinations, "migration patch");
  for (const destination of differingDestinations) {
    const section = sections.get(destination);
    if (section === undefined || section.length === 0) throw new Error(`Migration patch section for ${destination} is empty.`);
  }

  // Generate rollback archive zip containing original bytes
  /** @type {Record<string, Uint8Array>} */
  const rollbackFiles = {};
  for (const [dest, entry] of [...migrationPatchFiles.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    rollbackFiles[dest] = new Uint8Array(entry.originalBytes);
  }
  const rollbackZipBytes = fflate.zipSync(rollbackFiles, { level: 9, mtime: new Date("2026-01-01T00:00:00Z") });
  const rollbackZipPath = join(scratchRoot, `${prefix}-rollback.zip`);
  await writeFile(rollbackZipPath, rollbackZipBytes);
  const rollbackZipReadbackBytes = await readFile(rollbackZipPath);
  const rollbackZipSha256 = sha256Hex(rollbackZipReadbackBytes);

  // Independently read back every ZIP member.  The in-memory object used to
  // build the archive is not evidence that the archive contains the same
  // names or bytes.
  const rollbackEntries = fflate.unzipSync(new Uint8Array(rollbackZipReadbackBytes));
  const rollbackEntryPaths = Object.keys(rollbackEntries).sort();
  assertExactPathSet(rollbackEntryPaths, trackedDestinations, "rollback archive");
  const rollbackReadback = [];
  for (const destination of rollbackEntryPaths) {
    const bytes = rollbackEntries[destination];
    if (bytes === undefined) throw new Error(`Rollback archive entry disappeared for ${destination}.`);
    const digest = sha256Hex(bytes);
    const row = parityRows.find((candidate) => candidate.destination === destination);
    if (!row) throw new Error(`Rollback archive contains untracked destination ${destination}.`);
    if (digest !== row.canonicalTrackedDestinationDigest) throw new Error(`Rollback bytes mismatch for ${destination}.`);
    rollbackReadback.push({ destination, sha256: digest, bytes: bytes.byteLength });
    row.rollbackReadback = { destination, sha256: digest, bytes: bytes.byteLength, exact: true };
  }

  return {
    rows: parityRows,
    summary: {
      totalEvaluated: parityRows.length,
      outcomeMCount: parityRows.filter((r) => r.disposition === "M").length,
      outcomePCount: parityRows.filter((r) => r.disposition === "P").length,
      exactParityCount: parityRows.filter((r) => r.disposition === "P").length,
      migrationRequiredCount: differingRows.length,
      unresolvedCount: parityRows.filter((r) => r.disposition === "blocked").length,
      zeroChangedPixelsAll: parityRows.every((r) => r.totalChangedPixels === 0),
      trackedDestinationPaths: [...trackedDestinations].sort(),
      migrationPatchDestinationPaths: [...sections.keys()].sort(),
      rollbackEntryPaths,
      rollbackReadback,
      rollbackArchiveReadbackSha256: rollbackZipSha256,
      migrationPatchPath: patchPath,
      migrationPatchSha256,
      rollbackArchivePath: rollbackZipPath,
      rollbackArchiveSha256: rollbackZipSha256,
    },
  };
}
