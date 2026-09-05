import { parse as parseToml, TomlError } from "smol-toml";

import { isAllowedCompanionFilename } from "../archive.js";
import { fail, fromCaught, ok, type DiagnosticContext } from "../diagnostics.js";
import { computeSha256, type Sha256Digest } from "../digests.js";
import { compareUtf8 } from "../provenance.js";
import type { Result } from "../types.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import { isValidBrandRole } from "./brand-schema.js";

export const BRAND_PACKAGE_SCHEMA_ID = "tfsb.brand-package" as const;
export const BRAND_PACKAGE_SCHEMA_VERSION = 1 as const;
export const BRAND_PACKAGE_MAX_BYTES = 1048576; // 1 MiB
export const BRAND_PACKAGE_DIGEST_BASIS = "tfsb.brand-package-v1\n" as const;

export const BRAND_PACKAGE_MAX_FAMILIES = 32;
export const BRAND_PACKAGE_MAX_PROFILES = 32;
export const BRAND_PACKAGE_MAX_INVENTORY = 256;
export const BRAND_PACKAGE_MAX_COMPANIONS = 64;
export const BRAND_PACKAGE_MAX_ENTRIES = 512;
export const BRAND_PACKAGE_MAX_NAME_BYTES = 256;
export const BRAND_PACKAGE_MAX_TEXT_BYTES = 4096;

export const BRAND_PACKAGE_COMPANION_PURPOSES = [
  "brand-guidance",
  "license",
  "notice",
  "commercial-license",
  "trademark-guidance",
] as const;

export type BrandPackageCompanionPurpose = (typeof BRAND_PACKAGE_COMPANION_PURPOSES)[number];

export const BRAND_PACKAGE_MEDIA_TYPES = [
  "text/markdown",
  "text/plain",
] as const;

export type BrandPackageMediaType = (typeof BRAND_PACKAGE_MEDIA_TYPES)[number];

export interface BrandPackageCompanion {
  readonly id: string;
  readonly source: string;
  readonly bundlePath: string;
  readonly canonicalCompanionFile: string;
  readonly mediaType: BrandPackageMediaType;
  readonly purpose: BrandPackageCompanionPurpose;
  readonly digest: Sha256Digest;
  readonly required: boolean;
}

export interface BrandPackageInventoryItem {
  readonly family: string;
  readonly role: string;
  readonly variant: string;
  readonly asset: string;
  readonly canonicalAssetDigest: Sha256Digest;
  readonly svgDigest: Sha256Digest;
}

export interface BrandPackageNpm {
  readonly name: string;
  readonly version: string;
}

export interface BrandPackageModel {
  readonly schema: typeof BRAND_PACKAGE_SCHEMA_ID;
  readonly schemaVersion: typeof BRAND_PACKAGE_SCHEMA_VERSION;
  readonly packageId: string;
  readonly name: string;
  readonly brandVersion: string;
  readonly summary?: string;
  readonly usage?: string;
  readonly trademark?: string;
  readonly families: readonly string[];
  readonly compatibleProfiles: readonly string[];
  readonly brandSystemDigest: Sha256Digest;
  readonly brandTokenDigest?: Sha256Digest;
  readonly brandRecipeDigest?: Sha256Digest;
  readonly brandQaDigest?: Sha256Digest;
  readonly consumerProfileDigest?: Sha256Digest;
  readonly exportProfileDigest?: Sha256Digest;
  readonly npmPackage?: BrandPackageNpm;
  readonly companions: readonly BrandPackageCompanion[];
  readonly inventory: readonly BrandPackageInventoryItem[];
}

type UnknownRecord = Record<string, unknown>;

const IDENTIFIER_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const QUALIFIED_IDENTIFIER_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?$/;
const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const SHA256_PREFIXED_REGEX = /^sha256:[0-9a-f]{64}$/;

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
  return { operation: "parse", domain: "project-toml", ...(source === undefined ? {} : { source }) };
}

