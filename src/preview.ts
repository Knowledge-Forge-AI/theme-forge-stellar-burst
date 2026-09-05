import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, join } from "node:path";

import { inspectBuildSnapshot } from "./build.js";
import { computeRawSha256 } from "./digests.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import {
  durableWrite,
  optionalLstat,
  readRegularFileSnapshot,
  sameFileIdentity,
  syncPath,
  type FileIdentity,
  type FileSnapshot,
} from "./filesystem.js";
import {
  enforceMutationAssetLimit,
  loadCanonicalProject,
  verifyLoadedProjectSnapshot,
  type LoadedProject,
} from "./project.js";
import { compareUtf8 } from "./provenance.js";
import { findProjectRoot, resolveConfinedPath, validatePreviewOutputLayout } from "./root.js";
import { inspectPlanRetention, type PlanRetentionInspection } from "./plan-retention.js";
import { withCanonicalMutationLock } from "./transaction.js";
import { TOOL_VERSION } from "./version.js";

export const PREVIEW_MARKER_FILENAME = ".tfsb-preview.json";
export const PREVIEW_MARKER_KIND = "tfsb-preview-v1" as const;
export const DEFAULT_PREVIEW_OUTPUT = ".tfsb-preview";

const previewPlanBrand: unique symbol = Symbol("tfsb-preview-plan");
const SHA256 = /^[0-9a-f]{64}$/;
const SVG_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.svg$/;

export type PreviewGeometryProfile = "near_square" | "wide" | "tall";
export type PreviewBuildStatus = "clean" | "missing" | "byte_different" | "unavailable";
export type PreviewInstallStatus = "no_destinations" | "clean" | "missing" | "byte_different" | "unavailable" | "mixed";
export type PreviewDestinationState = "clean" | "missing" | "byte_different" | "unavailable";
export type PreviewOpenStatus = "not_requested" | "skipped" | "opened" | "failed";

export interface PreviewMarkerAsset {
  readonly id: string;
  readonly filename: string;
  readonly sha256: string;
}

export interface PreviewMarkerFile {
  readonly path: string;
  readonly sha256: string;
}

export interface PreviewMarker {
  readonly kind: typeof PREVIEW_MARKER_KIND;
  readonly schemaVersion: 1;
  readonly toolVersion: string;
  readonly outputDirectory: string;
  readonly files: readonly PreviewMarkerFile[];
  readonly assets: readonly PreviewMarkerAsset[];
}

export type PreviewMarkerReadResult =
  | { readonly status: "valid"; readonly marker: PreviewMarker }
  | { readonly status: "invalid" };

export interface PreviewDestinationStatus {
  readonly path: string;
  readonly status: PreviewDestinationState;
}

export interface PreviewAssetResult {
  readonly id: string;
  readonly filename: string;
  readonly geometryProfile: PreviewGeometryProfile;
  readonly sizes: readonly number[];
  readonly buildStatus: PreviewBuildStatus;
  readonly installStatus: PreviewInstallStatus;
  readonly destinations: readonly PreviewDestinationStatus[];
}

export interface PreviewCompanionResult {
  readonly file: string;
  readonly sha256: string;
  readonly installStatus: PreviewInstallStatus;
  readonly destinations: readonly PreviewDestinationStatus[];
}

export interface PreviewOpenResult {
  readonly requested: boolean;
  readonly status: PreviewOpenStatus;
}

export interface PreviewFilesResult {
  readonly index: "index.html";
  readonly stylesheet: "preview.css";
  readonly marker: typeof PREVIEW_MARKER_FILENAME;
  readonly assets: readonly string[];
}

export interface PreviewPlan {
  readonly outputDirectory: string;
  readonly replaced: boolean;
  readonly assetCount: number;
  readonly companionCount: number;
  readonly files: PreviewFilesResult;
  readonly assets: readonly PreviewAssetResult[];
  readonly companions: readonly PreviewCompanionResult[];
  readonly buildExtra: readonly string[];
  readonly openRequested: boolean;
  readonly [previewPlanBrand]: true;
}

