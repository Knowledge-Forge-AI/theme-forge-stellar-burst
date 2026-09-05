export const BRAND_SCHEMA_ID = "tfsb.brand" as const;
export const BRAND_SCHEMA_VERSION = 1 as const;
export const BRAND_TOML_MAX_BYTES = 1048576; // 1 MiB
export const BRAND_DIGEST_BASIS = "tfsb.brand-v1\n" as const;
export const BRAND_SYSTEM_DIGEST_BASIS = "tfsb-brand-system-v1\n" as const;

export const BRAND_BUILTIN_ROLES = [
  "mark",
  "wordmark",
  "lockup-horizontal",
  "lockup-stacked",
  "favicon",
  "app-icon",
  "avatar",
  "social-card",
] as const;

export type BrandBuiltinRole = (typeof BRAND_BUILTIN_ROLES)[number];

export const OPTIONAL_BRAND_DOMAINS = [
  "tokens",
  "recipes",
  "qa",
  "consumer_profiles",
  "package",
  "exports",
] as const;

export type BrandOptionalDomain = (typeof OPTIONAL_BRAND_DOMAINS)[number];

export type BrandDomain = "brand" | BrandOptionalDomain;

export interface BrandFileEntry {
  readonly filename: string;
  readonly canonicalPath: string;
  readonly domain: BrandDomain;
  readonly maxBytes: number;
}

export const BRAND_FILE_INVENTORY: readonly BrandFileEntry[] = Object.freeze([
  Object.freeze({ filename: "brand.toml", canonicalPath: ".tfsb/brand.toml", domain: "brand", maxBytes: BRAND_TOML_MAX_BYTES }),
  Object.freeze({ filename: "brand-tokens.toml", canonicalPath: ".tfsb/brand-tokens.toml", domain: "tokens", maxBytes: BRAND_TOML_MAX_BYTES }),
  Object.freeze({ filename: "brand-recipes.toml", canonicalPath: ".tfsb/brand-recipes.toml", domain: "recipes", maxBytes: BRAND_TOML_MAX_BYTES }),
  Object.freeze({ filename: "brand-qa.toml", canonicalPath: ".tfsb/brand-qa.toml", domain: "qa", maxBytes: BRAND_TOML_MAX_BYTES }),
  Object.freeze({ filename: "consumer-profiles.toml", canonicalPath: ".tfsb/consumer-profiles.toml", domain: "consumer_profiles", maxBytes: BRAND_TOML_MAX_BYTES }),
  Object.freeze({ filename: "brand-package.toml", canonicalPath: ".tfsb/brand-package.toml", domain: "package", maxBytes: BRAND_TOML_MAX_BYTES }),
  Object.freeze({ filename: "brand-exports.toml", canonicalPath: ".tfsb/brand-exports.toml", domain: "exports", maxBytes: BRAND_TOML_MAX_BYTES }),
]);

const BY_CANONICAL_PATH = new Map<string, BrandFileEntry>(
  BRAND_FILE_INVENTORY.map((entry) => [entry.canonicalPath, entry]),
);

export function isFixedBrandFilePath(path: string): boolean {
  return BY_CANONICAL_PATH.has(path);
}

export function getFixedBrandFile(path: string): BrandFileEntry | undefined {
  return BY_CANONICAL_PATH.get(path);
}

export const BRAND_DERIVED_RECEIPT_DIR = ".tfsb/derived" as const;
export const DERIVED_RECEIPT_SUFFIX = ".receipt.json" as const;

const DERIVED_RECEIPT_PATH_REGEX = /^\.tfsb\/derived\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.receipt\.json$/;

export function isDerivedReceiptPath(path: string): boolean {
  return DERIVED_RECEIPT_PATH_REGEX.test(path);
}

export function derivedReceiptPath(assetId: string): string {
  return `${BRAND_DERIVED_RECEIPT_DIR}/${assetId}${DERIVED_RECEIPT_SUFFIX}`;
}

export function derivedReceiptTargetId(path: string): string | undefined {
  const match = DERIVED_RECEIPT_PATH_REGEX.exec(path);
  return match === null ? undefined : match[1];
}

export const BRAND_BASELINE_DIR = ".tfsb/brand-baselines" as const;
export const BRAND_BASELINE_MAX_FILES = 256;
export const BRAND_BASELINE_MAX_FILE_BYTES = 32 * 1_048_576;
export const BRAND_BASELINE_MAX_AGGREGATE_BYTES = 256 * 1_048_576;
const BRAND_BASELINE_PATH_REGEX = /^\.tfsb\/brand-baselines\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.png$/;

export function isBrandBaselinePath(path: string): boolean {
  return BRAND_BASELINE_PATH_REGEX.test(path);
}

export function brandBaselinePath(profileId: string, caseId: string): string {
  return `${BRAND_BASELINE_DIR}/${profileId}/${caseId}.png`;
}

export function parseBrandBaselinePath(path: string): { readonly profileId: string; readonly caseId: string } | undefined {
  const match = BRAND_BASELINE_PATH_REGEX.exec(path);
  return match === null ? undefined : Object.freeze({ profileId: match[1]!, caseId: match[2]! });
}

export const BRAND_RASTER_RECEIPT_DIR = ".tfsb/raster-receipts" as const;
export const BRAND_RASTER_RECEIPT_MAX_FILES = 128;
export const BRAND_RASTER_RECEIPT_MAX_FILE_BYTES = 1_048_576;
const BRAND_RASTER_RECEIPT_PATH_REGEX = /^\.tfsb\/raster-receipts\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.receipt\.json$/;

export function isRasterReceiptPath(path: string): boolean { return BRAND_RASTER_RECEIPT_PATH_REGEX.test(path); }
export function rasterReceiptCanonicalPath(profileId: string, outputId: string): string { return `${BRAND_RASTER_RECEIPT_DIR}/${profileId}/${outputId}.receipt.json`; }
export function parseRasterReceiptCanonicalPath(path: string): { readonly profileId: string; readonly outputId: string } | undefined {
  const match = BRAND_RASTER_RECEIPT_PATH_REGEX.exec(path);
  return match === null ? undefined : Object.freeze({ profileId: match[1]!, outputId: match[2]! });
}