function expectKeys(
  record: UnknownRecord,
  allowed: readonly string[],
  ctx: DiagnosticContext,
  location: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail(ctx, "SCHEMA_UNKNOWN_KEY", "Unknown key '" + key + "'.", location === "" ? key : location + "." + key);
    }
  }
}

function asRecord(value: unknown, ctx: DiagnosticContext, location: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a TOML table.", location);
  }
  return value as UnknownRecord;
}

function asArray(value: unknown, ctx: DiagnosticContext, location: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a TOML array.", location);
  }
  return value;
}

function asString(value: unknown, ctx: DiagnosticContext, location: string): string {
  if (typeof value !== "string") {
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a string.", location);
  }
  return value;
}

function asBoolean(value: unknown, ctx: DiagnosticContext, location: string): boolean {
  if (typeof value !== "boolean") {
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a boolean.", location);
  }
  return value;
}

function asInteger(
  value: unknown,
  ctx: DiagnosticContext,
  location: string,
  min?: number,
  max?: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a safe integer.", location);
  }
  if (min !== undefined && value < min) {
    fail(ctx, "SCHEMA_INVALID_RANGE", "Integer " + value + " must be at least " + min + ".", location);
  }
  if (max !== undefined && value > max) {
    fail(ctx, "SCHEMA_INVALID_RANGE", "Integer " + value + " must be at most " + max + ".", location);
  }
  return value;
}

function validateIdentifier(value: unknown, ctx: DiagnosticContext, location: string): string {
  const str = asString(value, ctx, location);
  if (Buffer.byteLength(str, "utf8") > 64 || !IDENTIFIER_REGEX.test(str)) {
    fail(
      ctx,
      "SCHEMA_INVALID_IDENTIFIER",
      "Identifier '" + str + "' must match 1..64 ASCII kebab bytes [a-z][a-z0-9]*(?:-[a-z0-9]+)*.",
      location,
    );
  }
  return str;
}

function validateSha256Digest(value: unknown, ctx: DiagnosticContext, location: string): Sha256Digest {
  const str = asString(value, ctx, location);
  if (!SHA256_PREFIXED_REGEX.test(str)) {
    fail(ctx, "SCHEMA_INVALID_DIGEST", "Digest '" + str + "' must match 'sha256:<64-lowercase-hex>'.", location);
  }
  return str as Sha256Digest;
}

function validateSemVer(value: unknown, ctx: DiagnosticContext, location: string): string {
  const str = asString(value, ctx, location);
  if (!SEMVER_REGEX.test(str)) {
    fail(ctx, "SCHEMA_INVALID_VERSION", "Version '" + str + "' must be a valid strict SemVer string.", location);
  }
  return str;
}

function validateHumanName(value: unknown, ctx: DiagnosticContext, location: string): string {
  const str = asString(value, ctx, location);
  const bytes = Buffer.byteLength(str, "utf8");
  if (bytes < 1 || bytes > BRAND_PACKAGE_MAX_NAME_BYTES || /[\x00-\x1F\x7F]/.test(str)) {
    fail(
      ctx,
      "SCHEMA_INVALID_TEXT",
      "Human name must be 1.." + BRAND_PACKAGE_MAX_NAME_BYTES + " UTF-8 bytes without control characters.",
      location,
    );
  }
  return str;
}

function validateOptionalText(value: unknown, ctx: DiagnosticContext, location: string, maxBytes = BRAND_PACKAGE_MAX_TEXT_BYTES): string {
  const str = asString(value, ctx, location);
  const bytes = Buffer.byteLength(str, "utf8");
  if (bytes > maxBytes || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(str)) {
    fail(
      ctx,
      "SCHEMA_INVALID_TEXT",
      "Text must be at most " + maxBytes + " UTF-8 bytes without control characters.",
      location,
    );
  }
  return str;
}