export interface PreviewResult {
  readonly outputDirectory: string;
  readonly written: true;
  readonly replaced: boolean;
  readonly assetCount: number;
  readonly companionCount: number;
  readonly opened: PreviewOpenResult;
  readonly files: PreviewFilesResult;
  readonly assets: readonly PreviewAssetResult[];
  readonly companions: readonly PreviewCompanionResult[];
  readonly buildExtra: readonly string[];
}

export interface PreviewOpener {
  readonly interactive: boolean;
  readonly open: (path: string) => Promise<void>;
}

export interface PreviewOptions {
  readonly root?: string;
  readonly output?: string;
  readonly open?: boolean;
  readonly opener?: PreviewOpener;
}

export interface PreviewTransactionHooks {
  readonly afterStage?: () => void | Promise<void>;
  readonly afterBackup?: () => void | Promise<void>;
  /** Last cancellable point, immediately before the first target rename. */
  readonly beforePromotion?: () => void | Promise<void>;
  readonly afterPromote?: () => void | Promise<void>;
  readonly beforeBackupCleanup?: () => void | Promise<void>;
}

export interface PreviewPlanningHooks {
  readonly checkCancelled?: () => void | Promise<void>;
}

interface PreviewDirectorySnapshot {
  readonly kind: "directory";
  readonly rootIdentity: FileIdentity;
  readonly assetsIdentity: FileIdentity;
  readonly files: ReadonlyMap<string, FileSnapshot>;
  readonly marker: PreviewMarker;
}

type PreviewTargetSnapshot = { readonly kind: "absent" } | PreviewDirectorySnapshot;

interface PreviewPlanInternals {
  readonly root: string;
  readonly project: LoadedProject;
  readonly outputPath: string;
  readonly outputDirectory: string;
  readonly generatedFiles: ReadonlyMap<string, Uint8Array>;
  readonly targetSnapshot: PreviewTargetSnapshot;
  readonly opener: PreviewOpener;
  readonly openRequested: boolean;
}

const previewPlanInternals = new WeakMap<PreviewPlan, PreviewPlanInternals>();

function context(domain: DiagnosticContext["domain"] = "filesystem"): DiagnosticContext {
  return { operation: "preview", domain };
}

function identity(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeRelativeDirectory(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !value.includes("\\") && !value.includes("\0") &&
    !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function normalizeMarker(value: unknown): PreviewMarker | undefined {
  if (!isRecord(value) || !exactKeys(value, ["kind", "schemaVersion", "toolVersion", "outputDirectory", "files", "assets"]) ||
    value.kind !== PREVIEW_MARKER_KIND || value.schemaVersion !== 1 || typeof value.toolVersion !== "string" || value.toolVersion === "" || value.toolVersion.includes("\0") ||
    !safeRelativeDirectory(value.outputDirectory) || !Array.isArray(value.files) || !Array.isArray(value.assets)) return undefined;
  const files: PreviewMarkerFile[] = [];
  const filePaths = new Set<string>();
  for (const item of value.files) {
    if (!isRecord(item) || !exactKeys(item, ["path", "sha256"]) || typeof item.path !== "string" ||
      !(item.path === "index.html" || item.path === "preview.css" || /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.svg$/.test(item.path)) ||
      typeof item.sha256 !== "string" || !SHA256.test(item.sha256) || filePaths.has(item.path)) return undefined;
    filePaths.add(item.path);
    files.push({ path: item.path, sha256: item.sha256 });
  }
  const assets: PreviewMarkerAsset[] = [];
  const ids = new Set<string>();
  const filenames = new Set<string>();
  for (const item of value.assets) {
    if (!isRecord(item) || !exactKeys(item, ["id", "filename", "sha256"]) || typeof item.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) ||
      typeof item.filename !== "string" || !SVG_FILENAME.test(item.filename) || typeof item.sha256 !== "string" || !SHA256.test(item.sha256) || ids.has(item.id) || filenames.has(item.filename)) return undefined;
    ids.add(item.id);
    filenames.add(item.filename);
    assets.push({ id: item.id, filename: item.filename, sha256: item.sha256 });
  }
  files.sort((left, right) => compareUtf8(left.path, right.path));
  assets.sort((left, right) => compareUtf8(left.id, right.id));
  if (files.length !== assets.length + 2 || !files.some((item) => item.path === "index.html") || !files.some((item) => item.path === "preview.css")) return undefined;
  for (const asset of assets) {
    const file = files.find((item) => item.path === `assets/${asset.filename}`);
    if (file?.sha256 !== asset.sha256) return undefined;
  }
  return { kind: PREVIEW_MARKER_KIND, schemaVersion: 1, toolVersion: value.toolVersion, outputDirectory: value.outputDirectory, files, assets };
}

export function parsePreviewMarker(text: string): PreviewMarkerReadResult {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { status: "invalid" }; }
  const marker = normalizeMarker(value);
  return marker === undefined ? { status: "invalid" } : { status: "valid", marker };
}

