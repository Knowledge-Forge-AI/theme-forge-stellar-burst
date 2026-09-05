import { isAllowedCompanionFilename } from "./archive.js";
import { DiagnosticError, fail, fromCaught, ok, type DiagnosticContext } from "./diagnostics.js";
import { compareUtf8 } from "./provenance.js";
import type { AssetId, Result } from "./types.js";

export const BUNDLE_MANIFEST_KIND = "tfsb-bundle-manifest" as const;
export const BUNDLE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const BUNDLE_MANIFEST_SCHEMA_VERSION_V2 = 2 as const;
export const BUNDLE_MANIFEST_FILENAME = "tfsb-manifest.json" as const;
export const BUNDLE_MANIFEST_MAX_ENTRIES_V2 = 512 as const;

export interface BundleManifestGenerator {
  readonly name: string;
  readonly version: string;
}

export interface BundleManifestAssetRecord {
  readonly type: "asset";
  readonly name: string;
  readonly path?: string;
  readonly assetId: AssetId;
  readonly sha256: string;
}

export interface BundleManifestCompanionRecord {
  readonly type: "companion";
  readonly name: string;
  readonly path?: string;
  readonly sha256: string;
}

export type BundleManifestFileRecord =
  | BundleManifestAssetRecord
  | BundleManifestCompanionRecord;

export interface BundleManifestV1 {
  readonly kind: typeof BUNDLE_MANIFEST_KIND;
  readonly schemaVersion: typeof BUNDLE_MANIFEST_SCHEMA_VERSION;
  readonly generator: BundleManifestGenerator;
  readonly projectName?: string;
  readonly files: readonly BundleManifestFileRecord[];
}

export interface BundleManifestAssetRecordV2 {
  readonly type: "asset";
  readonly path: string;
  readonly name?: string;
  readonly assetId: AssetId;
  readonly sha256: string;
}

export interface BundleManifestCompanionRecordV2 {
  readonly type: "companion";
  readonly path: string;
  readonly name?: string;
  readonly sha256: string;
}

export interface BundleManifestFileRecordV2 {
  readonly type: "file";
  readonly path: string;
  readonly name?: string;
  readonly sha256: string;
}

export type BundleManifestRecordV2 =
  | BundleManifestAssetRecordV2
  | BundleManifestCompanionRecordV2
  | BundleManifestFileRecordV2;

export interface BundleManifestV2 {
  readonly kind: typeof BUNDLE_MANIFEST_KIND;
  readonly schemaVersion: typeof BUNDLE_MANIFEST_SCHEMA_VERSION_V2;
  readonly generator: BundleManifestGenerator;
  readonly projectName?: string;
  readonly files: readonly BundleManifestRecordV2[];
}

export type AnyBundleManifest = BundleManifestV1 | BundleManifestV2;

const TOP_KEYS = ["kind", "schemaVersion", "generator", "projectName", "files"] as const;
const GENERATOR_KEYS = ["name", "version"] as const;
const ASSET_RECORD_KEYS = ["type", "name", "assetId", "sha256"] as const;
const COMPANION_RECORD_KEYS = ["type", "name", "sha256"] as const;

const ASSET_RECORD_KEYS_V2 = ["type", "path", "assetId", "sha256"] as const;
const COMPANION_RECORD_KEYS_V2 = ["type", "path", "sha256"] as const;
const FILE_RECORD_KEYS_V2 = ["type", "path", "sha256"] as const;

const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

function context(source?: string): DiagnosticContext {
  return {
    operation: "parse",
    domain: "manifest",
    ...(source === undefined ? {} : { source }),
  };
}

function record(value: unknown, ctx: DiagnosticContext, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(ctx, "MANIFEST_INVALID_TYPE", "Manifest value must be an object.", location);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  ctx: DiagnosticContext,
  location: string,
): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allow.has(key));
  if (unknown !== undefined) {
    fail(ctx, "MANIFEST_UNKNOWN_FIELD", `Unknown manifest field '${unknown}'.`, `${location}.${unknown}`);
  }
}