function validatePortableRelativePath(value: unknown, ctx: DiagnosticContext, location: string): string {
  const str = asString(value, ctx, location);
  const totalBytes = Buffer.byteLength(str, "utf8");
  if (totalBytes < 1 || totalBytes > 1024) {
    fail(ctx, "SCHEMA_INVALID_PATH", "Path length " + totalBytes + " bytes must be between 1 and 1024 bytes.", location);
  }
  if (
    str !== str.normalize("NFC") ||
    str.startsWith("/") ||
    str.endsWith("/") ||
    str.includes("\\") ||
    str.includes("\0") ||
    /[\x00-\x1F\x7F]/.test(str) ||
    /^[A-Za-z]:/.test(str) ||
    str.startsWith("//")
  ) {
    fail(ctx, "SCHEMA_INVALID_PATH", "Path '" + str + "' must be a portable relative path in NFC form.", location);
  }
  const parts = str.split("/");
  for (const part of parts) {
    const compBytes = Buffer.byteLength(part, "utf8");
    if (compBytes < 1 || compBytes > 255) {
      fail(ctx, "SCHEMA_INVALID_PATH", "Path component '" + part + "' length must be between 1 and 255 bytes.", location);
    }
    if (part === "." || part === "..") {
      fail(ctx, "SCHEMA_INVALID_PATH", "Path '" + str + "' contains invalid component '" + part + "'.", location);
    }
    if (part.startsWith(" ") || part.endsWith(" ")) {
      fail(ctx, "SCHEMA_INVALID_PATH", "Path component '" + part + "' cannot have leading or trailing whitespace.", location);
    }
    if (part.endsWith(".")) {
      fail(ctx, "SCHEMA_INVALID_PATH", "Path component '" + part + "' cannot have trailing dots.", location);
    }
    const stem = part.split(".")[0]!.toLowerCase();
    if (WINDOWS_RESERVED_NAMES.has(stem)) {
      fail(ctx, "SCHEMA_INVALID_PATH", "Path component '" + part + "' uses reserved Windows device name '" + stem + "'.", location);
    }
  }
  return str;
}