export function serializePreviewMarker(marker: PreviewMarker): string {
  const normalized = normalizeMarker(marker);
  if (normalized === undefined) fail(context(), "PREVIEW_MARKER_INVALID", "Preview marker value is invalid.");
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function geometry(asset: LoadedProject["assets"][number]): { profile: PreviewGeometryProfile; sizes: readonly number[] } {
  const ratio = asset.svg.canvas.viewBox[2] / asset.svg.canvas.viewBox[3];
  if (ratio >= 0.8 && ratio <= 1.25) return { profile: "near_square", sizes: Object.freeze([16, 24, 32, 48, 64, 128, 256]) };
  if (ratio > 1.25) return { profile: "wide", sizes: Object.freeze([160, 320, 640]) };
  return { profile: "tall", sizes: Object.freeze([96, 192, 384]) };
}

function summarizeInstall(destinations: readonly PreviewDestinationStatus[]): PreviewInstallStatus {
  if (destinations.length === 0) return "no_destinations";
  const states = new Set(destinations.map((item) => item.status));
  return states.size === 1 ? destinations[0]!.status : "mixed";
}

async function inspectDestination(path: string, configured: string, expected: Uint8Array): Promise<PreviewDestinationStatus> {
  if (await optionalLstat(path) === undefined) return { path: configured, status: "missing" };
  try {
    const actual = await readRegularFileSnapshot(path, context(), "INSTALL_UNSAFE_DESTINATION", "Install destination is unavailable for safe preview inspection.");
    return { path: configured, status: Buffer.from(actual.bytes).equals(Buffer.from(expected)) ? "clean" : "byte_different" };
  } catch (error) {
    if (error instanceof DiagnosticError) return { path: configured, status: "unavailable" };
    throw error;
  }
}

async function deriveEvidence(project: LoadedProject): Promise<{
  assets: readonly PreviewAssetResult[];
  companions: readonly PreviewCompanionResult[];
  buildExtra: readonly string[];
}> {
  let buildUnavailable = false;
  let buildMissing = new Set<string>();
  let buildDifferent = new Set<string>();
  let buildExtra: readonly string[] = [];
  try {
    const build = await inspectBuildSnapshot(project, "preview");
    buildMissing = new Set(build.inspection.missing);
    buildDifferent = new Set(build.inspection.different);
    buildExtra = Object.freeze([...build.inspection.extra].sort(compareUtf8));
  } catch (error) {
    if (error instanceof DiagnosticError) buildUnavailable = true;
    else throw error;
  }
  const assets: PreviewAssetResult[] = [];
  for (const asset of [...project.assets].sort((left, right) => compareUtf8(left.id, right.id))) {
    const expected = project.outputs.get(asset.filename)!;
    const declaration = project.project.installs.find((item) => item.asset === asset.id);
    const resolved = project.installDestinations.get(asset.id) ?? [];
    const destinations: PreviewDestinationStatus[] = [];
    for (const [index, path] of resolved.entries()) destinations.push(await inspectDestination(path, declaration?.destinations[index] ?? "", expected));
    destinations.sort((left, right) => compareUtf8(left.path, right.path));
    const sizing = geometry(asset);
    const buildStatus: PreviewBuildStatus = buildUnavailable ? "unavailable" : buildMissing.has(asset.filename) ? "missing" : buildDifferent.has(asset.filename) ? "byte_different" : "clean";
    assets.push(Object.freeze({ id: asset.id, filename: asset.filename, geometryProfile: sizing.profile, sizes: sizing.sizes, buildStatus, installStatus: summarizeInstall(destinations), destinations: Object.freeze(destinations) }));
  }
  const declarations = new Map<string, LoadedProject["project"]["companions"][number]>(project.project.companions.map((item) => [item.file, item]));
  const companions: PreviewCompanionResult[] = [];
  for (const [file, bytes] of [...project.companions].sort(([left], [right]) => compareUtf8(left, right))) {
    const declaration = declarations.get(file);
    const resolved = project.companionDestinations.get(file) ?? [];
    const destinations: PreviewDestinationStatus[] = [];
    for (const [index, path] of resolved.entries()) destinations.push(await inspectDestination(path, declaration?.destinations[index] ?? "", bytes));
    destinations.sort((left, right) => compareUtf8(left.path, right.path));
    companions.push(Object.freeze({ file, sha256: computeRawSha256(bytes), installStatus: summarizeInstall(destinations), destinations: Object.freeze(destinations) }));
  }
  return { assets: Object.freeze(assets), companions: Object.freeze(companions), buildExtra };
}

const SURFACES = ["white", "light-gray", "charcoal", "black", "checkerboard"] as const;

function renderHtml(project: LoadedProject, assets: readonly PreviewAssetResult[], companions: readonly PreviewCompanionResult[], buildExtra: readonly string[]): string {
  const byId = new Map<string, LoadedProject["assets"][number]>(project.assets.map((asset) => [asset.id, asset]));
  const cards = assets.map((item) => {
    const asset = byId.get(item.id)!;
    const accessibility = asset.svg.accessibility;
    const title = "mode" in accessibility
      ? accessibility.mode === "labelled" ? accessibility.title : accessibility.mode === "decorative" ? "Decorative asset" : "Consumer-labelled asset"
      : accessibility.title;
    const description = "mode" in accessibility
      ? accessibility.mode === "labelled" ? accessibility.description ?? "" : accessibility.mode === "decorative" ? "Declared decorative; no accessible prose." : "Host-provided accessible name required."
      : accessibility.description;
    const alt = "mode" in accessibility
      ? accessibility.mode === "labelled" ? accessibility.title : accessibility.mode === "decorative" ? "" : "Host-provided accessible name required"
      : accessibility.title;
    const url = `assets/${encodeURIComponent(item.filename)}`;
    const surfaces = SURFACES.map((surface) => `<section class="surface surface-${surface}"><h3>${surface.replace("-", " ")}</h3><div class="size-strip">${item.sizes.map((size) => `<figure class="sample sample-${item.geometryProfile} size-${item.geometryProfile}-${size}"><img src="${url}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async"><figcaption>${size} px</figcaption></figure>`).join("")}</div></section>`).join("");
    const destinations = item.destinations.length === 0 ? "<li>Install: no destinations</li>" : item.destinations.map((destination) => `<li>Install ${escapeHtml(destination.path)}: ${escapeHtml(destination.status)}</li>`).join("");
    return `<article class="asset-card"><header><h2>${escapeHtml(item.id)}</h2><p class="filename">${escapeHtml(item.filename)}</p></header><p>${escapeHtml(description)}</p><dl><dt>Title</dt><dd class="asset-title">${escapeHtml(title)}</dd><dt>ViewBox</dt><dd>${escapeHtml(asset.svg.canvas.viewBox.join(" "))}</dd><dt>Geometry</dt><dd class="geometry-profile">${escapeHtml(item.geometryProfile)}</dd><dt>Build</dt><dd class="build-status">${escapeHtml(item.buildStatus)}</dd><dt>Install</dt><dd class="install-status">${escapeHtml(item.installStatus)}</dd></dl><ul class="destination-status">${destinations}</ul>${surfaces}</article>`;
  }).join("");
  const companionList = companions.length === 0 ? "<li>None</li>" : companions.map((item) => `<li><span class="companion-file">${escapeHtml(item.file)}</span> <code>${escapeHtml(item.sha256)}</code> <span>${escapeHtml(item.installStatus)}</span></li>`).join("");
  const extras = buildExtra.length === 0 ? "none" : buildExtra.map(escapeHtml).join(", ");
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self'; script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'">\n<title>${escapeHtml(project.project.name)} preview</title>\n<link rel="stylesheet" href="preview.css">\n</head>\n<body>\n<header class="page-header"><h1>${escapeHtml(project.project.name)}</h1><p>Static canonical preview</p><p>Build extras: ${extras}</p></header>\n<main>${cards}</main>\n<section class="companions"><h2>Companions</h2><p>Listed as opaque canonical files; never rendered or linked.</p><ul>${companionList}</ul></section>\n</body>\n</html>\n`;
}

const PREVIEW_CSS = `:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }\n* { box-sizing: border-box; }\nbody { margin: 0; background: #111827; color: #f8fafc; }\n.page-header, .companions { padding: 1.5rem; }\nmain { display: grid; gap: 1.5rem; padding: 1.5rem; }\n.asset-card { background: #1f2937; border: 1px solid #475569; border-radius: .75rem; padding: 1rem; overflow: hidden; }\n.asset-card header { display: flex; gap: 1rem; align-items: baseline; flex-wrap: wrap; }\n.filename, code { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }\ndl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem .75rem; }\ndt { font-weight: 700; }\ndd { margin: 0; }\n.surface { color: #111827; border-radius: .5rem; margin-top: .75rem; padding: .75rem; overflow: auto; }\n.surface h3 { margin: 0 0 .5rem; text-transform: capitalize; }\n.surface-white { background: #fff; }\n.surface-light-gray { background: #f0f0f0; }\n.surface-charcoal { background: #2d2d2d; color: #fff; }\n.surface-black { background: #000; color: #fff; }\n.surface-checkerboard { background-color: #fff; background-image: linear-gradient(45deg, #d1d5db 25%, transparent 25%), linear-gradient(-45deg, #d1d5db 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d1d5db 75%), linear-gradient(-45deg, transparent 75%, #d1d5db 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0; }\n.size-strip { display: flex; gap: 1rem; align-items: flex-end; min-height: 8rem; }\n.sample { display: grid; gap: .25rem; justify-items: center; margin: 0; flex: 0 0 auto; }\n.sample img { display: block; max-width: none; }\n${[16,24,32,48,64,128,256].map((size) => `.size-near_square-${size} img { width: ${size}px; height: ${size}px; }`).join("\n")}\n${[160,320,640].map((size) => `.size-wide-${size} img { width: ${size}px; height: auto; }`).join("\n")}\n${[96,192,384].map((size) => `.size-tall-${size} img { width: auto; height: ${size}px; }`).join("\n")}\nfigcaption { font-size: .75rem; }\n`;

function defaultOpener(): PreviewOpener {
  return {
    interactive: process.env.CI === undefined && process.stdout.isTTY === true,
    open: async (path) => {
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, [path], { shell: false, stdio: "ignore" });
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Preview opener failed.")));
      });
    },
  };
}