function string(value: unknown, ctx: DiagnosticContext, location: string): string {
  if (typeof value !== "string") {
    fail(ctx, "MANIFEST_INVALID_TYPE", "Expected a string.", location);
  }
  return value;
}

function rawSha256Digest(value: unknown, ctx: DiagnosticContext, location: string): string {
  const text = string(value, ctx, location);
  if (!/^[0-9a-f]{64}$/.test(text)) {
    fail(ctx, "MANIFEST_INVALID_DIGEST", "Expected a lowercase 64-character hex sha256 digest.", location);
  }
  return text;
}

function validateRootEntryName(
  value: unknown,
  ctx: DiagnosticContext,
  location: string,
): { readonly name: string; readonly portableKey: string } {
  const name = string(value, ctx, location);
  if (
    name === "" ||
    name !== name.normalize("NFC") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name === "." ||
    name === ".." ||
    /^[A-Za-z]:/.test(name)
  ) {
    fail(ctx, "MANIFEST_INVALID_FILENAME", "Bundle entry name must be a portable root regular filename.", location);
  }
  if (name.toLowerCase() === BUNDLE_MANIFEST_FILENAME.toLowerCase()) {
    fail(ctx, "MANIFEST_INVALID_FILENAME", `Manifest entry name '${name}' is reserved.`, location);
  }
  const portableKey = name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return { name, portableKey };
}

export function validatePortablePathV2(
  value: unknown,
  ctx: DiagnosticContext,
  location: string,
): { readonly path: string; readonly portableKey: string } {
  const path = string(value, ctx, location);
  const totalBytes = Buffer.byteLength(path, "utf8");
  if (totalBytes < 1 || totalBytes > 1024) {
    fail(ctx, "MANIFEST_INVALID_PATH", `Path length ${totalBytes} bytes must be between 1 and 1024 bytes.`, location);
  }
  if (
    path !== path.normalize("NFC") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /[\x00-\x1F\x7F]/.test(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.startsWith("//")
  ) {
    fail(ctx, "MANIFEST_INVALID_PATH", `Path '${path}' must be a normalized NFC portable relative path.`, location);
  }

  const components = path.split("/");
  for (const component of components) {
    const compBytes = Buffer.byteLength(component, "utf8");
    if (compBytes < 1 || compBytes > 255) {
      fail(
        ctx,
        "MANIFEST_INVALID_PATH",
        `Path component '${component}' length ${compBytes} bytes must be between 1 and 255 bytes.`,
        location,
      );
    }
    if (component === "." || component === "..") {
      fail(ctx, "MANIFEST_INVALID_PATH", `Path '${path}' cannot contain dot components.`, location);
    }
    if (component.startsWith(" ") || component.endsWith(" ")) {
      fail(ctx, "MANIFEST_INVALID_PATH", `Path component '${component}' cannot have leading or trailing whitespace.`, location);
    }
    if (component.endsWith(".")) {
      fail(ctx, "MANIFEST_INVALID_PATH", `Path component '${component}' cannot have trailing dots.`, location);
    }
    const stem = component.split(".")[0]!.toLowerCase();
    if (WINDOWS_RESERVED_NAMES.has(stem)) {
      fail(
        ctx,
        "MANIFEST_INVALID_PATH",
        `Path component '${component}' uses reserved Windows device name '${stem}'.`,
        location,
      );
    }
  }

  const portableKey = components
    .map((comp) => comp.replace(/[A-Z]/g, (l) => l.toLowerCase()))
    .join("/");
  return { path, portableKey };
}

function validateAssetId(value: unknown, ctx: DiagnosticContext, location: string): AssetId {
  const text = string(value, ctx, location);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(text)) {
    fail(
      ctx,
      "MANIFEST_INVALID_ASSET_ID",
      `Asset id '${text}' must be lowercase alphanumeric with single hyphens.`,
      location,
    );
  }
  return text as AssetId;
}

