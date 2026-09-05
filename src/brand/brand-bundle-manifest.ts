import { isAllowedCompanionFilename } from "../archive.js";
import { fail, fromCaught, ok, type DiagnosticContext } from "../diagnostics.js";
import { computeSha256, type Sha256Digest } from "../digests.js";
import { compareUtf8 } from "../provenance.js";
import type { Result } from "../types.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import { isValidBrandRole } from "./brand-schema.js";

export const BRAND_BUNDLE_MANIFEST_SCHEMA = "tfsb.brand-bundle-manifest" as const;
export const BRAND_BUNDLE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const BRAND_BUNDLE_MANIFEST_FILENAME = "tfsb-brand-manifest.json" as const;
export const BRAND_BUNDLE_MANIFEST_DIGEST_BASIS = "tfsb-brand-bundle-manifest-v1\n" as const;

export const BRAND_MANIFEST_MAX_BYTES = 1048576; // 1 MiB
export const BRAND_MANIFEST_MAX_INVENTORY = 256;
export const BRAND_MANIFEST_MAX_COMPANIONS = 64;
export const BRAND_MANIFEST_MAX_PROFILES = 32;

export interface BrandBundleManifestInventoryItem {
  readonly assetId: string;
  readonly family: string;
  readonly role: string;
  readonly variant: string;
  readonly bundlePath: string;
  readonly canonicalAssetDigest: Sha256Digest;
  readonly svgDigest: Sha256Digest;
}

export interface BrandBundleManifestCompanion {
  readonly id: string;
  readonly purpose: string;
  readonly bundlePath: string;
  readonly canonicalCompanionFile: string;
  readonly mediaType: string;
  readonly digest: Sha256Digest;
  readonly required: boolean;
}

export interface BrandBundleManifestProfile {
  readonly profileId: string;
  readonly version: number;
  readonly digest: Sha256Digest;
}

export interface BrandBundleManifestDerivedReceipt {
  readonly targetId: string;
  readonly recipeId: string;
  readonly bundlePath: string;
  readonly receiptDigest: Sha256Digest;
  readonly canonicalAssetDigest: Sha256Digest;
  readonly targetSvgDigest: Sha256Digest;
}

export interface BrandBundleManifestQaBaseline {
  readonly profileId: string;
  readonly caseId: string;
  readonly bundlePath: string;
  readonly baselineDigest: Sha256Digest;
  readonly rendererId: string;
  readonly rendererVersion: string;
  readonly platformClaim: string;
  readonly canonicalAssetDigest: Sha256Digest;
  readonly svgDigest: Sha256Digest;
  readonly width: number;
  readonly height: number;
  readonly background: string;
}

export interface BrandBundleManifest {
  readonly schema: typeof BRAND_BUNDLE_MANIFEST_SCHEMA;
  readonly schemaVersion: typeof BRAND_BUNDLE_MANIFEST_SCHEMA_VERSION;
  readonly packageId: string;
  readonly name: string;
  readonly brandVersion: string;
  readonly genericManifestByteDigest: Sha256Digest;
  readonly brandPackageDigest: Sha256Digest;
  readonly brandSystemDigest: Sha256Digest;
  readonly domainDigests: Readonly<Record<string, Sha256Digest>>;
  readonly inventory: readonly BrandBundleManifestInventoryItem[];
  readonly companions: readonly BrandBundleManifestCompanion[];
  readonly profiles: readonly BrandBundleManifestProfile[];
  readonly derivedReceipts?: readonly BrandBundleManifestDerivedReceipt[];
  readonly qaBaselines?: readonly BrandBundleManifestQaBaseline[];
  readonly brandManifestDigest: Sha256Digest;
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

const BRAND_KNOWN_DOMAINS = new Set(["brand", "tokens", "recipes", "qa", "consumer_profiles", "exports"]);

import {
  BRAND_PACKAGE_COMPANION_PURPOSES,
  BRAND_PACKAGE_MEDIA_TYPES,
  type BrandPackageCompanionPurpose,
  type BrandPackageMediaType,
} from "./brand-package.js";

function validateSvgFilename(name: string, ctx: DiagnosticContext, location: string): void {
  const bytes = Buffer.byteLength(name, "utf8");
  if (
    bytes < 5 ||
    bytes > 255 ||
    name !== name.normalize("NFC") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    /[\x00-\x1F\x7F]/.test(name) ||
    name.startsWith(" ") ||
    name.endsWith(" ") ||
    !name.endsWith(".svg")
  ) {
    fail(ctx, "MANIFEST_INVALID_PATH", "Asset filename '" + name + "' is invalid.", location);
  }
  const stem = name.slice(0, -4).toLowerCase();
  if (stem.endsWith(".") || stem.endsWith(" ") || stem.startsWith(" ") || WINDOWS_RESERVED_NAMES.has(stem)) {
    fail(ctx, "MANIFEST_INVALID_PATH", "Asset filename '" + name + "' is invalid.", location);
  }
}

function context(source?: string): DiagnosticContext {
  return { operation: "parse", domain: "manifest", ...(source === undefined ? {} : { source }) };
}

function expectKeys(
  record: UnknownRecord,
  allowed: readonly string[],
  ctx: DiagnosticContext,
  location: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail(ctx, "MANIFEST_UNKNOWN_FIELD", "Unknown field '" + key + "'.", location === "" ? key : location + "." + key);
    }
  }
}