function samePreviewSnapshot(left: PreviewTargetSnapshot, right: PreviewTargetSnapshot): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "absent" || right.kind === "absent") return true;
  if (!sameFileIdentity(left.rootIdentity, right.rootIdentity) || !sameFileIdentity(left.assetsIdentity, right.assetsIdentity) || left.files.size !== right.files.size) return false;
  for (const [path, expected] of left.files) {
    const actual = right.files.get(path);
    if (actual?.kind !== "file" || expected.kind !== "file" || !sameFileIdentity(expected, actual) || expected.sha256 !== actual.sha256) return false;
  }
  return serializePreviewMarker(left.marker) === serializePreviewMarker(right.marker);
}

async function capturePreviewTarget(path: string, outputDirectory: string): Promise<PreviewTargetSnapshot> {
  const rootBefore = await optionalLstat(path);
  if (rootBefore === undefined) return { kind: "absent" };
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) fail(context(), "PREVIEW_UNOWNED_DIRECTORY", "Preview target is not a marker-owned non-symlink directory.", outputDirectory);
  const top = await readdir(path, { withFileTypes: true });
  const expectedTop = new Set(["index.html", "preview.css", PREVIEW_MARKER_FILENAME, "assets"]);
  if (top.length !== expectedTop.size || top.some((entry) => !expectedTop.has(entry.name)) || top.some((entry) => entry.name === "assets" ? !entry.isDirectory() || entry.isSymbolicLink() : !entry.isFile() || entry.isSymbolicLink())) {
    fail(context(), "PREVIEW_UNOWNED_DIRECTORY", "Preview target contains unexpected or unsafe content.", outputDirectory);
  }
  const assetsPath = join(path, "assets");
  const assetsBefore = await lstat(assetsPath);
  const assetEntries = await readdir(assetsPath, { withFileTypes: true });
  if (assetEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !SVG_FILENAME.test(entry.name))) {
    fail(context(), "PREVIEW_UNOWNED_DIRECTORY", "Preview asset inventory contains unsafe content.", outputDirectory);
  }
  const files = new Map<string, FileSnapshot>();
  for (const name of ["index.html", "preview.css", PREVIEW_MARKER_FILENAME]) {
    files.set(name, (await readRegularFileSnapshot(join(path, name), context(), "PREVIEW_UNOWNED_DIRECTORY", "Preview target contains an unsafe file.")).snapshot);
  }
  for (const entry of assetEntries.sort((left, right) => compareUtf8(left.name, right.name))) {
    files.set(`assets/${entry.name}`, (await readRegularFileSnapshot(join(assetsPath, entry.name), context(), "PREVIEW_UNOWNED_DIRECTORY", "Preview target contains an unsafe asset.")).snapshot);
  }
  const markerFile = files.get(PREVIEW_MARKER_FILENAME);
  const markerState = markerFile?.kind === "file" ? parsePreviewMarker(Buffer.from(markerFile.bytes).toString("utf8")) : { status: "invalid" as const };
  if (markerState.status !== "valid" || markerState.marker.outputDirectory !== outputDirectory) fail(context(), "PREVIEW_UNOWNED_DIRECTORY", "Preview target marker is invalid or does not match the configured output.", outputDirectory);
  const markerPaths = new Set(markerState.marker.files.map((item) => item.path));
  const actualPaths = [...files.keys()].filter((name) => name !== PREVIEW_MARKER_FILENAME);
  if (markerPaths.size !== actualPaths.length || actualPaths.some((name) => !markerPaths.has(name))) fail(context(), "PREVIEW_UNOWNED_DIRECTORY", "Preview target inventory does not match its marker.", outputDirectory);
  for (const item of markerState.marker.files) {
    const file = files.get(item.path);
    if (file?.kind !== "file" || file.sha256 !== item.sha256) fail(context(), "PREVIEW_UNOWNED_DIRECTORY", "Preview target bytes do not match its marker.", outputDirectory);
  }
  const rootAfter = await lstat(path);
  const assetsAfter = await lstat(assetsPath);
  if (!rootAfter.isDirectory() || rootAfter.isSymbolicLink() || !assetsAfter.isDirectory() || assetsAfter.isSymbolicLink() ||
    !sameFileIdentity(identity(rootBefore), identity(rootAfter)) || !sameFileIdentity(identity(assetsBefore), identity(assetsAfter))) {
    fail(context(), "PREVIEW_UNOWNED_DIRECTORY", "Preview target changed during ownership inspection.", outputDirectory);
  }
  return { kind: "directory", rootIdentity: identity(rootAfter), assetsIdentity: identity(assetsAfter), files, marker: markerState.marker };
}