function parseBundleManifestV1Internal(raw: Record<string, unknown>, ctx: DiagnosticContext, location: string): BundleManifestV1 {
  const rawGenerator = record(raw.generator, ctx, `${location}.generator`);
  exactKeys(rawGenerator, GENERATOR_KEYS, ctx, `${location}.generator`);
  const genName = string(rawGenerator.name, ctx, `${location}.generator.name`);
  const genVersion = string(rawGenerator.version, ctx, `${location}.generator.version`);
  if (genName.trim() === "" || genVersion.trim() === "") {
    fail(ctx, "MANIFEST_INVALID_GENERATOR", "Generator name and version must be non-empty.", `${location}.generator`);
  }
  const generator: BundleManifestGenerator = { name: genName, version: genVersion };

  let projectName: string | undefined;
  if (raw.projectName !== undefined) {
    const nameVal = string(raw.projectName, ctx, `${location}.projectName`);
    if (nameVal.trim() === "" || nameVal !== nameVal.normalize("NFC") || nameVal.includes("\0") || nameVal.includes("\n") || nameVal.includes("\r")) {
      fail(ctx, "MANIFEST_INVALID_PROJECT_NAME", "Project name must be non-empty valid text.", `${location}.projectName`);
    }
    projectName = nameVal;
  }

  if (!Array.isArray(raw.files)) {
    fail(ctx, "MANIFEST_INVALID_TYPE", "Expected an array of file entries.", `${location}.files`);
  }

  const seenPortableNames = new Map<string, string>();
  const seenAssetIds = new Map<string, string>();
  const files: BundleManifestFileRecord[] = [];

  for (let index = 0; index < raw.files.length; index += 1) {
    const entryLoc = `${location}.files[${index}]`;
    const entryRaw = record(raw.files[index], ctx, entryLoc);
    const type = string(entryRaw.type, ctx, `${entryLoc}.type`);

    if (type === "asset") {
      exactKeys(entryRaw, ASSET_RECORD_KEYS, ctx, entryLoc);
      const { name, portableKey } = validateRootEntryName(entryRaw.name, ctx, `${entryLoc}.name`);
      if (!name.endsWith(".svg")) {
        fail(ctx, "MANIFEST_INVALID_FILENAME", `Asset entry name '${name}' must end with '.svg'.`, `${entryLoc}.name`);
      }
      const assetId = validateAssetId(entryRaw.assetId, ctx, `${entryLoc}.assetId`);
      const sha256 = rawSha256Digest(entryRaw.sha256, ctx, `${entryLoc}.sha256`);

      const prevName = seenPortableNames.get(portableKey);
      if (prevName !== undefined) {
        fail(
          ctx,
          "MANIFEST_COLLISION",
          `Portable entry name collision between '${prevName}' and '${name}'.`,
          `${entryLoc}.name`,
        );
      }
      seenPortableNames.set(portableKey, name);

      const prevAssetId = seenAssetIds.get(assetId);
      if (prevAssetId !== undefined) {
        fail(
          ctx,
          "MANIFEST_COLLISION",
          `Duplicate asset id '${assetId}' across entries '${prevAssetId}' and '${name}'.`,
          `${entryLoc}.assetId`,
        );
      }
      seenAssetIds.set(assetId, name);

      files.push({ type: "asset", name, assetId, sha256 });
    } else if (type === "companion") {
      exactKeys(entryRaw, COMPANION_RECORD_KEYS, ctx, entryLoc);
      const { name, portableKey } = validateRootEntryName(entryRaw.name, ctx, `${entryLoc}.name`);
      if (!isAllowedCompanionFilename(name)) {
        fail(
          ctx,
          "MANIFEST_INVALID_FILENAME",
          `Companion entry '${name}' is not a supported companion document type.`,
          `${entryLoc}.name`,
        );
      }
      const sha256 = rawSha256Digest(entryRaw.sha256, ctx, `${entryLoc}.sha256`);

      const prevName = seenPortableNames.get(portableKey);
      if (prevName !== undefined) {
        fail(
          ctx,
          "MANIFEST_COLLISION",
          `Portable entry name collision between '${prevName}' and '${name}'.`,
          `${entryLoc}.name`,
        );
      }
      seenPortableNames.set(portableKey, name);

      files.push({ type: "companion", name, sha256 });
    } else {
      fail(ctx, "MANIFEST_INVALID_RECORD_TYPE", `Unknown manifest file record type '${type}'.`, `${entryLoc}.type`);
    }
  }

  // Check sorted order
  for (let index = 0; index < files.length - 1; index += 1) {
    const current = files[index]!;
    const next = files[index + 1]!;
    if (compareUtf8(current.name, next.name) >= 0) {
      fail(
        ctx,
        "MANIFEST_UNSORTED_FILES",
        `Manifest files array must be strictly sorted by entry name in ascending UTF-8 byte order ('${current.name}' before '${next.name}').`,
        `${location}.files`,
      );
    }
  }

  return {
    kind: BUNDLE_MANIFEST_KIND,
    schemaVersion: BUNDLE_MANIFEST_SCHEMA_VERSION,
    generator,
    ...(projectName === undefined ? {} : { projectName }),
    files,
  };
}

