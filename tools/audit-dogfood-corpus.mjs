#!/usr/bin/env node
// @ts-check

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { DOMParser } from "@xmldom/xmldom";

const SAMPLE_LIMIT = 5;
const SHARD_SIZE = 128;
const SELECTED_ENTRY_BYTES = 8 * 1024 * 1024;
const SELECTED_AGGREGATE_BYTES = 32 * 1024 * 1024;
const ACTIVE_ELEMENTS = new Set(["script", "foreignObject", "iframe", "object", "embed"]);
const PAINT_ATTRIBUTES = new Set(["fill", "stroke", "color", "stop-color", "flood-color", "lighting-color"]);
const REFERENCE_ATTRIBUTES = new Set(["href", "xlink:href", "src"]);
const LEGAL_DOCUMENT_RE = /(?:^|\/)(?:license|licence|notice|copying|copyright|trademark|brand|disclaimer|legal)(?:[._-]|$)/i;
const RELEVANT_DOCUMENT_RE = /(?:^|\/)(?:readme|contributing|license|licence|notice|copying|copyright|trademark|brand|disclaimer|legal)(?:[._-]|$)/i;

/** @typedef {{ code: string, source?: string }} ParserDiagnostic */
/** @typedef {{ ok: true, value: any } | { ok: false, diagnostics: readonly ParserDiagnostic[] }} ParseResult */
/** @typedef {{ ok: true, value: string } | { ok: false, diagnostics: readonly ParserDiagnostic[] }} SerializeResult */
/** @typedef {{ parseSvg(text: string, source?: string): ParseResult, serializeAssetToml(asset: any): string, serializeSvg(svg: any, source?: string): SerializeResult }} ProductParser */
/** @typedef {{ id: string, path: string, origin: string, revision: string, branch: string | null, dirty: boolean, shallow: boolean, trackedTreeEntries?: number, trackedTreeBytes?: number, trackedSvgCount?: number, trackedSvgBytes?: number }} CorpusInput */
/** @typedef {Record<string, number>} Counts */

/** @param {Counts} counts @param {string} key @param {number} [amount] */
function increment(counts, key, amount = 1) {
  counts[key] = (counts[key] ?? 0) + amount;
}

/** @param {Map<string, string[]>} groups @param {string} key @param {string} path */
function addGroup(groups, key, path) {
  const values = groups.get(key);
  if (values === undefined) groups.set(key, [path]);
  else values.push(path);
}

/** @param {Map<string, string[]>} groups */
function summarizeCollisionGroups(groups) {
  const collisions = [...groups.entries()]
    .filter(([, paths]) => paths.length > 1)
    .sort(([left], [right]) => compareText(left, right));
  return {
    groups: collisions.length,
    affectedFiles: collisions.reduce((total, [, paths]) => total + paths.length, 0),
    samples: collisions.slice(0, SAMPLE_LIMIT).map(([key, paths]) => ({
      key,
      paths: [...paths].sort(compareText).slice(0, SAMPLE_LIMIT),
      totalPaths: paths.length,
    })),
  };
}

/** @param {Map<string, string[]>} groups */
function collisionExcess(groups) {
  return [...groups.values()].reduce((total, paths) => total + Math.max(0, paths.length - 1), 0);
}

/** @param {string} left @param {string} right */
function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** @param {Counts} counts */
function sortedCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareText(left, right)));
}


/** @param {string} value */
function portableKey(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

/** @param {string} path */
function deriveAssetId(path) {
  const leaf = basename(path);
  const stem = leaf.slice(0, -4).normalize("NFC");
  const id = stem.toLowerCase().replace(/[ _]+/g, "-");
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ? id : null;
}

/** @param {string} path */
function isCompanionCandidate(path) {
  const leaf = basename(path).toLowerCase();
  return [".md", ".markdown", ".txt"].includes(extname(leaf)) ||
    ["license", "licence", "notice", "copying", "copyright"].includes(leaf);
}

/** @param {string} path */
function isDocumentationPath(path) {
  const extension = extname(basename(path)).toLowerCase();
  return extension === "" || [".md", ".markdown", ".txt"].includes(extension);
}

/** @param {string} value */
function rootValueFamily(value) {
  const trimmed = value.trim();
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) return "number";
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|pc|mm|cm|in|em|rem)$/i.test(trimmed)) return "length";
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)%$/.test(trimmed)) return "percent";
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:\s+-?(?:\d+(?:\.\d+)?|\.\d+)){3}$/.test(trimmed)) return "four-numbers";
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(trimmed)) return `keyword:${trimmed}`;
  return "other";
}