function createMarker(outputDirectory: string, project: LoadedProject, files: ReadonlyMap<string, Uint8Array>): PreviewMarker {
  const assets = [...project.assets].sort((left, right) => compareUtf8(left.id, right.id)).map((asset) => ({ id: asset.id, filename: asset.filename, sha256: computeRawSha256(files.get(`assets/${asset.filename}`)!) }));
  const inventory = [...files].sort(([left], [right]) => compareUtf8(left, right)).map(([path, bytes]) => ({ path, sha256: computeRawSha256(bytes) }));
  return { kind: PREVIEW_MARKER_KIND, schemaVersion: 1, toolVersion: TOOL_VERSION, outputDirectory, files: inventory, assets };
}

export async function planPreviewWithHooks(options: PreviewOptions = {}, hooks: PreviewPlanningHooks = {}): Promise<PreviewPlan> {
  await hooks.checkCancelled?.();
  const root = await findProjectRoot(options.root, "preview", options.root !== undefined);
  const outputDirectory = options.output ?? DEFAULT_PREVIEW_OUTPUT;
  const outputPath = await resolveConfinedPath(root, outputDirectory, "preview");
  const project = await loadCanonicalProject(root, "preview");
  enforceMutationAssetLimit(project, "preview");
  validatePreviewOutputLayout(project.project, outputDirectory);
  const targetSnapshot = await capturePreviewTarget(outputPath, outputDirectory);
  await hooks.checkCancelled?.();
  const evidence = await deriveEvidence(project);
  const generatedFiles = new Map<string, Uint8Array>();
  generatedFiles.set("index.html", Buffer.from(renderHtml(project, evidence.assets, evidence.companions, evidence.buildExtra), "utf8"));
  generatedFiles.set("preview.css", Buffer.from(PREVIEW_CSS, "utf8"));
  for (const asset of [...project.assets].sort((left, right) => compareUtf8(left.id, right.id))) generatedFiles.set(`assets/${asset.filename}`, Buffer.from(project.outputs.get(asset.filename)!));
  await hooks.checkCancelled?.();
  const marker = createMarker(outputDirectory, project, generatedFiles);
  generatedFiles.set(PREVIEW_MARKER_FILENAME, Buffer.from(serializePreviewMarker(marker), "utf8"));
  await verifyLoadedProjectSnapshot(project, "preview");
  const fileResult = Object.freeze({ index: "index.html" as const, stylesheet: "preview.css" as const, marker: PREVIEW_MARKER_FILENAME, assets: Object.freeze(evidence.assets.map((asset) => `assets/${asset.filename}`)) });
  const plan = Object.freeze({ outputDirectory, replaced: targetSnapshot.kind === "directory", assetCount: evidence.assets.length, companionCount: evidence.companions.length, files: fileResult, assets: evidence.assets, companions: evidence.companions, buildExtra: evidence.buildExtra, openRequested: options.open === true, [previewPlanBrand]: true as const });
  await hooks.checkCancelled?.();
  previewPlanInternals.set(plan, { root, project, outputPath, outputDirectory, generatedFiles: new Map(generatedFiles), targetSnapshot, opener: options.opener ?? defaultOpener(), openRequested: options.open === true });
  return plan;
}