function asRecord(value: unknown, ctx: DiagnosticContext, location: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(ctx, "MANIFEST_INVALID_TYPE", "Expected a JSON object.", location);
  }
  return value as UnknownRecord;
}

function asArray(value: unknown, ctx: DiagnosticContext, location: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(ctx, "MANIFEST_INVALID_TYPE", "Expected a JSON array.", location);
  }
  return value;
}

function asString(value: unknown, ctx: DiagnosticContext, location: string): string {
  if (typeof value !== "string") {
    fail(ctx, "MANIFEST_INVALID_TYPE", "Expected a string.", location);
  }
  return value;
}

function asBoolean(value: unknown, ctx: DiagnosticContext, location: string): boolean {
  if (typeof value !== "boolean") {
    fail(ctx, "MANIFEST_INVALID_TYPE", "Expected a boolean.", location);
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
    fail(ctx, "MANIFEST_INVALID_TYPE", "Expected a safe integer.", location);
  }
  if (min !== undefined && value < min) {
    fail(ctx, "MANIFEST_INVALID_RANGE", "Integer " + value + " must be at least " + min + ".", location);
  }
  if (max !== undefined && value > max) {
    fail(ctx, "MANIFEST_INVALID_RANGE", "Integer " + value + " must be at most " + max + ".", location);
  }
  return value;
}

function validateIdentifier(value: unknown, ctx: DiagnosticContext, location: string): string {
  const str = asString(value, ctx, location);
  if (Buffer.byteLength(str, "utf8") > 64 || !IDENTIFIER_REGEX.test(str)) {
    fail(
      ctx,
      "MANIFEST_INVALID_IDENTIFIER",
      "Identifier '" + str + "' must match 1..64 ASCII kebab bytes [a-z][a-z0-9]*(?:-[a-z0-9]+)*.",
      location,
    );
  }
  return str;
}

function validateSha256Digest(value: unknown, ctx: DiagnosticContext, location: string): Sha256Digest {
  const str = asString(value, ctx, location);
  if (!SHA256_PREFIXED_REGEX.test(str)) {
    fail(ctx, "MANIFEST_INVALID_DIGEST", "Digest '" + str + "' must match 'sha256:<64-lowercase-hex>'.", location);
  }
  return str as Sha256Digest;
}

function validateSemVer(value: unknown, ctx: DiagnosticContext, location: string): string {
  const str = asString(value, ctx, location);
  if (!SEMVER_REGEX.test(str)) {
    fail(ctx, "MANIFEST_INVALID_VERSION", "Version '" + str + "' must be a valid strict SemVer string.", location);
  }
  return str;
}