/** @param {string} value */
function paintFamily(value) {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  if (lower === "none") return "none";
  if (lower === "currentcolor") return "currentColor";
  if (/^#[0-9a-f]{3,8}$/i.test(normalized)) return "hex";
  if (/^rgba?\(/i.test(normalized)) return "rgb";
  if (/^hsla?\(/i.test(normalized)) return "hsl";
  if (/^var\(/i.test(normalized)) return "cssVariable";
  if (/^url\(\s*['\"]?#/i.test(normalized)) return "urlLocal";
  if (/^url\(/i.test(normalized)) return "urlExternal";
  if (/^[A-Za-z][A-Za-z0-9-]*$/.test(normalized)) return "keyword";
  return "other";
}

/** @param {string} value */
function referenceFamily(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return "local";
  if (/^(?:https?:|data:|file:|\/\/)/i.test(trimmed)) return "external";
  return "relative";
}

/** @param {string} code */
function diagnosticClass(code) {
  if (code === "XML_SYNTAX") return "xmlParseFailure";
  if (code === "XML_INVALID_ACCESSIBILITY") return "accessibilityPolicy";
  if (code === "XML_LIMIT_EXCEEDED" || code.startsWith("ARCHIVE_LIMIT")) return "resourceLimit";
  return "unsupportedSchema1";
}

/** @param {string[]} paths */
function commonPrefixes(paths) {
  /** @type {Counts} */
  const counts = {};
  for (const path of paths) {
    const parts = path.split("/");
    for (let depth = 1; depth <= Math.min(3, parts.length - 1); depth += 1) {
      increment(counts, parts.slice(0, depth).join("/"));
    }
  }
  return Object.entries(counts)
    .filter(([, count]) => count > 1)
    .sort(([leftKey, leftCount], [rightKey, rightCount]) => rightCount - leftCount || compareText(leftKey, rightKey))
    .slice(0, 20)
    .map(([prefix, count]) => ({ prefix, count }));
}

/**
 * Walk without following symlinks. Git-archive exports contain only tracked
 * entries, so this measures the pinned tree without consulting a worktree.
 * @param {string} root
 */
async function walkExport(root) {
  /** @type {{ path: string, bytes: number, regular: boolean }[]} */
  const files = [];
  /** @param {string} directory */
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const relativePath = relative(root, absolute).split(sep).join("/").normalize("NFC");
      if (entry.isDirectory()) await walk(absolute);
      else {
        const stat = await lstat(absolute);
        files.push({ path: relativePath, bytes: stat.size, regular: entry.isFile() });
      }
    }
  }
  await walk(root);
  return files;
}

/** @param {any} node */
function elementChildren(node) {
  const children = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === 1) children.push(child);
  }
  return children;
}

/** @param {string} text @param {string} path @param {any} profile @param {any} accessibility */
function inspectXml(text, path, profile, accessibility) {
  const commentMatches = text.match(/<!--/g)?.length ?? 0;
  const piMatches = text.match(/<\?(?!xml\b)/gi)?.length ?? 0;
  const doctypeMatches = text.match(/<!DOCTYPE\b/gi)?.length ?? 0;
  const entityMatches = text.match(/<!ENTITY\b/gi)?.length ?? 0;
  const cdataMatches = text.match(/<!\[CDATA\[/g)?.length ?? 0;
  for (const [key, count] of Object.entries({ comments: commentMatches, processingInstructions: piMatches, doctypes: doctypeMatches, entityDeclarations: entityMatches, cdata: cdataMatches })) {
    if (count > 0) {
      increment(profile.markupOccurrences, key, count);
      increment(profile.markupFiles, key);
    }
  }
  for (const match of text.matchAll(/url\(\s*['\"]?([^)'\"]+)/gi)) {
    increment(profile.rawUrlReferences, referenceFamily(match[1] ?? ""));
  }

  /** @type {string[]} */
  const parseErrors = [];
  const document = new DOMParser({ onError: (level, message) => { if (level === "error" || level === "fatalError") parseErrors.push(message); } })
    .parseFromString(text, "application/xml");
  if (parseErrors.length > 0 || document.documentElement === null) {
    increment(profile.inventoryParseFailures, "xmlParser");
    if (profile.inventoryFailureSamples.length < SAMPLE_LIMIT) profile.inventoryFailureSamples.push(path);
    return;
  }

  const root = document.documentElement;
  const elementNamesInFile = new Set();
  const featuresInFile = new Set();
  if (root.localName !== "svg") increment(profile.rootElementNames, root.localName || root.nodeName);
  const rootAttributes = {};
  for (let index = 0; index < root.attributes.length; index += 1) {
    const attribute = root.attributes.item(index);
    if (attribute === null) continue;
    increment(profile.rootAttributes, attribute.name);
    if (["width", "height", "viewBox", "role", "focusable"].includes(attribute.name)) {
      increment(rootAttributes, `${attribute.name}:${rootValueFamily(attribute.value)}`);
    }
  }
  for (const [key, count] of Object.entries(rootAttributes)) increment(profile.rootAttributeValueFamilies, key, count);

  const titleNodes = root.getElementsByTagName("title");
  const descNodes = root.getElementsByTagName("desc");
  if (titleNodes.length > 0) accessibility.title.files += 1;
  if (descNodes.length > 0) accessibility.desc.files += 1;
  const firstTitle = titleNodes.item(0);
  const firstDesc = descNodes.item(0);
  if (firstTitle?.getAttribute("id")) accessibility.title.withId += 1;
  if (firstDesc?.getAttribute("id")) accessibility.desc.withId += 1;
  for (const name of ["role", "aria-labelledby", "aria-hidden", "focusable", "width", "height", "viewBox"]) {
    const value = root.getAttribute(name);
    if (value !== null && value !== "") increment(accessibility.rootAttributes[name], rootValueFamily(value));
    else if (root.hasAttribute(name)) increment(accessibility.rootAttributes[name], "empty");
  }

  /** @param {any} element */
  function visit(element) {
    const name = element.localName || element.nodeName;
    increment(profile.elements, name);
    elementNamesInFile.add(name);
    if (ACTIVE_ELEMENTS.has(name)) {
      increment(profile.activeContent.elements, name);
      if (profile.activeContent.samples.length < SAMPLE_LIMIT && !profile.activeContent.samples.includes(path)) profile.activeContent.samples.push(path);
    }
    if (["path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "g", "use", "defs", "linearGradient", "radialGradient", "clipPath", "mask", "filter", "text", "image", "style", "animate", "animateTransform", "set"].includes(name)) {
      increment(profile.featureUsage, name);
      featuresInFile.add(name);
    }
    for (let index = 0; index < element.attributes.length; index += 1) {
      const attribute = element.attributes.item(index);
      if (attribute === null) continue;
      const attributeName = attribute.name;
      if (profile.attributesByElement[name] === undefined) profile.attributesByElement[name] = {};
      increment(profile.attributesByElement[name], attributeName);
      if (attribute.namespaceURI) increment(profile.namespaces, attribute.namespaceURI);
      if (attributeName.startsWith("data-")) increment(profile.presentationFields, "data-*");
      if (["fill-rule", "clip-rule", "opacity", "fill-opacity", "stroke-opacity", "class", "style"].includes(attributeName)) increment(profile.presentationFields, attributeName);
      if (/^on/i.test(attributeName)) {
        increment(profile.activeContent.eventAttributes, attributeName.toLowerCase());
        if (profile.activeContent.samples.length < SAMPLE_LIMIT && !profile.activeContent.samples.includes(path)) profile.activeContent.samples.push(path);
      }
      if (PAINT_ATTRIBUTES.has(attributeName)) increment(profile.paintValues, paintFamily(attribute.value));
      if (attributeName === "transform" || attributeName.endsWith("Transform")) {
        for (const match of attribute.value.matchAll(/([A-Za-z][A-Za-z0-9-]*)\s*\(/g)) increment(profile.transformFunctions, match[1] ?? "unknown");
      }
      if (REFERENCE_ATTRIBUTES.has(attributeName)) increment(profile.references, referenceFamily(attribute.value));
      for (const match of attribute.value.matchAll(/url\(\s*['\"]?([^)'\"]+)/gi)) increment(profile.references, referenceFamily(match[1] ?? ""));
    }
    if (element.namespaceURI) increment(profile.namespaces, element.namespaceURI);
    for (const child of elementChildren(element)) visit(child);
  }
  visit(root);
  for (const name of elementNamesInFile) increment(profile.elementFiles, name);
  for (const name of featuresInFile) increment(profile.featureFiles, name);
}

/** @param {number} entryCount @param {number} dataBytes @param {number} nameBytes @param {number} manifestBytes */
function projectedStoreZipBytes(entryCount, dataBytes, nameBytes, manifestBytes) {
  const manifestNameBytes = Buffer.byteLength("tfsb-manifest.json");
  const allEntries = entryCount + 1;
  return dataBytes + manifestBytes + (30 + 46) * allEntries + 2 * (nameBytes + manifestNameBytes) + 22;
}

/**
 * Audit one exported, pinned Git tree. The returned structure deliberately
 * omits input.path, timestamps, elapsed time, and host information.
 * @param {CorpusInput} input
 * @param {ProductParser} parser
 */
export async function auditCorpusDirectory(input, parser) {
  const root = resolve(input.path);
  const files = await walkExport(root);
  const svgFiles = files.filter((file) => file.regular && file.path.toLowerCase().endsWith(".svg"));
  const svgPaths = svgFiles.map((file) => file.path).sort(compareText);
  const allPaths = files.map((file) => file.path).sort(compareText);
  /** @type {Map<string, string[]>} */
  const basenames = new Map();
  /** @type {Map<string, string[]>} */
  const assetIds = new Map();
  /** @type {Map<string, string[]>} */
  const portablePaths = new Map();
  /** @type {Map<string, string[]>} */
  const compatibleAssetIds = new Map();
  /** @type {Counts} */
  const invalidIdentityReasons = {};
  /** @type {Counts} */
  const depthDistribution = {};
  for (const path of svgPaths) {
    addGroup(basenames, portableKey(basename(path)), path);
    addGroup(portablePaths, portableKey(path), path);
    const assetId = deriveAssetId(path);
    if (assetId === null) increment(invalidIdentityReasons, "not-lowercase-kebab-mappable");
    else addGroup(assetIds, assetId, path);
    increment(depthDistribution, String(path.split("/").length - 1));
  }

  const companionPaths = allPaths.filter(isCompanionCandidate);
  const documentPaths = allPaths.filter(isDocumentationPath);
  const relevantDocuments = documentPaths.filter((path) => RELEVANT_DOCUMENT_RE.test(path));
  const legalDocuments = documentPaths.filter((path) => LEGAL_DOCUMENT_RE.test(path));
  const totalSvgBytes = svgFiles.reduce((total, file) => total + file.bytes, 0);
  if (input.trackedSvgCount !== undefined && input.trackedSvgCount !== svgFiles.length) {
    throw new Error(`${input.id}: export SVG count ${svgFiles.length} differs from tracked-tree count ${input.trackedSvgCount}.`);
  }
  if (input.trackedSvgBytes !== undefined && input.trackedSvgBytes !== totalSvgBytes) {
    throw new Error(`${input.id}: export SVG bytes ${totalSvgBytes} differ from tracked-tree bytes ${input.trackedSvgBytes}.`);
  }
  const largestSvg = [...svgFiles].sort((left, right) => right.bytes - left.bytes || compareText(left.path, right.path))[0] ?? null;

  /** @type {any} */
  const profile = {
    elements: {}, attributesByElement: {}, namespaces: {}, rootAttributes: {}, rootAttributeValueFamilies: {}, rootElementNames: {},
    paintValues: {}, transformFunctions: {}, featureUsage: {}, featureFiles: {}, elementFiles: {}, presentationFields: {}, references: {}, rawUrlReferences: {},
    markupFiles: {}, markupOccurrences: {}, inventoryParseFailures: {}, inventoryFailureSamples: [],
    activeContent: { elements: {}, eventAttributes: {}, samples: [] },
  };
  /** @type {any} */
  const accessibility = {
    title: { files: 0, withId: 0 },
    desc: { files: 0, withId: 0 },
    rootAttributes: { role: {}, "aria-labelledby": {}, "aria-hidden": {}, focusable: {}, width: {}, height: {}, viewBox: {} },
  };
  /** @type {Counts} */
  const failureCodes = {};
  /** @type {Counts} */
  const failureClasses = {};
  /** @type {Record<string, string[]>} */
  const failureSamples = {};
  let compatible = 0;
  let compatibleSourceBytes = 0;
  let canonicalTomlBytes = 0;
  let canonicalTomlCount = 0;
  let serializedSvgBytes = 0;
  let serializedNameBytes = 0;
  let manifestBytes = 0;

  for (const file of svgFiles) {
    const absolute = resolve(root, file.path);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(absolute));
    } catch {
      increment(failureCodes, "ARCHIVE_INVALID_UTF8");
      increment(failureClasses, "xmlParseFailure");
      failureSamples.ARCHIVE_INVALID_UTF8 ??= [];
      if (failureSamples.ARCHIVE_INVALID_UTF8.length < SAMPLE_LIMIT) failureSamples.ARCHIVE_INVALID_UTF8.push(file.path);
      continue;
    }
    inspectXml(text, file.path, profile, accessibility);
    if (file.bytes > SELECTED_ENTRY_BYTES) {
      increment(failureCodes, "ARCHIVE_LIMIT_EXCEEDED");
      increment(failureClasses, "resourceLimit");
      failureSamples.ARCHIVE_LIMIT_EXCEEDED ??= [];
      if (failureSamples.ARCHIVE_LIMIT_EXCEEDED.length < SAMPLE_LIMIT) failureSamples.ARCHIVE_LIMIT_EXCEEDED.push(file.path);
      continue;
    }
    const parsed = parser.parseSvg(text, file.path);
    if (!parsed.ok) {
      const code = parsed.diagnostics[0]?.code ?? "UNKNOWN_DIAGNOSTIC";
      increment(failureCodes, code);
      increment(failureClasses, diagnosticClass(code));
      failureSamples[code] ??= [];
      if (failureSamples[code].length < SAMPLE_LIMIT) failureSamples[code].push(file.path);
      continue;
    }
    compatible += 1;
    compatibleSourceBytes += file.bytes;
    const id = deriveAssetId(file.path);
    if (id !== null) {
      addGroup(compatibleAssetIds, id, file.path);
      const asset = { schemaVersion: 1, id, filename: `${id}.svg`, svg: parsed.value };
      canonicalTomlBytes += Buffer.byteLength(parser.serializeAssetToml(asset));
      canonicalTomlCount += 1;
      const serialized = parser.serializeSvg(parsed.value, file.path);
      if (serialized.ok) {
        const bytes = Buffer.byteLength(serialized.value);
        serializedSvgBytes += bytes;
        serializedNameBytes += Buffer.byteLength(`${id}.svg`);
        manifestBytes += Buffer.byteLength(JSON.stringify({ type: "asset", name: `${id}.svg`, assetId: id, sha256: "0".repeat(64) })) + 8;
      }
    }
  }

  const importableTogether = canonicalTomlCount - collisionExcess(compatibleAssetIds);
  const provenanceTemplateBytes = 575;
  const manifestFixedBytes = 170;
  const listRecordBytes = 120;
  const previewCardBytes = 420;
  const fullBundlePossible = compatible <= SHARD_SIZE && compatibleSourceBytes <= SELECTED_AGGREGATE_BYTES;
  const shardCount = Math.min(SHARD_SIZE, compatible);
  const shardRatio = compatible === 0 ? 0 : shardCount / compatible;
  const shardSvgBytes = Math.ceil(serializedSvgBytes * shardRatio);
  const shardNameBytes = Math.ceil(serializedNameBytes * shardRatio);
  const shardManifestBytes = manifestFixedBytes + Math.ceil(manifestBytes * shardRatio);

  for (const element of Object.keys(profile.attributesByElement)) profile.attributesByElement[element] = sortedCounts(profile.attributesByElement[element]);
  profile.elements = sortedCounts(profile.elements);
  profile.namespaces = sortedCounts(profile.namespaces);
  profile.rootAttributes = sortedCounts(profile.rootAttributes);
  profile.rootAttributeValueFamilies = sortedCounts(profile.rootAttributeValueFamilies);
  profile.rootElementNames = sortedCounts(profile.rootElementNames);
  profile.paintValues = sortedCounts(profile.paintValues);
  profile.transformFunctions = sortedCounts(profile.transformFunctions);
  profile.featureUsage = sortedCounts(profile.featureUsage);
  profile.featureFiles = sortedCounts(profile.featureFiles);
  profile.elementFiles = sortedCounts(profile.elementFiles);
  profile.presentationFields = sortedCounts(profile.presentationFields);
  profile.references = sortedCounts(profile.references);
  profile.rawUrlReferences = sortedCounts(profile.rawUrlReferences);
  profile.markupFiles = sortedCounts(profile.markupFiles);
  profile.markupOccurrences = sortedCounts(profile.markupOccurrences);
  profile.inventoryParseFailures = sortedCounts(profile.inventoryParseFailures);
  profile.activeContent.elements = sortedCounts(profile.activeContent.elements);
  profile.activeContent.eventAttributes = sortedCounts(profile.activeContent.eventAttributes);
  for (const name of Object.keys(accessibility.rootAttributes)) accessibility.rootAttributes[name] = sortedCounts(accessibility.rootAttributes[name]);

  return {
    id: input.id,
    repository: {
      origin: input.origin,
      revision: input.revision,
      branch: input.branch,
      detached: input.branch === null,
      worktreeDirty: input.dirty,
      shallow: input.shallow,
    },
    trackedTree: {
      entries: input.trackedTreeEntries ?? files.length,
      bytes: input.trackedTreeBytes ?? files.reduce((total, file) => total + file.bytes, 0),
      svgCount: input.trackedSvgCount ?? svgFiles.length,
      svgBytes: input.trackedSvgBytes ?? totalSvgBytes,
    },
    auditExport: {
      entries: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
    },
    documents: {
      legalCandidates: legalDocuments.slice(0, 50),
      relevantCandidates: relevantDocuments.slice(0, 50),
      omittedRelevantCandidates: Math.max(0, relevantDocuments.length - 50),
    },
    scale: {
      svgCount: svgFiles.length,
      sourceBytes: totalSvgBytes,
      maximumSource: largestSvg === null ? null : { path: largestSvg.path, bytes: largestSvg.bytes },
      maximumDirectoryDepth: Math.max(0, ...svgPaths.map((path) => path.split("/").length - 1)),
      directoryDepthDistribution: sortedCounts(depthDistribution),
      commonPathPrefixes: commonPrefixes(svgPaths),
      duplicateBasenames: summarizeCollisionGroups(basenames),
      assetIdCollisions: summarizeCollisionGroups(assetIds),
      portablePathCollisions: summarizeCollisionGroups(portablePaths),
      invalidAssetIdentities: { count: Object.values(invalidIdentityReasons).reduce((total, count) => total + count, 0), reasons: sortedCounts(invalidIdentityReasons) },
      variantFamilies: summarizeCollisionGroups(basenames),
      companionCandidates: { count: companionPaths.length, paths: companionPaths.slice(0, 50), omitted: Math.max(0, companionPaths.length - 50) },
    },
    profile,
    accessibility,
    compatibility: {
      compatible,
      incompatible: svgFiles.length - compatible,
      failureCodes: sortedCounts(failureCodes),
      failureClasses: sortedCounts(failureClasses),
      failureSamples: Object.fromEntries(Object.entries(failureSamples).sort(([left], [right]) => compareText(left, right))),
      identityCollisionGroups: summarizeCollisionGroups(assetIds).groups,
      importableTogether,
    },
    projections: {
      basis: "Deterministic byte formulas over schema-1-compatible files; runtime and peak memory require separate measurement.",
      canonicalAssetToml: { count: canonicalTomlCount, bytes: canonicalTomlBytes },
      provenance: { records: canonicalTomlCount, approximateJsonBytes: 80 + canonicalTomlCount * provenanceTemplateBytes },
      manifest: { records: canonicalTomlCount, approximateJsonBytes: manifestFixedBytes + manifestBytes },
      machineResults: { fullRecordCount: canonicalTomlCount, approximateJsonBytes: 160 + canonicalTomlCount * listRecordBytes },
      humanResults: { summaryRecords: Math.min(SAMPLE_LIMIT, canonicalTomlCount), omittedRecords: Math.max(0, canonicalTomlCount - SAMPLE_LIMIT) },
      preview: {
        assetCount: canonicalTomlCount,
        approximateSinglePageBytes: 1_500 + canonicalTomlCount * previewCardBytes + serializedSvgBytes,
        scalePoints: [10, 100, 1_000, canonicalTomlCount].map((count) => ({ count, approximateIndexBytes: 1_500 + Math.min(count, canonicalTomlCount) * previewCardBytes + Math.ceil(serializedSvgBytes * (canonicalTomlCount === 0 ? 0 : Math.min(count, canonicalTomlCount) / canonicalTomlCount)) })),
      },
      bundle: {
        wholeCorpus: {
          possibleUnderCurrentLimits: fullBundlePossible,
          approximateStoreZipBytes: projectedStoreZipBytes(canonicalTomlCount, serializedSvgBytes, serializedNameBytes, manifestFixedBytes + manifestBytes),
        },
        selectedShard128: {
          possible: shardCount > 0,
          assetCount: shardCount,
          approximateStoreZipBytes: projectedStoreZipBytes(shardCount, shardSvgBytes, shardNameBytes, shardManifestBytes),
        },
      },
      planningRisk: {
        completeCanonicalBytes: canonicalTomlBytes,
        completeSerializedSvgBytes: serializedSvgBytes,
        currentSelectedAggregateLimitBytes: SELECTED_AGGREGATE_BYTES,
        requiresBoundedStaging: canonicalTomlBytes + serializedSvgBytes > SELECTED_AGGREGATE_BYTES,
      },
    },
  };
}

/** @param {any} value @returns {any} */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right)).map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

/** @param {any} value */
export function stableJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

/** @param {any} summary */
export function formatAuditMarkdown(summary) {
  const lines = [
    "# Deterministic dogfood corpus measurements",
    "",
    `Schema: ${summary.schema} v${summary.schemaVersion}. Samples are bounded to ${summary.sampleLimit} paths per failure class.`,
    "",
    "| Corpus | SVGs | Compatible | Asset-ID collision groups | Portable-path collision groups |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const corpus of summary.corpora) {
    lines.push(`| ${corpus.id} | ${corpus.scale.svgCount} | ${corpus.compatibility.compatible} | ${corpus.scale.assetIdCollisions.groups} | ${corpus.scale.portablePathCollisions.groups} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** @param {string[]} argv */
function parseArguments(argv) {
  /** @type {CorpusInput[]} */
  const corpora = [];
  let jsonOutput;
  let markdownOutput;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--corpus" && value !== undefined) {
      const parsed = JSON.parse(value);
      corpora.push(parsed);
      index += 1;
    } else if (argument === "--json-output" && value !== undefined) {
      jsonOutput = value;
      index += 1;
    } else if (argument === "--markdown-output" && value !== undefined) {
      markdownOutput = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument '${argument ?? ""}'.`);
    }
  }
  if (corpora.length === 0) throw new Error("At least one --corpus JSON argument is required.");
  return { corpora, jsonOutput, markdownOutput };
}

async function loadProductParser() {
  const productUrl = new URL("../dist/index.js", import.meta.url);
  try {
    const product = await import(productUrl.href);
    return {
      parseSvg: product.parseSvg,
      serializeAssetToml: product.serializeAssetToml,
      serializeSvg: product.serializeSvg,
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load compiled product from '${productUrl.href}': ${details}. Run 'npm run build' first.`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const parser = await loadProductParser();
  const corpora = [];
  for (const input of options.corpora.sort((left, right) => compareText(left.id, right.id))) corpora.push(await auditCorpusDirectory(input, parser));
  const summary = { schema: "tfsb-dogfood-corpus-audit", schemaVersion: 1, sampleLimit: SAMPLE_LIMIT, corpora };
  const json = stableJson(summary);
  const markdown = formatAuditMarkdown(summary);
  if (options.jsonOutput !== undefined) await writeFile(options.jsonOutput, json, "utf8");
  if (options.markdownOutput !== undefined) await writeFile(options.markdownOutput, markdown, "utf8");
  if (options.jsonOutput === undefined && options.markdownOutput === undefined) process.stdout.write(json);
  process.stderr.write(`audited ${corpora.length} corpus exports; sha256=${createHash("sha256").update(json).digest("hex")}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