export function parseBundleManifestV2(text: string, location = BUNDLE_MANIFEST_FILENAME): Result<BundleManifestV2> {
  const ctx = context(location);
  try {
    const raw = record(JSON.parse(text), ctx, location);
    exactKeys(raw, TOP_KEYS, ctx, location);

    const kind = string(raw.kind, ctx, `${location}.kind`);
    if (kind !== BUNDLE_MANIFEST_KIND) {
      fail(ctx, "MANIFEST_UNSUPPORTED_KIND", `Unsupported manifest kind '${kind}'.`, `${location}.kind`);
    }

    const schemaVersion = raw.schemaVersion;
    if (schemaVersion !== BUNDLE_MANIFEST_SCHEMA_VERSION_V2) {
      fail(
        ctx,
        "MANIFEST_UNSUPPORTED_VERSION",
        `Unsupported manifest schema version '${schemaVersion}'.`,
        `${location}.schemaVersion`,
      );
    }

    const rawGenerator = record(raw.generator, ctx, `${location}.generator`);
    exactKeys(rawGenerator, GENERATOR_KEYS, ctx, `${location}.generator`);
    const genName = string(rawGenerator.name, ctx, `${location}.generator.name`);
    const genVersion = string(rawGenerator.version, ctx, `${location}.generator.version`);
    if (genName.trim() === "" || genVersion.trim() === "") {
      fail(ctx, "MANIFEST_INVALID_GENERATOR", "Generator name and version must be non-empty.", `${location}.generator`);
    }
    const generator: BundleManifestGenerator = { name: genName, version: genVersion };

    let projectName: string | undefined;
    if (raw.projectName !== undefined) {
      const nameVal = string(raw.projectName, ctx, `${location}.projectName`);
      if (nameVal.trim() === "" || nameVal !== nameVal.normalize("NFC") || nameVal.includes("\0") || nameVal.includes("\n") || nameVal.includes("\r")) {
        fail(ctx, "MANIFEST_INVALID_PROJECT_NAME", "Project name must be non-empty valid text.", `${location}.projectName`);
      }
      projectName = nameVal;
    }

    if (!Array.isArray(raw.files)) {
      fail(ctx, "MANIFEST_INVALID_TYPE", "Expected an array of file entries.", `${location}.files`);
    }

    if (raw.files.length > BUNDLE_MANIFEST_MAX_ENTRIES_V2) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        `Payload entry count ${raw.files.length} exceeds limit ${BUNDLE_MANIFEST_MAX_ENTRIES_V2}.`,
        `${location}.files`,
      );
    }

    const seenPortablePaths = new Map<string, string>();
    const seenAssetIds = new Map<string, string>();
    const files: BundleManifestRecordV2[] = [];

    for (let index = 0; index < raw.files.length; index += 1) {
      const entryLoc = `${location}.files[${index}]`;
      const entryRaw = record(raw.files[index], ctx, entryLoc);
      const type = string(entryRaw.type, ctx, `${entryLoc}.type`);

      if (type === "asset") {
        exactKeys(entryRaw, ASSET_RECORD_KEYS_V2, ctx, entryLoc);
        const { path, portableKey } = validatePortablePathV2(entryRaw.path, ctx, `${entryLoc}.path`);
        if (!path.endsWith(".svg")) {
          fail(ctx, "MANIFEST_INVALID_FILENAME", `Asset entry path '${path}' must end with '.svg'.`, `${entryLoc}.path`);
        }
        const assetId = validateAssetId(entryRaw.assetId, ctx, `${entryLoc}.assetId`);
        const sha256 = rawSha256Digest(entryRaw.sha256, ctx, `${entryLoc}.sha256`);

        const prevPath = seenPortablePaths.get(portableKey);
        if (prevPath !== undefined) {
          fail(
            ctx,
            "MANIFEST_COLLISION",
            `Portable entry path collision between '${prevPath}' and '${path}'.`,
            `${entryLoc}.path`,
          );
        }
        seenPortablePaths.set(portableKey, path);

        const prevAssetId = seenAssetIds.get(assetId);
        if (prevAssetId !== undefined) {
          fail(
            ctx,
            "MANIFEST_COLLISION",
            `Duplicate asset id '${assetId}' across entries '${prevAssetId}' and '${path}'.`,
            `${entryLoc}.assetId`,
          );
        }
        seenAssetIds.set(assetId, path);

        files.push({ type: "asset", path, assetId, sha256 });
      } else if (type === "companion") {
        exactKeys(entryRaw, COMPANION_RECORD_KEYS_V2, ctx, entryLoc);
        const { path, portableKey } = validatePortablePathV2(entryRaw.path, ctx, `${entryLoc}.path`);
        const leaf = path.split("/").pop() ?? path;
        if (!isAllowedCompanionFilename(leaf)) {
          fail(
            ctx,
            "MANIFEST_INVALID_FILENAME",
            `Companion entry '${path}' is not a supported companion document type.`,
            `${entryLoc}.path`,
          );
        }
        const sha256 = rawSha256Digest(entryRaw.sha256, ctx, `${entryLoc}.sha256`);

        const prevPath = seenPortablePaths.get(portableKey);
        if (prevPath !== undefined) {
          fail(
            ctx,
            "MANIFEST_COLLISION",
            `Portable entry path collision between '${prevPath}' and '${path}'.`,
            `${entryLoc}.path`,
          );
        }
        seenPortablePaths.set(portableKey, path);

        files.push({ type: "companion", path, sha256 });
      } else if (type === "file") {
        exactKeys(entryRaw, FILE_RECORD_KEYS_V2, ctx, entryLoc);
        const { path, portableKey } = validatePortablePathV2(entryRaw.path, ctx, `${entryLoc}.path`);
        const sha256 = rawSha256Digest(entryRaw.sha256, ctx, `${entryLoc}.sha256`);

        const prevPath = seenPortablePaths.get(portableKey);
        if (prevPath !== undefined) {
          fail(
            ctx,
            "MANIFEST_COLLISION",
            `Portable entry path collision between '${prevPath}' and '${path}'.`,
            `${entryLoc}.path`,
          );
        }
        seenPortablePaths.set(portableKey, path);

        files.push({ type: "file", path, sha256 });
      } else {
        fail(ctx, "MANIFEST_INVALID_RECORD_TYPE", `Unknown manifest file record type '${type}'.`, `${entryLoc}.type`);
      }
    }

    // Check sorted order by UTF-8 bytes of path
    for (let index = 0; index < files.length - 1; index += 1) {
      const current = files[index]!;
      const next = files[index + 1]!;
      if (compareUtf8(current.path, next.path) >= 0) {
        fail(
          ctx,
          "MANIFEST_UNSORTED_FILES",
          `Manifest files array must be strictly sorted by entry path in ascending UTF-8 byte order ('${current.path}' before '${next.path}').`,
          `${location}.files`,
        );
      }
    }

    return ok({
      kind: BUNDLE_MANIFEST_KIND,
      schemaVersion: BUNDLE_MANIFEST_SCHEMA_VERSION_V2,
      generator,
      ...(projectName === undefined ? {} : { projectName }),
      files,
    });
  } catch (error) {
    return fromCaught(
      error,
      ctx,
      "MANIFEST_INVALID_JSON",
      "Manifest JSON is invalid.",
      (caught) => caught instanceof SyntaxError,
    );
  }
}