export function computeBrandBundleManifestDigest(
  manifestWithoutSelfDigest: Omit<BrandBundleManifest, "brandManifestDigest">,
): Sha256Digest {
  const dto = {
    brandPackageDigest: manifestWithoutSelfDigest.brandPackageDigest,
    brandSystemDigest: manifestWithoutSelfDigest.brandSystemDigest,
    brandVersion: manifestWithoutSelfDigest.brandVersion,
    companions: manifestWithoutSelfDigest.companions.map((c) => ({
      bundlePath: c.bundlePath,
      canonicalCompanionFile: c.canonicalCompanionFile,
      digest: c.digest,
      id: c.id,
      mediaType: c.mediaType,
      purpose: c.purpose,
      required: c.required,
    })),
    domainDigests: manifestWithoutSelfDigest.domainDigests,
    ...(manifestWithoutSelfDigest.derivedReceipts === undefined ? {} : {
      derivedReceipts: manifestWithoutSelfDigest.derivedReceipts.map((receipt) => ({
        bundlePath: receipt.bundlePath,
        canonicalAssetDigest: receipt.canonicalAssetDigest,
        receiptDigest: receipt.receiptDigest,
        recipeId: receipt.recipeId,
        targetId: receipt.targetId,
        targetSvgDigest: receipt.targetSvgDigest,
      })),
    }),
    ...(manifestWithoutSelfDigest.qaBaselines === undefined ? {} : {
      qaBaselines: manifestWithoutSelfDigest.qaBaselines.map((baseline) => ({
        background: baseline.background,
        baselineDigest: baseline.baselineDigest,
        bundlePath: baseline.bundlePath,
        canonicalAssetDigest: baseline.canonicalAssetDigest,
        caseId: baseline.caseId,
        height: baseline.height,
        platformClaim: baseline.platformClaim,
        profileId: baseline.profileId,
        rendererId: baseline.rendererId,
        rendererVersion: baseline.rendererVersion,
        svgDigest: baseline.svgDigest,
        width: baseline.width,
      })),
    }),
    genericManifestByteDigest: manifestWithoutSelfDigest.genericManifestByteDigest,
    inventory: manifestWithoutSelfDigest.inventory.map((item) => ({
      assetId: item.assetId,
      bundlePath: item.bundlePath,
      canonicalAssetDigest: item.canonicalAssetDigest,
      family: item.family,
      role: item.role,
      svgDigest: item.svgDigest,
      variant: item.variant,
    })),
    name: manifestWithoutSelfDigest.name,
    packageId: manifestWithoutSelfDigest.packageId,
    profiles: manifestWithoutSelfDigest.profiles,
    schema: manifestWithoutSelfDigest.schema,
    schemaVersion: manifestWithoutSelfDigest.schemaVersion,
  };

  const json = encodeCanonicalJson(dto);
  const preimage = BRAND_BUNDLE_MANIFEST_DIGEST_BASIS + json;
  return computeSha256(Buffer.from(preimage, "utf8"));
}