export async function planPreview(options: PreviewOptions = {}): Promise<PreviewPlan> {
  return planPreviewWithHooks(options, {});
}

async function openResult(internals: PreviewPlanInternals): Promise<PreviewOpenResult> {
  if (!internals.openRequested) return { requested: false, status: "not_requested" };
  if (!internals.opener.interactive) return { requested: true, status: "skipped" };
  try {
    await internals.opener.open(join(internals.outputPath, "index.html"));
    return { requested: true, status: "opened" };
  } catch {
    return { requested: true, status: "failed" };
  }
}

export async function executePreviewPlan(plan: PreviewPlan, hooks: PreviewTransactionHooks = {}): Promise<PreviewResult> {
  const internals = previewPlanInternals.get(plan);
  if (internals === undefined || !Object.isFrozen(plan) || !Object.isFrozen(plan.assets) || !Object.isFrozen(plan.companions)) fail(context("transaction"), "PREVIEW_INVALID_PLAN", "Preview plan is not authentic.");
  enforceMutationAssetLimit(internals.project, "preview");
  await withCanonicalMutationLock(internals.root, "preview", async () => {
    await verifyLoadedProjectSnapshot(internals.project, "preview");
    const initialTarget = await capturePreviewTarget(internals.outputPath, internals.outputDirectory);
    if (!samePreviewSnapshot(internals.targetSnapshot, initialTarget)) fail(context("transaction"), "PREVIEW_TARGET_CHANGED_DURING_PLAN", "Preview target changed after planning.", internals.outputDirectory);
    await resolveConfinedPath(internals.root, internals.outputDirectory, "preview");
    const parent = dirname(internals.outputPath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await resolveConfinedPath(internals.root, internals.outputDirectory, "preview");
    const token = randomUUID();
    const stage = join(parent, `.${basename(internals.outputPath)}.tfsb-stage-${token}`);
    const backup = join(parent, `.${basename(internals.outputPath)}.tfsb-backup-${token}`);
    let promoted = false;
    let backupCreated = false;
    try {
      await mkdir(stage, { mode: 0o700 });
      await mkdir(join(stage, "assets"), { mode: 0o700 });
      for (const [relativePath, bytes] of [...internals.generatedFiles].sort(([left], [right]) => compareUtf8(left, right))) await durableWrite(join(stage, relativePath), bytes);
      await syncPath(join(stage, "assets"));
      await syncPath(stage);
      const staged = await capturePreviewTarget(stage, internals.outputDirectory);
      if (staged.kind !== "directory") fail(context("transaction"), "PREVIEW_STAGE_INVALID", "Generated preview stage failed validation.");
      await hooks.afterStage?.();
      await verifyLoadedProjectSnapshot(internals.project, "preview");
      const beforeRename = await capturePreviewTarget(internals.outputPath, internals.outputDirectory);
      if (!samePreviewSnapshot(internals.targetSnapshot, beforeRename)) fail(context("transaction"), "PREVIEW_TARGET_CHANGED_DURING_PLAN", "Preview target changed after planning.", internals.outputDirectory);
      if (beforeRename.kind === "directory") {
        await hooks.beforePromotion?.();
        await rename(internals.outputPath, backup);
        backupCreated = true;
        await hooks.afterBackup?.();
      }
      if ((await optionalLstat(internals.outputPath)) !== undefined) fail(context("transaction"), "PREVIEW_TARGET_CHANGED_DURING_PLAN", "Preview target appeared during promotion.", internals.outputDirectory);
      if (beforeRename.kind !== "directory") await hooks.beforePromotion?.();
      await rename(stage, internals.outputPath);
      promoted = true;
      await hooks.afterPromote?.();
      try { await syncPath(parent); }
      catch { fail(context("transaction"), "PREVIEW_PARENT_FSYNC_FAILED", "New preview was promoted but parent-directory durability could not be confirmed.", internals.outputDirectory); }
      if (backupCreated) {
        try {
          await hooks.beforeBackupCleanup?.();
          await rm(backup, { recursive: true });
          backupCreated = false;
        } catch {
          fail(context("transaction"), "PREVIEW_BACKUP_CLEANUP_FAILED", "New preview is active but prior-preview backup cleanup failed.", internals.outputDirectory);
        }
        try { await syncPath(parent); }
        catch { fail(context("transaction"), "PREVIEW_CLEANUP_DURABILITY_FAILED", "Preview is active and backup was removed, but cleanup durability could not be confirmed.", internals.outputDirectory); }
      }
    } catch (error) {
      if (promoted) {
        throw error;
      }
      let rollbackFailed = false;
      if (backupCreated) await rename(backup, internals.outputPath).catch(() => { rollbackFailed = true; });
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      if (rollbackFailed) fail(context("transaction"), "PREVIEW_ROLLBACK_FAILED", "Preview promotion failed and the prior owned gallery could not be restored.", internals.outputDirectory);
      throw error;
    }
  });
  return Object.freeze({ outputDirectory: plan.outputDirectory, written: true as const, replaced: plan.replaced, assetCount: plan.assetCount, companionCount: plan.companionCount, opened: Object.freeze(await openResult(internals)), files: plan.files, assets: plan.assets, companions: plan.companions, buildExtra: plan.buildExtra });
}

export async function previewProject(options: PreviewOptions = {}, hooks: PreviewTransactionHooks = {}): Promise<PreviewResult> {
  return executePreviewPlan(await planPreview(options), hooks);
}

/** Internal retention seam; not re-exported by the package root. */
export function inspectPreviewPlanRetention(plan: PreviewPlan): PlanRetentionInspection {
  const internals = previewPlanInternals.get(plan);
  if (internals === undefined) throw new Error("Preview plan was not produced by this planner instance.");
  return inspectPlanRetention([plan, internals]);
}