export function parseBundleManifest(text: string, location = BUNDLE_MANIFEST_FILENAME): Result<AnyBundleManifest> {
  const ctx = context(location);
  try {
    const raw = record(JSON.parse(text), ctx, location);
    exactKeys(raw, TOP_KEYS, ctx, location);

    const kind = string(raw.kind, ctx, `${location}.kind`);
    if (kind !== BUNDLE_MANIFEST_KIND) {
      fail(ctx, "MANIFEST_UNSUPPORTED_KIND", `Unsupported manifest kind '${kind}'.`, `${location}.kind`);
    }

    const schemaVersion = raw.schemaVersion;
    if (schemaVersion === BUNDLE_MANIFEST_SCHEMA_VERSION) {
      return ok(parseBundleManifestV1Internal(raw, ctx, location));
    }
    if (schemaVersion === BUNDLE_MANIFEST_SCHEMA_VERSION_V2) {
      return parseBundleManifestV2(text, location);
    }

    fail(
      ctx,
      "MANIFEST_UNSUPPORTED_VERSION",
      `Unsupported manifest schema version '${schemaVersion}'.`,
      `${location}.schemaVersion`,
    );
  } catch (error) {
    return fromCaught(
      error,
      ctx,
      "MANIFEST_INVALID_JSON",
      "Manifest JSON is invalid.",
      (caught) => caught instanceof SyntaxError,
    );
  }
}

