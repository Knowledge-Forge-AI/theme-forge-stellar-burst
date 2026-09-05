import { fail, fromCaught, ok, type DiagnosticContext, DiagnosticError } from "./diagnostics.js";
import type { SourceIdentityStrategy, SourceMapCollectionV1, SourceMapV1 } from "./source-map.js";
import type { Result } from "./types.js";

export const SOURCE_MAP_ID_MAX_BYTES = 64 as const;
export const PORTABLE_PATH_MAX_BYTES = 1024 as const;
export const PORTABLE_COMPONENT_MAX_BYTES = 255 as const;

export interface PortablePathOptions { readonly allowDot?: boolean }
export interface SourceSelectionCandidate { readonly sourcePath: string; readonly kind?: "file" | "directory" | "symlink" | "special" }
export interface SourceSelection {
  readonly collectionId: string;
  readonly sourcePath: string;
  readonly collectionPath: string;
}
export interface SourceIdentity extends SourceSelection { readonly assetId: string }
export interface SourceIdentityCandidate {
  readonly assetId: string;
  readonly utf8Bytes: number;
  readonly valid: boolean;
  readonly overflow: boolean;
}

function context(source?: string): DiagnosticContext {
  const safeSource = source !== undefined && !source.startsWith("/") && !source.includes("\\") && !/^[A-Za-z]:/.test(source) ? source : undefined;
  return { operation: "discover", domain: "source-identity", ...(safeSource === undefined ? {} : { source: safeSource }) };
}

export function portablePathKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

export function validatePortablePathValue(value: string, ctx: DiagnosticContext, location: string, options: PortablePathOptions = {}): string {
  if (options.allowDot === true && value === ".") return value;
  const components = value.split("/");
  const invalidForm = value === "" || value !== value.normalize("NFC") || value.includes("\\") || value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:/.test(value) || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value, "utf8") > PORTABLE_PATH_MAX_BYTES;
  const invalidComponent = components.some((component) => {
    if (component === "" || component === "." || component === ".." || /^ |[. ]$/u.test(component) || Buffer.byteLength(component, "utf8") > PORTABLE_COMPONENT_MAX_BYTES) return true;
    const basename = component.split(".", 1)[0]?.toLowerCase();
    return basename !== undefined && /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(basename);
  });
  if (invalidForm || invalidComponent) fail(ctx, "SOURCE_MAP_INVALID_PATH", "Path must satisfy the portable normalized relative-path contract.", location);
  return value;
}

export function validatePortablePath(value: string, options: PortablePathOptions = {}): Result<string> {
  const ctx = context();
  try { return ok(validatePortablePathValue(value, ctx, "path", options)); }
  catch (error) { return fromCaught(error, ctx, "SOURCE_MAP_INVALID_PATH", "Path is invalid.", (caught) => caught instanceof DiagnosticError); }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function withinTree(path: string, tree: string): boolean {
  return tree === "." || path === tree || path.startsWith(`${tree}/`);
}

function relativeToCollection(sourcePath: string, root: string): string | undefined {
  if (root === ".") return sourcePath;
  return sourcePath.startsWith(`${root}/`) ? sourcePath.slice(root.length + 1) : undefined;
}

function selectedBy(collection: SourceMapCollectionV1, path: string): boolean {
  const included = collection.includePaths.includes(path) || collection.includeTrees.some((tree) => withinTree(path, tree));
  if (!included) return false;
  if (collection.excludePaths.includes(path) || collection.excludeTrees.some((tree) => withinTree(path, tree))) return false;
  return !collection.entries.some((entry) => entry.kind === "exclusion" && entry.sourcePath === path);
}

export function evaluateSourceMapSelection(map: SourceMapV1, candidates: readonly SourceSelectionCandidate[], source?: string): Result<readonly SourceSelection[]> {
  const ctx = context(source);
  try {
    const exact = new Set<string>();
    const portable = new Map<string, string>();
    const sorted = [...candidates].sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath));
    for (const candidate of sorted) {
      validatePortablePathValue(candidate.sourcePath, ctx, candidate.sourcePath);
      const key = portablePathKey(candidate.sourcePath);
      if (exact.has(candidate.sourcePath) || portable.has(key)) {
        fail(ctx, "SOURCE_PATH_COLLISION", "Candidate paths are not exact and portably unique.", candidate.sourcePath);
      }
      exact.add(candidate.sourcePath);
      portable.set(key, candidate.sourcePath);
    }
    const selections: SourceSelection[] = [];
    const owners = new Map<string, string>();
    for (const candidate of sorted) {
      for (const collection of map.collections) {
        const collectionPath = relativeToCollection(candidate.sourcePath, collection.root);
        if (collectionPath === undefined || !selectedBy(collection, collectionPath)) continue;
        if (candidate.kind !== undefined && candidate.kind !== "file") {
          fail(ctx, candidate.kind === "symlink" ? "DIRECTORY_SYMLINK" : "DIRECTORY_SPECIAL_FILE", "Selected source must be a regular file.", candidate.sourcePath);
        }
        if (!collectionPath.endsWith(".svg")) fail(ctx, "SOURCE_MAP_INVALID_SVG_PATH", "Selected source must use the lowercase .svg suffix.", candidate.sourcePath);
        const previous = owners.get(candidate.sourcePath);
        if (previous !== undefined) fail(ctx, "SOURCE_PATH_MULTIPLE_COLLECTIONS", `Selected source is owned by both '${previous}' and '${collection.id}'.`, candidate.sourcePath);
        owners.set(candidate.sourcePath, collection.id);
        selections.push({ collectionId: collection.id, sourcePath: candidate.sourcePath, collectionPath });
      }
    }
    return ok(selections.sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath)));
  } catch (error) {
    return fromCaught(error, ctx, "SOURCE_IDENTITY_FAILED", "Source selection failed.", (caught) => caught instanceof DiagnosticError);
  }
}