export function parseBrandBundleManifest(
  text: string,
  location = BRAND_BUNDLE_MANIFEST_FILENAME,
): Result<BrandBundleManifest> {
  const ctx = context(location);
  try {
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength > BRAND_MANIFEST_MAX_BYTES) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Brand manifest size " + byteLength + " bytes exceeds limit " + BRAND_MANIFEST_MAX_BYTES + " bytes.",
        location,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail(ctx, "MANIFEST_INVALID_JSON", "Brand manifest JSON is invalid.", location);
    }

    const root = asRecord(parsed, ctx, location);
    expectKeys(
      root,
      [
        "schema",
        "schemaVersion",
        "packageId",
        "name",
        "brandVersion",
        "genericManifestByteDigest",
        "brandPackageDigest",
        "brandSystemDigest",
        "domainDigests",
        "derivedReceipts",
        "qaBaselines",
        "inventory",
        "companions",
        "profiles",
        "brandManifestDigest",
      ],
      ctx,
      location,
    );

    const schema = asString(root.schema, ctx, location + ".schema");
    if (schema !== BRAND_BUNDLE_MANIFEST_SCHEMA) {
      fail(
        ctx,
        "MANIFEST_UNSUPPORTED_KIND",
        "Expected schema '" + BRAND_BUNDLE_MANIFEST_SCHEMA + "', got '" + schema + "'.",
        location + ".schema",
      );
    }

    const schemaVersion = asInteger(root.schemaVersion, ctx, location + ".schemaVersion");
    if (schemaVersion !== BRAND_BUNDLE_MANIFEST_SCHEMA_VERSION) {
      fail(
        ctx,
        "MANIFEST_UNSUPPORTED_VERSION",
        "Expected schemaVersion " + BRAND_BUNDLE_MANIFEST_SCHEMA_VERSION + ", got " + schemaVersion + ".",
        location + ".schemaVersion",
      );
    }

    const packageId = validateIdentifier(root.packageId, ctx, location + ".packageId");
    const name = asString(root.name, ctx, location + ".name");
    const brandVersion = validateSemVer(root.brandVersion, ctx, location + ".brandVersion");

    const genericManifestByteDigest = validateSha256Digest(
      root.genericManifestByteDigest,
      ctx,
      location + ".genericManifestByteDigest",
    );
    const brandPackageDigest = validateSha256Digest(root.brandPackageDigest, ctx, location + ".brandPackageDigest");
    const brandSystemDigest = validateSha256Digest(root.brandSystemDigest, ctx, location + ".brandSystemDigest");

    // domainDigests
    const domainDigestsRaw = asRecord(root.domainDigests, ctx, location + ".domainDigests");
    const domainDigests: Record<string, Sha256Digest> = {};
    const domainKeys = Object.keys(domainDigestsRaw).sort(compareUtf8);
    for (const dKey of domainKeys) {
      if (!BRAND_KNOWN_DOMAINS.has(dKey)) {
        fail(ctx, "MANIFEST_UNKNOWN_FIELD", "Unknown domain key '" + dKey + "' in domainDigests.", location + ".domainDigests." + dKey);
      }
      if (dKey !== "brand" && dKey !== "tokens" && dKey !== "recipes" && dKey !== "qa" && dKey !== "consumer_profiles" && dKey !== "exports") {
        fail(ctx, "BRAND_DOMAIN_UNAVAILABLE", "Domain '" + dKey + "' is unavailable in this package version.", location + ".domainDigests." + dKey);
      }
      domainDigests[dKey] = validateSha256Digest(domainDigestsRaw[dKey], ctx, location + ".domainDigests." + dKey);
    }
    if (domainDigests.brand === undefined) {
      fail(ctx, "BRAND_DOMAIN_DIGEST_MISSING", "domainDigests must include 'brand'.", location + ".domainDigests");
    }

    // inventory
    const inventoryRaw = asArray(root.inventory, ctx, location + ".inventory");
    if (inventoryRaw.length > BRAND_MANIFEST_MAX_INVENTORY) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Brand manifest inventory exceeds limit " + BRAND_MANIFEST_MAX_INVENTORY + ".",
        location + ".inventory",
      );
    }
    const seenInventoryTriples = new Set<string>(); // `${family}:${role}:${variant}`
    const assetsById = new Map<string, { bundlePath: string; canonicalAssetDigest: Sha256Digest; svgDigest: Sha256Digest }>();
    const inventory: BrandBundleManifestInventoryItem[] = [];

    for (let i = 0; i < inventoryRaw.length; i++) {
      const iLoc = location + ".inventory[" + i + "]";
      const itemRec = asRecord(inventoryRaw[i], ctx, iLoc);
      expectKeys(
        itemRec,
        ["assetId", "family", "role", "variant", "bundlePath", "canonicalAssetDigest", "svgDigest"],
        ctx,
        iLoc,
      );

      const assetId = validateIdentifier(itemRec.assetId, ctx, iLoc + ".assetId");
      const family = validateIdentifier(itemRec.family, ctx, iLoc + ".family");
      const role = asString(itemRec.role, ctx, iLoc + ".role");
      if (!isValidBrandRole(role)) {
        fail(ctx, "SCHEMA_INVALID_ROLE", "Role '" + role + "' is not a valid brand role.", iLoc + ".role");
      }
      const variant = validateIdentifier(itemRec.variant, ctx, iLoc + ".variant");

      const triple = family + ":" + role + ":" + variant;
      if (seenInventoryTriples.has(triple)) {
        fail(ctx, "MANIFEST_COLLISION", "Duplicate inventory binding for triple '" + triple + "'.", iLoc);
      }
      seenInventoryTriples.add(triple);

      const bundlePath = asString(itemRec.bundlePath, ctx, iLoc + ".bundlePath");
      if (!bundlePath.startsWith("assets/") || !bundlePath.endsWith(".svg")) {
        fail(
          ctx,
          "MANIFEST_INVALID_PATH",
          "bundlePath '" + bundlePath + "' must start with 'assets/' and end with '.svg'.",
          iLoc + ".bundlePath",
        );
      }
      const leaf = bundlePath.slice("assets/".length);
      validateSvgFilename(leaf, ctx, iLoc + ".bundlePath");

      const canonicalAssetDigest = validateSha256Digest(itemRec.canonicalAssetDigest, ctx, iLoc + ".canonicalAssetDigest");
      const svgDigest = validateSha256Digest(itemRec.svgDigest, ctx, iLoc + ".svgDigest");

      const prevAsset = assetsById.get(assetId);
      if (prevAsset !== undefined) {
        if (
          prevAsset.bundlePath !== bundlePath ||
          prevAsset.canonicalAssetDigest !== canonicalAssetDigest ||
          prevAsset.svgDigest !== svgDigest
        ) {
          fail(
            ctx,
            "MANIFEST_COLLISION",
            "Conflicting bundlePath or digest declarations for repeated assetId '" + assetId + "'.",
            iLoc + ".assetId",
          );
        }
      } else {
        assetsById.set(assetId, { bundlePath, canonicalAssetDigest, svgDigest });
      }

      inventory.push(
        Object.freeze({
          assetId,
          family,
          role,
          variant,
          bundlePath,
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
        compareUtf8(a.assetId, b.assetId),
    );

    // companions
    const companionsRaw = asArray(root.companions, ctx, location + ".companions");
    if (companionsRaw.length > BRAND_MANIFEST_MAX_COMPANIONS) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Brand manifest companions count exceeds limit " + BRAND_MANIFEST_MAX_COMPANIONS + ".",
        location + ".companions",
      );
    }
    const seenCompIds = new Set<string>();
    const seenCompPaths = new Set<string>();
    const companions: BrandBundleManifestCompanion[] = [];

    for (let i = 0; i < companionsRaw.length; i++) {
      const cLoc = location + ".companions[" + i + "]";
      const compRec = asRecord(companionsRaw[i], ctx, cLoc);
      expectKeys(
        compRec,
        ["id", "purpose", "bundlePath", "canonicalCompanionFile", "mediaType", "digest", "required"],
        ctx,
        cLoc,
      );

      const id = validateIdentifier(compRec.id, ctx, cLoc + ".id");
      if (seenCompIds.has(id)) {
        fail(ctx, "MANIFEST_COLLISION", "Duplicate companion id '" + id + "' in brand manifest.", cLoc + ".id");
      }
      seenCompIds.add(id);

      const purposeStr = asString(compRec.purpose, ctx, cLoc + ".purpose");
      if (!(BRAND_PACKAGE_COMPANION_PURPOSES as readonly string[]).includes(purposeStr)) {
        fail(
          ctx,
          "SCHEMA_INVALID_ENUM",
          "purpose '" + purposeStr + "' is invalid; expected one of " + BRAND_PACKAGE_COMPANION_PURPOSES.join(", ") + ".",
          cLoc + ".purpose",
        );
      }
      const purpose = purposeStr as BrandPackageCompanionPurpose;

      const canonicalCompanionFile = asString(compRec.canonicalCompanionFile, ctx, cLoc + ".canonicalCompanionFile");
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
          "MANIFEST_INVALID_PATH",
          "canonicalCompanionFile '" + canonicalCompanionFile + "' is not a valid companion filename.",
          cLoc + ".canonicalCompanionFile",
        );
      }
      const compStem = canonicalCompanionFile.split(".")[0]!.toLowerCase();
      if (WINDOWS_RESERVED_NAMES.has(compStem)) {
        fail(
          ctx,
          "MANIFEST_INVALID_PATH",
          "canonicalCompanionFile '" + canonicalCompanionFile + "' uses reserved Windows device name '" + compStem + "'.",
          cLoc + ".canonicalCompanionFile",
        );
      }

      const bundlePath = asString(compRec.bundlePath, ctx, cLoc + ".bundlePath");
      if (bundlePath !== "companions/" + canonicalCompanionFile) {
        fail(
          ctx,
          "MANIFEST_INVALID_PATH",
          "bundlePath '" + bundlePath + "' must equal 'companions/" + canonicalCompanionFile + "'.",
          cLoc + ".bundlePath",
        );
      }
      if (seenCompPaths.has(bundlePath)) {
        fail(ctx, "MANIFEST_COLLISION", "Duplicate companion bundlePath '" + bundlePath + "'.", cLoc + ".bundlePath");
      }
      seenCompPaths.add(bundlePath);

      const mediaTypeStr = asString(compRec.mediaType, ctx, cLoc + ".mediaType");
      if (!(BRAND_PACKAGE_MEDIA_TYPES as readonly string[]).includes(mediaTypeStr)) {
        fail(
          ctx,
          "SCHEMA_INVALID_ENUM",
          "mediaType '" + mediaTypeStr + "' is invalid; expected one of " + BRAND_PACKAGE_MEDIA_TYPES.join(", ") + ".",
          cLoc + ".mediaType",
        );
      }
      const mediaType = mediaTypeStr as BrandPackageMediaType;

      const digest = validateSha256Digest(compRec.digest, ctx, cLoc + ".digest");
      const required = asBoolean(compRec.required, ctx, cLoc + ".required");

      companions.push(
        Object.freeze({
          id,
          purpose,
          bundlePath,
          canonicalCompanionFile,
          mediaType,
          digest,
          required,
        }),
      );
    }
    companions.sort((a, b) => compareUtf8(a.id, b.id));

    let derivedReceipts: readonly BrandBundleManifestDerivedReceipt[] | undefined;
    if (root.derivedReceipts !== undefined) {
      const recordsRaw = asArray(root.derivedReceipts, ctx, location + ".derivedReceipts");
      if (recordsRaw.length === 0 || recordsRaw.length > 128) {
        fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "derivedReceipts must contain between 1 and 128 records.", location + ".derivedReceipts");
      }
      const seenTargets = new Set<string>();
      const records: BrandBundleManifestDerivedReceipt[] = [];
      for (let index = 0; index < recordsRaw.length; index++) {
        const recordLocation = location + ".derivedReceipts[" + index + "]";
        const record = asRecord(recordsRaw[index], ctx, recordLocation);
        expectKeys(record, ["targetId", "recipeId", "bundlePath", "receiptDigest", "canonicalAssetDigest", "targetSvgDigest"], ctx, recordLocation);
        const targetId = validateIdentifier(record.targetId, ctx, recordLocation + ".targetId");
        if (seenTargets.has(targetId)) fail(ctx, "MANIFEST_COLLISION", "Duplicate derived receipt target '" + targetId + "'.", recordLocation + ".targetId");
        seenTargets.add(targetId);
        const recipeId = validateIdentifier(record.recipeId, ctx, recordLocation + ".recipeId");
        const bundlePath = asString(record.bundlePath, ctx, recordLocation + ".bundlePath");
        if (bundlePath !== "derived/" + targetId + ".receipt.json") {
          fail(ctx, "MANIFEST_INVALID_PATH", "Derived receipt bundlePath must match its target id.", recordLocation + ".bundlePath");
        }
        records.push(Object.freeze({
          targetId,
          recipeId,
          bundlePath,
          receiptDigest: validateSha256Digest(record.receiptDigest, ctx, recordLocation + ".receiptDigest"),
          canonicalAssetDigest: validateSha256Digest(record.canonicalAssetDigest, ctx, recordLocation + ".canonicalAssetDigest"),
          targetSvgDigest: validateSha256Digest(record.targetSvgDigest, ctx, recordLocation + ".targetSvgDigest"),
        }));
      }
      records.sort((left, right) => compareUtf8(left.targetId, right.targetId));
      derivedReceipts = Object.freeze(records);
    }

    let qaBaselines: readonly BrandBundleManifestQaBaseline[] | undefined;
    if (root.qaBaselines !== undefined) {
      const raw = asArray(root.qaBaselines, ctx, location + ".qaBaselines");
      if (raw.length === 0 || raw.length > 256) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "qaBaselines must contain between 1 and 256 records.", location + ".qaBaselines");
      const seen = new Set<string>();
      const records: BrandBundleManifestQaBaseline[] = [];
      for (let index = 0; index < raw.length; index++) {
        const itemLocation = `${location}.qaBaselines[${index}]`;
        const record = asRecord(raw[index], ctx, itemLocation);
        expectKeys(record, ["profileId", "caseId", "bundlePath", "baselineDigest", "rendererId", "rendererVersion", "platformClaim", "canonicalAssetDigest", "svgDigest", "width", "height", "background"], ctx, itemLocation);
        const profileId = validateIdentifier(record.profileId, ctx, itemLocation + ".profileId");
        const caseId = validateIdentifier(record.caseId, ctx, itemLocation + ".caseId");
        const key = `${profileId}/${caseId}`;
        if (seen.has(key)) fail(ctx, "MANIFEST_COLLISION", `Duplicate QA baseline '${key}'.`, itemLocation);
        seen.add(key);
        const bundlePath = asString(record.bundlePath, ctx, itemLocation + ".bundlePath");
        if (bundlePath !== `baselines/${profileId}/${caseId}.png`) fail(ctx, "MANIFEST_INVALID_PATH", "QA baseline bundlePath must match its profile and case ids.", itemLocation + ".bundlePath");
        const width = asInteger(record.width, ctx, itemLocation + ".width", 1);
        const height = asInteger(record.height, ctx, itemLocation + ".height", 1);
        if (width > 16_384 || height > 16_384 || width * height > 16_777_216) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "QA baseline dimensions exceed the visual QA limits.", itemLocation);
        const background = asString(record.background, ctx, itemLocation + ".background");
        if (background !== "transparent" && !/^token:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(background) && !/^#[0-9A-F]{8}$/.test(background)) fail(ctx, "SCHEMA_INVALID_ENUM", "QA baseline background is not canonical.", itemLocation + ".background");
        records.push(Object.freeze({ profileId, caseId, bundlePath, baselineDigest: validateSha256Digest(record.baselineDigest, ctx, itemLocation + ".baselineDigest"), rendererId: validateIdentifier(record.rendererId, ctx, itemLocation + ".rendererId"), rendererVersion: asString(record.rendererVersion, ctx, itemLocation + ".rendererVersion"), platformClaim: asString(record.platformClaim, ctx, itemLocation + ".platformClaim"), canonicalAssetDigest: validateSha256Digest(record.canonicalAssetDigest, ctx, itemLocation + ".canonicalAssetDigest"), svgDigest: validateSha256Digest(record.svgDigest, ctx, itemLocation + ".svgDigest"), width, height, background }));
      }
      records.sort((a, b) => compareUtf8(a.profileId, b.profileId) || compareUtf8(a.caseId, b.caseId));
      qaBaselines = Object.freeze(records);
    }

    // profiles
    const profilesRaw = asArray(root.profiles, ctx, location + ".profiles");
    if (profilesRaw.length > BRAND_MANIFEST_MAX_PROFILES) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Brand manifest profiles count exceeds limit " + BRAND_MANIFEST_MAX_PROFILES + ".",
        location + ".profiles",
      );
    }
    const seenProfileIds = new Set<string>();
    const profiles: BrandBundleManifestProfile[] = [];
    for (let i = 0; i < profilesRaw.length; i++) {
      const pLoc = location + ".profiles[" + i + "]";
      const profRec = asRecord(profilesRaw[i], ctx, pLoc);
      expectKeys(profRec, ["profileId", "version", "digest"], ctx, pLoc);
      const profileId = asString(profRec.profileId, ctx, pLoc + ".profileId");
      const profBytes = Buffer.byteLength(profileId, "utf8");
      if (profBytes < 1 || profBytes > 129 || !QUALIFIED_IDENTIFIER_REGEX.test(profileId)) {
        fail(
          ctx,
          "MANIFEST_INVALID_IDENTIFIER",
          "profileId '" + profileId + "' must be 1..64 ASCII kebab bytes or qualified '<package>/<profile>'.",
          pLoc + ".profileId",
        );
      }
      if (seenProfileIds.has(profileId)) {
        fail(ctx, "MANIFEST_COLLISION", "Duplicate profileId '" + profileId + "' in brand manifest.", pLoc + ".profileId");
      }
      seenProfileIds.add(profileId);

      const version = asInteger(profRec.version, ctx, pLoc + ".version", 1);
      if (version > 65_535) fail(ctx, "SCHEMA_INVALID_RANGE", "Profile version must be at most 65535.", pLoc + ".version");
      const digest = validateSha256Digest(profRec.digest, ctx, pLoc + ".digest");
      profiles.push(Object.freeze({ profileId, version, digest }));
    }
    profiles.sort((a, b) => compareUtf8(a.profileId, b.profileId));

    const brandManifestDigest = validateSha256Digest(root.brandManifestDigest, ctx, location + ".brandManifestDigest");

    const manifestWithoutSelfDigest = {
      schema: BRAND_BUNDLE_MANIFEST_SCHEMA,
      schemaVersion: BRAND_BUNDLE_MANIFEST_SCHEMA_VERSION,
      packageId,
      name,
      brandVersion,
      genericManifestByteDigest,
      brandPackageDigest,
      brandSystemDigest,
      domainDigests: Object.freeze(domainDigests),
      inventory: Object.freeze(inventory),
      companions: Object.freeze(companions),
      profiles: Object.freeze(profiles),
      ...(derivedReceipts === undefined ? {} : { derivedReceipts }),
      ...(qaBaselines === undefined ? {} : { qaBaselines }),
    };

    const computedSelfDigest = computeBrandBundleManifestDigest(manifestWithoutSelfDigest);
    if (computedSelfDigest !== brandManifestDigest) {
      fail(
        ctx,
        "MANIFEST_DIGEST_MISMATCH",
        "Brand manifest self-digest mismatch; expected '" + computedSelfDigest + "', got '" + brandManifestDigest + "'.",
        location + ".brandManifestDigest",
      );
    }

    return ok(
      Object.freeze({
        ...manifestWithoutSelfDigest,
        brandManifestDigest,
      }),
    );
  } catch (error) {
    return fromCaught(error, ctx, "MANIFEST_INVALID_JSON", "Brand manifest JSON is invalid.");
  }
}