export function parseBrandPackageToml(
  source: string,
  sourceName = ".tfsb/brand-package.toml",
): Result<BrandPackageModel> {
  const ctx = context(sourceName);
  try {
    const byteLength = Buffer.byteLength(source, "utf8");
    if (byteLength > BRAND_PACKAGE_MAX_BYTES) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "brand-package.toml size " + byteLength + " bytes exceeds limit " + BRAND_PACKAGE_MAX_BYTES + " bytes.",
        sourceName,
      );
    }

    if (source.startsWith("\uFEFF")) {
      fail(ctx, "SCHEMA_INVALID_BOM", "UTF-8 BOM is forbidden in brand-package.toml.");
    }

    let parsed: unknown;
    try {
      parsed = parseToml(source);
    } catch (error) {
      if (error instanceof TomlError) {
        const msg = error.message.toLowerCase();
        const code =
          msg.includes("duplicate") || msg.includes("already defined") || msg.includes("redefine")
            ? "SCHEMA_DUPLICATE_KEY"
            : "SCHEMA_INVALID_SYNTAX";
        fail(ctx, code, "TOML parse error: " + error.message);
      }
      fail(ctx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand-package.toml.");
    }

    const root = asRecord(parsed, ctx, "");
    expectKeys(
      root,
      [
        "schema",
        "schema_version",
        "package_id",
        "name",
        "brand_version",
        "summary",
        "usage",
        "trademark",
        "families",
        "compatible_profiles",
        "brand_system_digest",
        "brand_token_digest",
        "brand_recipe_digest",
        "brand_qa_digest",
        "consumer_profile_digest",
        "export_profile_digest",
        "npm_package",
        "companions",
        "inventory",
      ],
      ctx,
      "",
    );

    const schema = asString(root.schema, ctx, "schema");
    if (schema !== BRAND_PACKAGE_SCHEMA_ID) {
      fail(ctx, "SCHEMA_INVALID_ID", "Expected schema '" + BRAND_PACKAGE_SCHEMA_ID + "', got '" + schema + "'.", "schema");
    }

    const schemaVersion = asInteger(root.schema_version, ctx, "schema_version");
    if (schemaVersion !== BRAND_PACKAGE_SCHEMA_VERSION) {
      fail(
        ctx,
        "SCHEMA_INVALID_VERSION",
        "Expected schema_version " + BRAND_PACKAGE_SCHEMA_VERSION + ", got " + schemaVersion + ".",
        "schema_version",
      );
    }

    const packageId = validateIdentifier(root.package_id, ctx, "package_id");
    const name = validateHumanName(root.name, ctx, "name");
    const brandVersion = validateSemVer(root.brand_version, ctx, "brand_version");

    const summary = root.summary === undefined ? undefined : validateOptionalText(root.summary, ctx, "summary");
    const usage = root.usage === undefined ? undefined : validateOptionalText(root.usage, ctx, "usage");
    const trademark = root.trademark === undefined ? undefined : validateOptionalText(root.trademark, ctx, "trademark");

    const brandSystemDigest = validateSha256Digest(root.brand_system_digest, ctx, "brand_system_digest");
    const brandTokenDigest = root.brand_token_digest === undefined ? undefined : validateSha256Digest(root.brand_token_digest, ctx, "brand_token_digest");
    const brandRecipeDigest = root.brand_recipe_digest === undefined ? undefined : validateSha256Digest(root.brand_recipe_digest, ctx, "brand_recipe_digest");
    const brandQaDigest = root.brand_qa_digest === undefined ? undefined : validateSha256Digest(root.brand_qa_digest, ctx, "brand_qa_digest");
    const consumerProfileDigest = root.consumer_profile_digest === undefined ? undefined : validateSha256Digest(root.consumer_profile_digest, ctx, "consumer_profile_digest");
    const exportProfileDigest = root.export_profile_digest === undefined ? undefined : validateSha256Digest(root.export_profile_digest, ctx, "export_profile_digest");

    // families
    const familiesRaw = asArray(root.families, ctx, "families");
    if (familiesRaw.length === 0) {
      fail(ctx, "SCHEMA_INVALID_RANGE", "At least one family must be declared in package.", "families");
    }
    if (familiesRaw.length > BRAND_PACKAGE_MAX_FAMILIES) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Families count " + familiesRaw.length + " exceeds limit " + BRAND_PACKAGE_MAX_FAMILIES + ".",
        "families",
      );
    }
    const seenFamilies = new Set<string>();
    const families: string[] = [];
    for (let i = 0; i < familiesRaw.length; i++) {
      const famId = validateIdentifier(familiesRaw[i], ctx, "families[" + i + "]");
      if (seenFamilies.has(famId)) {
        fail(ctx, "SCHEMA_DUPLICATE_KEY", "Duplicate family '" + famId + "' in package families.", "families[" + i + "]");
      }
      seenFamilies.add(famId);
      families.push(famId);
    }
    families.sort(compareUtf8);

    // compatible_profiles
    const profilesRaw = root.compatible_profiles === undefined ? [] : asArray(root.compatible_profiles, ctx, "compatible_profiles");
    if (profilesRaw.length > BRAND_PACKAGE_MAX_PROFILES) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "compatible_profiles count " + profilesRaw.length + " exceeds limit " + BRAND_PACKAGE_MAX_PROFILES + ".",
        "compatible_profiles",
      );
    }
    const seenProfiles = new Set<string>();
    const compatibleProfiles: string[] = [];
    for (let i = 0; i < profilesRaw.length; i++) {
      const prof = asString(profilesRaw[i], ctx, "compatible_profiles[" + i + "]");
      const profBytes = Buffer.byteLength(prof, "utf8");
      if (profBytes < 1 || profBytes > 64 || !QUALIFIED_IDENTIFIER_REGEX.test(prof)) {
        fail(
          ctx,
          "SCHEMA_INVALID_IDENTIFIER",
          "Profile ID '" + prof + "' must be 1..64 ASCII kebab bytes or qualified '<package>/<profile>'.",
          "compatible_profiles[" + i + "]",
        );
      }
      if (seenProfiles.has(prof)) {
        fail(ctx, "SCHEMA_DUPLICATE_KEY", "Duplicate profile in compatible_profiles.", "compatible_profiles[" + i + "]");
      }
      seenProfiles.add(prof);
      compatibleProfiles.push(prof);
    }
    compatibleProfiles.sort(compareUtf8);

    // npm_package (optional)
    let npmPackage: BrandPackageNpm | undefined;
    if (root.npm_package !== undefined) {
      const npmRec = asRecord(root.npm_package, ctx, "npm_package");
      expectKeys(npmRec, ["name", "version"], ctx, "npm_package");
      const npmName = asString(npmRec.name, ctx, "npm_package.name");
      const npmVersion = validateSemVer(npmRec.version, ctx, "npm_package.version");
      npmPackage = Object.freeze({ name: npmName, version: npmVersion });
    }

    // companions (optional or array)
    const companionsRaw = root.companions === undefined ? [] : asArray(root.companions, ctx, "companions");
    if (companionsRaw.length > BRAND_PACKAGE_MAX_COMPANIONS) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Companions count " + companionsRaw.length + " exceeds limit " + BRAND_PACKAGE_MAX_COMPANIONS + ".",
        "companions",
      );
    }
    const seenCompanionIds = new Set<string>();
    const seenCanonicalFiles = new Set<string>();
    const companions: BrandPackageCompanion[] = [];
    for (let i = 0; i < companionsRaw.length; i++) {
      const loc = "companions[" + i + "]";
      const rec = asRecord(companionsRaw[i], ctx, loc);
      expectKeys(
        rec,
        ["id", "source", "bundle_path", "canonical_companion_file", "media_type", "purpose", "required", "digest"],
        ctx,
        loc,
      );

      const id = validateIdentifier(rec.id, ctx, loc + ".id");
      if (seenCompanionIds.has(id)) {
        fail(ctx, "BRAND_PACKAGE_DUPLICATE_COMPANION", "Duplicate companion id '" + id + "'.", loc + ".id");
      }
      seenCompanionIds.add(id);

      const source = validatePortableRelativePath(rec.source, ctx, loc + ".source");

      const canonicalCompanionFile = asString(rec.canonical_companion_file, ctx, loc + ".canonical_companion_file");
      const compFileBytes = Buffer.byteLength(canonicalCompanionFile, "utf8");
      if (
        compFileBytes < 1 ||
        compFileBytes > 255 ||
        canonicalCompanionFile !== canonicalCompanionFile.normalize("NFC") ||
        canonicalCompanionFile.includes("/") ||
        canonicalCompanionFile.includes("\\") ||
        canonicalCompanionFile.includes("\0") ||
        /[\x00-\x1F\x7F]/.test(canonicalCompanionFile) ||
        canonicalCompanionFile.startsWith(" ") ||
        canonicalCompanionFile.endsWith(" ") ||
        canonicalCompanionFile.endsWith(".") ||
        !isAllowedCompanionFilename(canonicalCompanionFile)
      ) {
        fail(
          ctx,
          "BRAND_PACKAGE_INVALID_COMPANION_FILE",
          "canonical_companion_file '" + canonicalCompanionFile + "' must be a valid allowed leaf companion filename.",
          loc + ".canonical_companion_file",
        );
      }
      const compStem = canonicalCompanionFile.split(".")[0]!.toLowerCase();
      if (WINDOWS_RESERVED_NAMES.has(compStem)) {
        fail(
          ctx,
          "BRAND_PACKAGE_INVALID_COMPANION_FILE",
          "canonical_companion_file '" + canonicalCompanionFile + "' uses reserved Windows device name '" + compStem + "'.",
          loc + ".canonical_companion_file",
        );
      }
      const canonicalKey = canonicalCompanionFile.toLowerCase();
      if (seenCanonicalFiles.has(canonicalKey)) {
        fail(
          ctx,
          "BRAND_PACKAGE_COLLISION",
          "Duplicate canonical companion file '" + canonicalCompanionFile + "'.",
          loc + ".canonical_companion_file",
        );
      }
      seenCanonicalFiles.add(canonicalKey);

      const bundlePath = asString(rec.bundle_path, ctx, loc + ".bundle_path");
      const expectedBundlePath = "companions/" + canonicalCompanionFile;
      if (bundlePath !== expectedBundlePath) {
        fail(
          ctx,
          "BRAND_PACKAGE_INVALID_BUNDLE_PATH",
          "bundle_path '" + bundlePath + "' must equal '" + expectedBundlePath + "'.",
          loc + ".bundle_path",
        );
      }

      const mediaTypeStr = asString(rec.media_type, ctx, loc + ".media_type");
      if (!(BRAND_PACKAGE_MEDIA_TYPES as readonly string[]).includes(mediaTypeStr)) {
        fail(
          ctx,
          "SCHEMA_INVALID_ENUM",
          "media_type '" + mediaTypeStr + "' is invalid; expected one of " + BRAND_PACKAGE_MEDIA_TYPES.join(", ") + ".",
          loc + ".media_type",
        );
      }
      const mediaType = mediaTypeStr as BrandPackageMediaType;

      const purposeStr = asString(rec.purpose, ctx, loc + ".purpose");
      if (!(BRAND_PACKAGE_COMPANION_PURPOSES as readonly string[]).includes(purposeStr)) {
        fail(
          ctx,
          "SCHEMA_INVALID_ENUM",
          "purpose '" + purposeStr + "' is invalid; expected one of " + BRAND_PACKAGE_COMPANION_PURPOSES.join(", ") + ".",
          loc + ".purpose",
        );
      }
      const purpose = purposeStr as BrandPackageCompanionPurpose;

      const required = asBoolean(rec.required, ctx, loc + ".required");
      const digest = validateSha256Digest(rec.digest, ctx, loc + ".digest");

      companions.push(
        Object.freeze({
          id,
          source,
          bundlePath,
          canonicalCompanionFile,
          mediaType,
          purpose,
          required,
          digest,
        }),
      );
    }
    companions.sort((a, b) => compareUtf8(a.id, b.id));

    // inventory
    const inventoryRaw = root.inventory === undefined ? [] : asArray(root.inventory, ctx, "inventory");
    if (inventoryRaw.length === 0) {
      fail(ctx, "SCHEMA_INVALID_RANGE", "At least one inventory item must be declared.", "inventory");
    }
    if (inventoryRaw.length > BRAND_PACKAGE_MAX_INVENTORY) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Inventory items count " + inventoryRaw.length + " exceeds limit " + BRAND_PACKAGE_MAX_INVENTORY + ".",
        "inventory",
      );
    }

    if (inventoryRaw.length + companions.length > BRAND_PACKAGE_MAX_ENTRIES) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Combined inventory and companion entries exceed limit " + BRAND_PACKAGE_MAX_ENTRIES + ".",
        "inventory",
      );
    }

    const seenInventoryTriples = new Set<string>(); // `${family}:${role}:${variant}`
    const assetsById = new Map<string, { canonicalAssetDigest: Sha256Digest; svgDigest: Sha256Digest }>();
    const inventory: BrandPackageInventoryItem[] = [];

    for (let i = 0; i < inventoryRaw.length; i++) {
      const loc = "inventory[" + i + "]";
      const rec = asRecord(inventoryRaw[i], ctx, loc);
      expectKeys(
        rec,
        ["family", "role", "variant", "asset", "canonical_asset_digest", "svg_digest"],
        ctx,
        loc,
      );

      const family = validateIdentifier(rec.family, ctx, loc + ".family");
      if (!seenFamilies.has(family)) {
        fail(
          ctx,
          "BRAND_PACKAGE_UNKNOWN_FAMILY",
          "Inventory item references family '" + family + "' not listed in package families.",
          loc + ".family",
        );
      }

      const role = asString(rec.role, ctx, loc + ".role");
      if (!isValidBrandRole(role)) {
        fail(ctx, "SCHEMA_INVALID_ROLE", "Role '" + role + "' is not a valid brand role.", loc + ".role");
      }

      const variant = validateIdentifier(rec.variant, ctx, loc + ".variant");
      const asset = validateIdentifier(rec.asset, ctx, loc + ".asset");

      const triple = family + ":" + role + ":" + variant;
      if (seenInventoryTriples.has(triple)) {
        fail(
          ctx,
          "BRAND_PACKAGE_DUPLICATE_INVENTORY",
          "Duplicate inventory item for family '" + family + "', role '" + role + "', variant '" + variant + "'.",
          loc,
        );
      }
      seenInventoryTriples.add(triple);

      const canonicalAssetDigest = validateSha256Digest(rec.canonical_asset_digest, ctx, loc + ".canonical_asset_digest");
      const svgDigest = validateSha256Digest(rec.svg_digest, ctx, loc + ".svg_digest");

      const prevAsset = assetsById.get(asset);
      if (prevAsset !== undefined) {
        if (prevAsset.canonicalAssetDigest !== canonicalAssetDigest || prevAsset.svgDigest !== svgDigest) {
          fail(
            ctx,
            "ASSET_DIGEST_MISMATCH",
            "Conflicting digest declarations for repeated asset '" + asset + "'.",
            loc + ".asset",
          );
        }
      } else {
        assetsById.set(asset, { canonicalAssetDigest, svgDigest });
      }

      inventory.push(
        Object.freeze({
          family,
          role,
          variant,
          asset,
          canonicalAssetDigest,
          svgDigest,
        }),
      );
    }

    inventory.sort(
      (a, b) =>
        compareUtf8(a.family, b.family) ||
        compareUtf8(a.role, b.role) ||
        compareUtf8(a.variant, b.variant) ||
        compareUtf8(a.asset, b.asset),
    );

    const model: BrandPackageModel = Object.freeze({
      schema: BRAND_PACKAGE_SCHEMA_ID,
      schemaVersion: BRAND_PACKAGE_SCHEMA_VERSION,
      packageId,
      name,
      brandVersion,
      ...(summary === undefined ? {} : { summary }),
      ...(usage === undefined ? {} : { usage }),
      ...(trademark === undefined ? {} : { trademark }),
      families: Object.freeze(families),
      compatibleProfiles: Object.freeze(compatibleProfiles),
      brandSystemDigest,
      ...(brandTokenDigest === undefined ? {} : { brandTokenDigest }),
      ...(brandRecipeDigest === undefined ? {} : { brandRecipeDigest }),
      ...(brandQaDigest === undefined ? {} : { brandQaDigest }),
      ...(consumerProfileDigest === undefined ? {} : { consumerProfileDigest }),
      ...(exportProfileDigest === undefined ? {} : { exportProfileDigest }),
      ...(npmPackage === undefined ? {} : { npmPackage }),
      companions: Object.freeze(companions),
      inventory: Object.freeze(inventory),
    });

    return ok(model);
  } catch (error) {
    return fromCaught(error, ctx, "SCHEMA_INVALID_SYNTAX", "Failed to validate brand-package.toml.");
  }
}