function foldComponent(value: string): string {
  return value.normalize("NFC").replace(/[A-Z]/g, (character) => character.toLowerCase()).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function deriveSourceMapIdCandidate(path: string, strategy: Exclude<SourceIdentityStrategy, "explicit">, prefix = ""): SourceIdentityCandidate {
  const withoutSuffix = path.endsWith(".svg") ? path.slice(0, -4) : path;
  const parts = strategy === "basename" ? [withoutSuffix.split("/").at(-1) ?? ""] : withoutSuffix.split("/");
  const assetId = `${prefix}${parts.map(foldComponent).filter(Boolean).join("-")}`;
  const utf8Bytes = Buffer.byteLength(assetId, "utf8");
  return { assetId, utf8Bytes, valid: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(assetId), overflow: utf8Bytes > SOURCE_MAP_ID_MAX_BYTES };
}

export function deriveSourceMapId(path: string, strategy: SourceIdentityStrategy, prefix = "", override?: string, source?: string): Result<string> {
  const ctx = context(source);
  try {
    validatePortablePathValue(path, ctx, path);
    if (!path.endsWith(".svg")) fail(ctx, "SOURCE_MAP_INVALID_SVG_PATH", "Selected source must use the lowercase .svg suffix.", path);
    if (!/^(?:|[a-z0-9]+(?:-[a-z0-9]+)*-)$/.test(prefix)) {
      fail(ctx, "SOURCE_MAP_INVALID_PREFIX", "Prefix must be empty or canonical kebab text ending in '-'.", path);
    }
    let assetId = override;
    if (assetId === undefined) {
      if (strategy === "explicit") fail(ctx, "SOURCE_IDENTITY_OVERRIDE_REQUIRED", "Explicit identity requires an exact override.", path);
      assetId = deriveSourceMapIdCandidate(path, strategy, prefix).assetId;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(assetId)) fail(ctx, "SOURCE_IDENTITY_INVALID", "Source-map asset ID must use canonical kebab grammar.", path);
    if (Buffer.byteLength(assetId, "utf8") > SOURCE_MAP_ID_MAX_BYTES) fail(ctx, "SOURCE_IDENTITY_TOO_LONG", "Source-map asset ID exceeds 64 UTF-8 bytes.", path);
    return ok(assetId);
  } catch (error) {
    return fromCaught(error, ctx, "SOURCE_IDENTITY_FAILED", "Source identity derivation failed.", (caught) => caught instanceof DiagnosticError);
  }
}

export function deriveSourceMapIdentities(map: SourceMapV1, selections: readonly SourceSelection[], source?: string): Result<readonly SourceIdentity[]> {
  const ctx = context(source);
  try {
    const identities: SourceIdentity[] = [];
    const ids = new Map<string, string[]>();
    for (const selection of [...selections].sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath))) {
      const collection = map.collections.find((item) => item.id === selection.collectionId);
      if (collection === undefined) fail(ctx, "SOURCE_IDENTITY_COLLECTION_MISSING", "Selection refers to an unknown collection.", selection.sourcePath);
      const override = collection.entries.find((entry) => entry.kind === "override" && entry.sourcePath === selection.collectionPath);
      const derived = deriveSourceMapId(selection.collectionPath, collection.identity, collection.prefix, override?.kind === "override" ? override.assetId : undefined, source);
      if (!derived.ok) throw new DiagnosticError(derived.diagnostics[0]!);
      identities.push({ ...selection, assetId: derived.value });
      const paths = ids.get(derived.value) ?? [];
      paths.push(selection.sourcePath);
      ids.set(derived.value, paths);
    }
    const collision = [...ids.entries()].find(([, paths]) => paths.length > 1);
    if (collision !== undefined) {
      const [assetId, paths] = collision;
      fail(ctx, "SOURCE_IDENTITY_COLLISION", `Asset ID '${assetId}' collides for ${paths.slice(0, 5).join(", ")}.`, paths[0]);
    }
    return ok(identities);
  } catch (error) {
    return fromCaught(error, ctx, "SOURCE_IDENTITY_FAILED", "Source identity derivation failed.", (caught) => caught instanceof DiagnosticError);
  }
}