export function unwrapBundleManifest<T extends AnyBundleManifest>(result: Result<T>): T {
  if (result.ok) return result.value;
  const first = result.diagnostics[0];
  if (first === undefined) throw new Error("Diagnostic result was unexpectedly empty.");
  throw new DiagnosticError(first);
}

function orderedFileRecord(item: BundleManifestFileRecord): Record<string, unknown> {
  if (item.type === "asset") {
    return {
      type: item.type,
      name: item.name,
      assetId: item.assetId,
      sha256: item.sha256,
    };
  }
  return {
    type: item.type,
    name: item.name,
    sha256: item.sha256,
  };
}

export function serializeBundleManifest(manifest: BundleManifestV1 | BundleManifestV2): string {
  if (manifest.schemaVersion === 1) {
    const sortedFiles = [...manifest.files].sort((left, right) => compareUtf8(left.name, right.name));
    const rootObj: Record<string, unknown> = {
      kind: manifest.kind,
      schemaVersion: manifest.schemaVersion,
      generator: {
        name: manifest.generator.name,
        version: manifest.generator.version,
      },
      ...(manifest.projectName === undefined ? {} : { projectName: manifest.projectName }),
      files: sortedFiles.map(orderedFileRecord),
    };
    return `${JSON.stringify(rootObj, null, 2)}\n`;
  }
  return serializeBundleManifestV2(manifest);
}

function orderedFileRecordV2(item: BundleManifestRecordV2): Record<string, unknown> {
  if (item.type === "asset") {
    return {
      type: item.type,
      path: item.path,
      assetId: item.assetId,
      sha256: item.sha256,
    };
  }
  if (item.type === "companion") {
    return {
      type: item.type,
      path: item.path,
      sha256: item.sha256,
    };
  }
  return {
    type: item.type,
    path: item.path,
    sha256: item.sha256,
  };
}

export function serializeBundleManifestV2(manifest: BundleManifestV2): string {
  const sortedFiles = [...manifest.files].sort((left, right) => compareUtf8(left.path, right.path));
  const rootObj: Record<string, unknown> = {
    kind: manifest.kind,
    schemaVersion: manifest.schemaVersion,
    generator: {
      name: manifest.generator.name,
      version: manifest.generator.version,
    },
    ...(manifest.projectName === undefined ? {} : { projectName: manifest.projectName }),
    files: sortedFiles.map(orderedFileRecordV2),
  };
  return `${JSON.stringify(rootObj, null, 2)}\n`;
}

export function serializeBundleManifestVersioned(manifest: AnyBundleManifest): string {
  if (manifest.schemaVersion === 1) {
    return serializeBundleManifest(manifest);
  }
  return serializeBundleManifestV2(manifest);
}