export function computeBrandPackageDigest(model: BrandPackageModel): Sha256Digest {
  // Build clean DTO with exact camelCase property names
  const dto = {
    ...(model.brandQaDigest === undefined ? {} : { brandQaDigest: model.brandQaDigest }),
    ...(model.brandRecipeDigest === undefined ? {} : { brandRecipeDigest: model.brandRecipeDigest }),
    brandSystemDigest: model.brandSystemDigest,
    ...(model.brandTokenDigest === undefined ? {} : { brandTokenDigest: model.brandTokenDigest }),
    brandVersion: model.brandVersion,
    companions: model.companions.map((c) => ({
      bundlePath: c.bundlePath,
      canonicalCompanionFile: c.canonicalCompanionFile,
      digest: c.digest,
      id: c.id,
      mediaType: c.mediaType,
      purpose: c.purpose,
      required: c.required,
      source: c.source,
    })),
    compatibleProfiles: model.compatibleProfiles,
    ...(model.consumerProfileDigest === undefined ? {} : { consumerProfileDigest: model.consumerProfileDigest }),
    ...(model.exportProfileDigest === undefined ? {} : { exportProfileDigest: model.exportProfileDigest }),
    families: model.families,
    inventory: model.inventory.map((item) => ({
      asset: item.asset,
      canonicalAssetDigest: item.canonicalAssetDigest,
      family: item.family,
      role: item.role,
      svgDigest: item.svgDigest,
      variant: item.variant,
    })),
    name: model.name,
    ...(model.npmPackage === undefined ? {} : { npmPackage: model.npmPackage }),
    packageId: model.packageId,
    schema: model.schema,
    schemaVersion: model.schemaVersion,
    ...(model.summary === undefined ? {} : { summary: model.summary }),
    ...(model.trademark === undefined ? {} : { trademark: model.trademark }),
    ...(model.usage === undefined ? {} : { usage: model.usage }),
  };

  const json = encodeCanonicalJson(dto);
  const preimage = BRAND_PACKAGE_DIGEST_BASIS + json;
  return computeSha256(Buffer.from(preimage, "utf8"));
}