export function serializeBrandBundleManifest(manifest: BrandBundleManifest): string {
  const rootObj = {
    schema: manifest.schema,
    schemaVersion: manifest.schemaVersion,
    packageId: manifest.packageId,
    name: manifest.name,
    brandVersion: manifest.brandVersion,
    genericManifestByteDigest: manifest.genericManifestByteDigest,
    brandPackageDigest: manifest.brandPackageDigest,
    brandSystemDigest: manifest.brandSystemDigest,
    domainDigests: manifest.domainDigests,
    inventory: manifest.inventory.map((item) => ({
      assetId: item.assetId,
      family: item.family,
      role: item.role,
      variant: item.variant,
      bundlePath: item.bundlePath,
      canonicalAssetDigest: item.canonicalAssetDigest,
      svgDigest: item.svgDigest,
    })),
    companions: manifest.companions.map((comp) => ({
      id: comp.id,
      purpose: comp.purpose,
      bundlePath: comp.bundlePath,
      canonicalCompanionFile: comp.canonicalCompanionFile,
      mediaType: comp.mediaType,
      digest: comp.digest,
      required: comp.required,
    })),
    profiles: manifest.profiles.map((p) => ({
      profileId: p.profileId,
      version: p.version,
      digest: p.digest,
    })),
    ...(manifest.derivedReceipts === undefined ? {} : {
      derivedReceipts: manifest.derivedReceipts.map((receipt) => ({
        targetId: receipt.targetId,
        recipeId: receipt.recipeId,
        bundlePath: receipt.bundlePath,
        receiptDigest: receipt.receiptDigest,
        canonicalAssetDigest: receipt.canonicalAssetDigest,
        targetSvgDigest: receipt.targetSvgDigest,
      })),
    }),
    ...(manifest.qaBaselines === undefined ? {} : {
      qaBaselines: manifest.qaBaselines.map((baseline) => ({
        profileId: baseline.profileId,
        caseId: baseline.caseId,
        bundlePath: baseline.bundlePath,
        baselineDigest: baseline.baselineDigest,
        rendererId: baseline.rendererId,
        rendererVersion: baseline.rendererVersion,
        platformClaim: baseline.platformClaim,
        canonicalAssetDigest: baseline.canonicalAssetDigest,
        svgDigest: baseline.svgDigest,
        width: baseline.width,
        height: baseline.height,
        background: baseline.background,
      })),
    }),
    brandManifestDigest: manifest.brandManifestDigest,
  };

  return JSON.stringify(rootObj, null, 2) + "\n";
}