export function serializeBrandPackageToml(model: BrandPackageModel): string {
  const lines: string[] = [
    `schema = "${model.schema}"`,
    `schema_version = ${model.schemaVersion}`,
    `package_id = "${model.packageId}"`,
    `name = ${JSON.stringify(model.name)}`,
    `brand_version = "${model.brandVersion}"`,
  ];

  if (model.summary !== undefined) {
    lines.push(`summary = ${JSON.stringify(model.summary)}`);
  }
  if (model.usage !== undefined) {
    lines.push(`usage = ${JSON.stringify(model.usage)}`);
  }
  if (model.trademark !== undefined) {
    lines.push(`trademark = ${JSON.stringify(model.trademark)}`);
  }

  const fams = model.families.map((f) => `"${f}"`).join(", ");
  lines.push(`families = [${fams}]`);

  const profs = model.compatibleProfiles.map((p) => `"${p}"`).join(", ");
  lines.push(`compatible_profiles = [${profs}]`);

  lines.push(`brand_system_digest = "${model.brandSystemDigest}"`);
  if (model.brandTokenDigest !== undefined) lines.push(`brand_token_digest = "${model.brandTokenDigest}"`);
  if (model.brandRecipeDigest !== undefined) lines.push(`brand_recipe_digest = "${model.brandRecipeDigest}"`);
  if (model.brandQaDigest !== undefined) lines.push(`brand_qa_digest = "${model.brandQaDigest}"`);
  if (model.consumerProfileDigest !== undefined) lines.push(`consumer_profile_digest = "${model.consumerProfileDigest}"`);
  if (model.exportProfileDigest !== undefined) lines.push(`export_profile_digest = "${model.exportProfileDigest}"`);
  lines.push("");

  if (model.npmPackage !== undefined) {
    lines.push("[npm_package]");
    lines.push(`name = ${JSON.stringify(model.npmPackage.name)}`);
    lines.push(`version = "${model.npmPackage.version}"`);
    lines.push("");
  }

  for (const comp of model.companions) {
    lines.push("[[companions]]");
    lines.push(`id = "${comp.id}"`);
    lines.push(`source = ${JSON.stringify(comp.source)}`);
    lines.push(`bundle_path = "${comp.bundlePath}"`);
    lines.push(`canonical_companion_file = "${comp.canonicalCompanionFile}"`);
    lines.push(`media_type = "${comp.mediaType}"`);
    lines.push(`purpose = "${comp.purpose}"`);
    lines.push(`digest = "${comp.digest}"`);
    lines.push(`required = ${comp.required}`);
    lines.push("");
  }

  for (const item of model.inventory) {
    lines.push("[[inventory]]");
    lines.push(`family = "${item.family}"`);
    lines.push(`role = "${item.role}"`);
    lines.push(`variant = "${item.variant}"`);
    lines.push(`asset = "${item.asset}"`);
    lines.push(`canonical_asset_digest = "${item.canonicalAssetDigest}"`);
    lines.push(`svg_digest = "${item.svgDigest}"`);
    lines.push("");
  }

  return lines.join("\n");
}
