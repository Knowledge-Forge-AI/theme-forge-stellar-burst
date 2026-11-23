import { parseDuplicateFreeJson } from "../brand/consumer-lock.js";
import { computeSha256, type Sha256Digest } from "../digests.js";
import { canonicalJson } from "../service-protocol/canonical-json.js";
import {
  hasIllustrationCredentialToken,
  hasIllustrationPrivateTokenPrefix,
} from "./privacy.js";

/** Pure directory-carrier metadata contracts; this module performs no IO. */
export const ILLUSTRATION_CARRIER_SCHEMA_ID = "tfsb.illustration-carrier" as const;
export const ILLUSTRATION_CARRIER_SCHEMA_VERSION = 1 as const;
export const ILLUSTRATION_CARRIER_MANIFEST_DIGEST_BASIS =
  "tfsb-illustration-carrier-v1\n" as const;

export const ILLUSTRATION_CONSUMER_PROFILE_SCHEMA_ID =
  "tfsb.illustration-consumer-profile" as const;
export const ILLUSTRATION_CONSUMER_PROFILE_SCHEMA_VERSION = 1 as const;
export const ILLUSTRATION_CONSUMER_PROFILE_DIGEST_BASIS =
  "tfsb-illustration-consumer-profile-v1\n" as const;

export const ILLUSTRATION_CONSUMER_LOCK_SCHEMA_ID =
  "tfsb.illustration-consumer-lock" as const;
export const ILLUSTRATION_CONSUMER_LOCK_SCHEMA_VERSION = 1 as const;
export const ILLUSTRATION_CONSUMER_LOCK_DIGEST_BASIS =
  "tfsb-illustration-consumer-lock-v1\n" as const;

export const ILLUSTRATION_CARRIER_LIMITS = Object.freeze({
  maxWireBytes: 1_048_576,
  maxIdBytes: 128,
  maxPackageRevision: 1_000_000,
  maxDerivatives: 16,
  maxMappings: 16,
  maxPathBytes: 4_096,
  maxPathSegmentBytes: 255,
  maxPathDepth: 32,
  maxImageBytes: 32 * 1_048_576,
  maxDimension: 16_384,
  maxPixels: 16_777_216,
  maxNesting: 32,
});

export type IllustrationCarrierDigest = Sha256Digest;
export type IllustrationCarrierMime = "image/png" | "image/webp";
export type IllustrationCarrierAlpha = "opaque" | "has-alpha" | "unknown";

export interface IllustrationCarrierDerivativeV1 {
  readonly id: string;
  readonly recipeDigest: IllustrationCarrierDigest;
  readonly mime: IllustrationCarrierMime;
  readonly sha256: IllustrationCarrierDigest;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly alpha: IllustrationCarrierAlpha;
}

export interface IllustrationCarrierManifestWithoutDigestV1 {
  readonly schema: typeof ILLUSTRATION_CARRIER_SCHEMA_ID;
  readonly schemaVersion: typeof ILLUSTRATION_CARRIER_SCHEMA_VERSION;
  readonly packageId: string;
  readonly illustrationId: string;
  readonly revision: number;
  readonly recordDigest: IllustrationCarrierDigest;
  readonly derivatives: readonly IllustrationCarrierDerivativeV1[];
}

export interface IllustrationCarrierManifestV1
  extends IllustrationCarrierManifestWithoutDigestV1 {
  readonly manifestDigest: IllustrationCarrierDigest;
}

export type IllustrationCarrierManifestInput = Omit<
  IllustrationCarrierManifestWithoutDigestV1,
  "schema" | "schemaVersion"
>;

export interface IllustrationConsumerProfileMappingV1 {
  readonly derivativeId: string;
  readonly destination: string;
}

export interface IllustrationConsumerProfileWithoutDigestV1 {
  readonly schema: typeof ILLUSTRATION_CONSUMER_PROFILE_SCHEMA_ID;
  readonly schemaVersion: typeof ILLUSTRATION_CONSUMER_PROFILE_SCHEMA_VERSION;
  readonly id: string;
  readonly packageId: string;
  readonly illustrationId: string;
  readonly mappings: readonly IllustrationConsumerProfileMappingV1[];
}

export interface IllustrationConsumerProfileV1
  extends IllustrationConsumerProfileWithoutDigestV1 {
  readonly profileDigest: IllustrationCarrierDigest;
}

export type IllustrationConsumerProfileInput = Omit<
  IllustrationConsumerProfileWithoutDigestV1,
  "schema" | "schemaVersion"
>;

export interface IllustrationConsumerLockMappingV1 {
  readonly derivativeId: string;
  readonly destination: string;
  readonly recipeDigest: IllustrationCarrierDigest;
  readonly sha256: IllustrationCarrierDigest;
  readonly mime: IllustrationCarrierMime;
  readonly byteLength: number;
}

export interface IllustrationConsumerLockWithoutDigestV1 {
  readonly schema: typeof ILLUSTRATION_CONSUMER_LOCK_SCHEMA_ID;
  readonly schemaVersion: typeof ILLUSTRATION_CONSUMER_LOCK_SCHEMA_VERSION;
  readonly packageId: string;
  readonly illustrationId: string;
  readonly carrierRevision: number;
  readonly profileDigest: IllustrationCarrierDigest;
  readonly manifestDigest: IllustrationCarrierDigest;
  readonly recordDigest: IllustrationCarrierDigest;
  readonly mappings: readonly IllustrationConsumerLockMappingV1[];
}

export interface IllustrationConsumerLockV1
  extends IllustrationConsumerLockWithoutDigestV1 {
  readonly lockDigest: IllustrationCarrierDigest;
}

export type IllustrationConsumerLockInput = Omit<
  IllustrationConsumerLockWithoutDigestV1,
  "schema" | "schemaVersion"
>;

export interface IllustrationCarrierPathsV1 {
  readonly manifest: "manifest.json";
  readonly record: "record.json";
  readonly recipes: readonly string[];
  readonly derivatives: readonly string[];
  readonly all: readonly string[];
}

export type IllustrationCarrierValidationCode =
  | "INVALID_INPUT"
  | "INVALID_SCHEMA"
  | "INVALID_VERSION"
  | "UNKNOWN_FIELD"
  | "MISSING_FIELD"
  | "INVALID_PROTOTYPE"
  | "INVALID_ACCESSOR"
  | "INVALID_TEXT"
  | "INVALID_ID"
  | "INVALID_DIGEST"
  | "INVALID_PATH"
  | "INVALID_VALUE"
  | "BOUNDS_EXCEEDED"
  | "DUPLICATE"
  | "UNSORTED"
  | "INVALID_JSON"
  | "INVALID_UTF8"
  | "BOM_FORBIDDEN"
  | "NESTING_EXCEEDED"
  | "NONCANONICAL_JSON"
  | "DIGEST_MISMATCH";

const ERROR_MESSAGES: Record<IllustrationCarrierValidationCode, string> = {
  INVALID_INPUT: "Illustration carrier input is invalid.",
  INVALID_SCHEMA: "Illustration carrier schema is invalid.",
  INVALID_VERSION: "Illustration carrier schema version is unsupported.",
  UNKNOWN_FIELD: "Illustration carrier input contains an unknown field.",
  MISSING_FIELD: "Illustration carrier input is missing a required field.",
  INVALID_PROTOTYPE: "Illustration carrier input uses an invalid prototype.",
  INVALID_ACCESSOR: "Illustration carrier input contains an accessor.",
  INVALID_TEXT: "Illustration carrier text is invalid.",
  INVALID_ID: "Illustration carrier identifier is invalid.",
  INVALID_DIGEST: "Illustration carrier digest is invalid.",
  INVALID_PATH: "Illustration carrier destination path is invalid.",
  INVALID_VALUE: "Illustration carrier value is invalid.",
  BOUNDS_EXCEEDED: "Illustration carrier input exceeds a supported bound.",
  DUPLICATE: "Illustration carrier input contains a duplicate identity.",
  UNSORTED: "Illustration carrier identity collections must be sorted.",
  INVALID_JSON: "Illustration carrier JSON is invalid duplicate-free JSON.",
  INVALID_UTF8: "Illustration carrier wire data is not valid UTF-8.",
  BOM_FORBIDDEN: "Illustration carrier wire data must not contain a BOM.",
  NESTING_EXCEEDED: "Illustration carrier JSON exceeds the nesting limit.",
  NONCANONICAL_JSON: "Illustration carrier JSON is not canonical.",
  DIGEST_MISMATCH: "Illustration carrier digest does not match.",
};

export class IllustrationCarrierValidationError extends TypeError {
  readonly code: IllustrationCarrierValidationCode;

  constructor(code: IllustrationCarrierValidationCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "IllustrationCarrierValidationError";
    this.code = code;
  }
}

type RecordValue = Record<string, unknown>;
type Digest = IllustrationCarrierDigest;
type ManifestBase = IllustrationCarrierManifestWithoutDigestV1;
type ProfileBase = IllustrationConsumerProfileWithoutDigestV1;
type LockBase = IllustrationConsumerLockWithoutDigestV1;

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PUBLIC_ID = /^[a-z][a-z0-9]*(?:[-._][a-z0-9]+)*$/u;
const MIMES = ["image/png", "image/webp"] as const;
const ALPHAS = ["opaque", "has-alpha", "unknown"] as const;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const PROTECTED_DESTINATION_SEGMENTS = new Set([
  ".git",
  ".tfsb",
  ".serena",
  "node_modules",
]);
const PROTECTED_DESTINATION_FILES = new Set([
  "manifest.json",
  "record.json",
  "profile.json",
  "lock.json",
  "consumer-profile.json",
  "consumer-lock.json",
  "illustration-consumer-profile.json",
  "illustration-consumer-lock.json",
]);

function fail(code: IllustrationCarrierValidationCode): never {
  throw new IllustrationCarrierValidationError(code);
}

function guarded<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof IllustrationCarrierValidationError) throw error;
    fail("INVALID_INPUT");
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  Object.freeze(objectValue);
  return value;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function plainRecord(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_INPUT");
  let prototype: object | null;
  let keys: readonly (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail("INVALID_INPUT");
  }
  if (prototype !== Object.prototype && prototype !== null) fail("INVALID_PROTOTYPE");
  for (const key of keys) {
    if (typeof key !== "string" || RESERVED_KEYS.has(key)) fail("UNKNOWN_FIELD");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("INVALID_ACCESSOR");
  }
  return value as RecordValue;
}

function own(record: RecordValue, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("INVALID_ACCESSOR");
  return descriptor.value;
}

function exact(record: RecordValue, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.getOwnPropertyNames(record)) if (!allowed.has(key)) fail("UNKNOWN_FIELD");
  for (const key of required) if (!Object.hasOwn(record, key)) fail("MISSING_FIELD");
  for (const key of optional) if (Object.hasOwn(record, key)) void own(record, key);
}

function denseArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value)) fail("INVALID_INPUT");
  if (Object.getPrototypeOf(value) !== Array.prototype) fail("INVALID_PROTOTYPE");
  if (value.length > maximum) fail("BOUNDS_EXCEEDED");
  if (Object.getOwnPropertySymbols(value).length !== 0) fail("UNKNOWN_FIELD");
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)) fail("UNKNOWN_FIELD");
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("INVALID_ACCESSOR");
    result.push(descriptor.value);
  }
  return result;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0) fail("INVALID_TEXT");
  if (hasLoneSurrogate(value) || value.normalize("NFC") !== value) fail("INVALID_TEXT");
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) fail("INVALID_TEXT");
  if (value.trim().length === 0 || utf8Length(value) > maximum) fail("BOUNDS_EXCEEDED");
  return value;
}

function identifier(value: unknown): string {
  const result = text(value, ILLUSTRATION_CARRIER_LIMITS.maxIdBytes);
  if (!PUBLIC_ID.test(result) || hasIllustrationPrivateTokenPrefix(result) || hasIllustrationCredentialToken(result)) fail("INVALID_ID");
  return result;
}

function digest(value: unknown): Digest {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("INVALID_DIGEST");
  return value as Digest;
}

function enumeration<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) fail("INVALID_VALUE");
  return value as T;
}

function positiveInteger(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 1 || value > maximum) fail("INVALID_VALUE");
  return value;
}

function dimensions(widthValue: unknown, heightValue: unknown): readonly [number, number] {
  const width = positiveInteger(widthValue, ILLUSTRATION_CARRIER_LIMITS.maxDimension);
  const height = positiveInteger(heightValue, ILLUSTRATION_CARRIER_LIMITS.maxDimension);
  if (width * height > ILLUSTRATION_CARRIER_LIMITS.maxPixels) fail("BOUNDS_EXCEEDED");
  return [width, height];
}

function sortedUnique(values: readonly string[], canonical: boolean): void {
  const ordered = canonical ? values : [...values].sort(utf8Compare);
  if (!canonical && ordered.some((value, index) => value !== values[index])) fail("UNSORTED");
  for (let index = 1; index < ordered.length; index += 1) {
    if (utf8Compare(ordered[index - 1]!, ordered[index]!) >= 0) fail(ordered[index - 1] === ordered[index] ? "DUPLICATE" : "UNSORTED");
  }
}

function textWire(source: string | Uint8Array, maximum: number): string {
  const bytes = typeof source === "string" ? utf8Length(source) : source.byteLength;
  if (bytes > maximum) fail("BOUNDS_EXCEEDED");
  let textValue: string;
  try {
    textValue = typeof source === "string" ? source : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source);
  } catch {
    fail("INVALID_UTF8");
  }
  if (textValue.startsWith("\uFEFF")) fail("BOM_FORBIDDEN");
  return textValue;
}

function assertWireDepth(source: string): void {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of source) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > ILLUSTRATION_CARRIER_LIMITS.maxNesting) fail("NESTING_EXCEEDED");
    } else if (character === "}" || character === "]") depth = Math.max(0, depth - 1);
  }
}

function prettyCanonical(value: unknown): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;
}

function digestCanonical(basis: string, value: unknown): Digest {
  return computeSha256(Buffer.from(`${basis}${canonicalJson(value)}`, "utf8"));
}

function normalizeDerivative(value: unknown): IllustrationCarrierDerivativeV1 {
  const record = plainRecord(value);
  exact(record, ["id", "recipeDigest", "mime", "sha256", "byteLength", "width", "height", "alpha"]);
  const [width, height] = dimensions(own(record, "width"), own(record, "height"));
  return Object.freeze({
    id: identifier(own(record, "id")),
    recipeDigest: digest(own(record, "recipeDigest")),
    mime: enumeration(own(record, "mime"), MIMES),
    sha256: digest(own(record, "sha256")),
    byteLength: positiveInteger(own(record, "byteLength"), ILLUSTRATION_CARRIER_LIMITS.maxImageBytes),
    width,
    height,
    alpha: enumeration(own(record, "alpha"), ALPHAS),
  });
}

interface NormalizedManifest {
  readonly base: ManifestBase;
  readonly manifestDigest?: Digest;
}

function normalizeManifest(value: unknown, requireDigest: boolean, canonicalize: boolean): NormalizedManifest {
  const record = plainRecord(value);
  exact(record, ["schema", "schemaVersion", "packageId", "illustrationId", "revision", "recordDigest", "derivatives"], ["manifestDigest"]);
  if (own(record, "schema") !== ILLUSTRATION_CARRIER_SCHEMA_ID) fail("INVALID_SCHEMA");
  if (own(record, "schemaVersion") !== ILLUSTRATION_CARRIER_SCHEMA_VERSION) fail("INVALID_VERSION");
  const rawDerivatives = denseArray(own(record, "derivatives"), ILLUSTRATION_CARRIER_LIMITS.maxDerivatives);
  if (rawDerivatives.length < 1) fail("INVALID_VALUE");
  const parsedDerivatives = rawDerivatives.map((entry) => normalizeDerivative(entry));
  const derivatives = canonicalize ? [...parsedDerivatives].sort((left, right) => utf8Compare(left.id, right.id)) : parsedDerivatives;
  sortedUnique(derivatives.map((entry) => entry.id), canonicalize);
  const base = Object.freeze({
    schema: ILLUSTRATION_CARRIER_SCHEMA_ID,
    schemaVersion: ILLUSTRATION_CARRIER_SCHEMA_VERSION,
    packageId: identifier(own(record, "packageId")),
    illustrationId: identifier(own(record, "illustrationId")),
    revision: positiveInteger(own(record, "revision"), ILLUSTRATION_CARRIER_LIMITS.maxPackageRevision),
    recordDigest: digest(own(record, "recordDigest")),
    derivatives: Object.freeze(derivatives),
  });
  const manifestDigest = Object.hasOwn(record, "manifestDigest") ? digest(own(record, "manifestDigest")) : undefined;
  if (requireDigest && manifestDigest === undefined) fail("MISSING_FIELD");
  return manifestDigest === undefined ? { base } : { base, manifestDigest };
}

function buildManifestBase(value: unknown): ManifestBase {
  const record = plainRecord(value);
  exact(record, ["packageId", "illustrationId", "revision", "recordDigest", "derivatives"]);
  return normalizeManifest({
    schema: ILLUSTRATION_CARRIER_SCHEMA_ID,
    schemaVersion: ILLUSTRATION_CARRIER_SCHEMA_VERSION,
    packageId: own(record, "packageId"),
    illustrationId: own(record, "illustrationId"),
    revision: own(record, "revision"),
    recordDigest: own(record, "recordDigest"),
    derivatives: own(record, "derivatives"),
  }, false, true).base;
}

export function computeIllustrationCarrierManifestDigest(value: unknown): Digest {
  return guarded(() => digestCanonical(ILLUSTRATION_CARRIER_MANIFEST_DIGEST_BASIS, buildManifestBase(value)));
}

export function createIllustrationCarrierManifest(value: IllustrationCarrierManifestInput): IllustrationCarrierManifestV1 {
  return guarded(() => {
    const base = buildManifestBase(value);
    return validateIllustrationCarrierManifest({
      ...base,
      manifestDigest: digestCanonical(ILLUSTRATION_CARRIER_MANIFEST_DIGEST_BASIS, base),
    });
  });
}

export function validateIllustrationCarrierManifest(value: unknown): IllustrationCarrierManifestV1 {
  return guarded(() => {
    const normalized = normalizeManifest(value, true, false);
    if (normalized.manifestDigest !== digestCanonical(ILLUSTRATION_CARRIER_MANIFEST_DIGEST_BASIS, normalized.base)) fail("DIGEST_MISMATCH");
    return deepFreeze({ ...normalized.base, manifestDigest: normalized.manifestDigest });
  });
}

export function serializeIllustrationCarrierManifest(value: unknown): string {
  return prettyCanonical(validateIllustrationCarrierManifest(value));
}

function normalizeDestination(value: unknown): string {
  const path = text(value, ILLUSTRATION_CARRIER_LIMITS.maxPathBytes);
  if (
    path.startsWith("/") ||
    path.startsWith("~") ||
    /^[A-Za-z]:/u.test(path) ||
    path.includes("\\") ||
    /[<>:"|?*${}%#]/u.test(path)
  ) fail("INVALID_PATH");
  const parts = path.split("/");
  if (parts.length > ILLUSTRATION_CARRIER_LIMITS.maxPathDepth) fail("BOUNDS_EXCEEDED");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) fail("INVALID_PATH");
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (
      utf8Length(part) > ILLUSTRATION_CARRIER_LIMITS.maxPathSegmentBytes ||
      part.startsWith(".") ||
      part.endsWith(" ") ||
      part.endsWith(".") ||
      WINDOWS_RESERVED.test(part) ||
      PROTECTED_DESTINATION_SEGMENTS.has(lower) ||
      lower.startsWith(".git-") ||
      lower.startsWith(".tfsb-") ||
      lower.startsWith(".serena-")
    ) fail("INVALID_PATH");
  }
  const filename = parts[parts.length - 1]!.toLowerCase();
  if (
    PROTECTED_DESTINATION_FILES.has(filename) ||
    filename.endsWith(".lock.json") ||
    filename.endsWith(".profile.json")
  ) fail("INVALID_PATH");
  return path;
}

function mappingOrder(left: { derivativeId: string; destination: string }, right: { derivativeId: string; destination: string }): number {
  return utf8Compare(left.derivativeId, right.derivativeId) || utf8Compare(left.destination, right.destination);
}

function destinationOverlaps(left: string, right: string): boolean {
  const leftKey = left.toLowerCase();
  const rightKey = right.toLowerCase();
  return leftKey === rightKey || leftKey.startsWith(`${rightKey}/`) || rightKey.startsWith(`${leftKey}/`);
}

function checkMappingUniqueness(
  mappings: readonly { derivativeId: string; destination: string }[],
  canonicalize: boolean,
): void {
  const sorted = [...mappings].sort(mappingOrder);
  if (!canonicalize && sorted.some((mapping, index) => mapping !== mappings[index])) fail("UNSORTED");
  const ordered = canonicalize ? sorted : mappings;
  const ids = new Set<string>();
  const destinations = new Set<string>();
  for (let index = 0; index < ordered.length; index += 1) {
    const mapping = ordered[index]!;
    if (ids.has(mapping.derivativeId) || destinations.has(mapping.destination.toLowerCase())) fail("DUPLICATE");
    for (let prior = 0; prior < index; prior += 1) {
      if (destinationOverlaps(ordered[prior]!.destination, mapping.destination)) fail("DUPLICATE");
    }
    ids.add(mapping.derivativeId);
    destinations.add(mapping.destination.toLowerCase());
    if (index > 0 && mappingOrder(ordered[index - 1]!, mapping) >= 0) fail("UNSORTED");
  }
}

function normalizeProfileMapping(value: unknown): IllustrationConsumerProfileMappingV1 {
  const record = plainRecord(value);
  exact(record, ["derivativeId", "destination"]);
  return Object.freeze({
    derivativeId: identifier(own(record, "derivativeId")),
    destination: normalizeDestination(own(record, "destination")),
  });
}

interface NormalizedProfile {
  readonly base: ProfileBase;
  readonly profileDigest?: Digest;
}

function normalizeProfile(value: unknown, requireDigest: boolean, canonicalize: boolean): NormalizedProfile {
  const record = plainRecord(value);
  exact(record, ["schema", "schemaVersion", "id", "packageId", "illustrationId", "mappings"], ["profileDigest"]);
  if (own(record, "schema") !== ILLUSTRATION_CONSUMER_PROFILE_SCHEMA_ID) fail("INVALID_SCHEMA");
  if (own(record, "schemaVersion") !== ILLUSTRATION_CONSUMER_PROFILE_SCHEMA_VERSION) fail("INVALID_VERSION");
  const rawMappings = denseArray(own(record, "mappings"), ILLUSTRATION_CARRIER_LIMITS.maxMappings);
  const parsedMappings = rawMappings.map((entry) => normalizeProfileMapping(entry));
  checkMappingUniqueness(parsedMappings, canonicalize);
  const mappings = canonicalize ? [...parsedMappings].sort(mappingOrder) : parsedMappings;
  const base = Object.freeze({
    schema: ILLUSTRATION_CONSUMER_PROFILE_SCHEMA_ID,
    schemaVersion: ILLUSTRATION_CONSUMER_PROFILE_SCHEMA_VERSION,
    id: identifier(own(record, "id")),
    packageId: identifier(own(record, "packageId")),
    illustrationId: identifier(own(record, "illustrationId")),
    mappings: Object.freeze(mappings),
  });
  const profileDigest = Object.hasOwn(record, "profileDigest") ? digest(own(record, "profileDigest")) : undefined;
  if (requireDigest && profileDigest === undefined) fail("MISSING_FIELD");
  return profileDigest === undefined ? { base } : { base, profileDigest };
}

function buildProfileBase(value: unknown): ProfileBase {
  const record = plainRecord(value);
  exact(record, ["id", "packageId", "illustrationId", "mappings"]);
  return normalizeProfile({
    schema: ILLUSTRATION_CONSUMER_PROFILE_SCHEMA_ID,
    schemaVersion: ILLUSTRATION_CONSUMER_PROFILE_SCHEMA_VERSION,
    id: own(record, "id"),
    packageId: own(record, "packageId"),
    illustrationId: own(record, "illustrationId"),
    mappings: own(record, "mappings"),
  }, false, true).base;
}

export function computeIllustrationConsumerProfileDigest(value: unknown): Digest {
  return guarded(() => digestCanonical(ILLUSTRATION_CONSUMER_PROFILE_DIGEST_BASIS, buildProfileBase(value)));
}

export function createIllustrationConsumerProfile(value: IllustrationConsumerProfileInput): IllustrationConsumerProfileV1 {
  return guarded(() => {
    const base = buildProfileBase(value);
    return validateIllustrationConsumerProfile({
      ...base,
      profileDigest: digestCanonical(ILLUSTRATION_CONSUMER_PROFILE_DIGEST_BASIS, base),
    });
  });
}

export function validateIllustrationConsumerProfile(value: unknown): IllustrationConsumerProfileV1 {
  return guarded(() => {
    const normalized = normalizeProfile(value, true, false);
    if (normalized.profileDigest !== digestCanonical(ILLUSTRATION_CONSUMER_PROFILE_DIGEST_BASIS, normalized.base)) fail("DIGEST_MISMATCH");
    return deepFreeze({ ...normalized.base, profileDigest: normalized.profileDigest });
  });
}

export function serializeIllustrationConsumerProfile(value: unknown): string {
  return prettyCanonical(validateIllustrationConsumerProfile(value));
}

function normalizeLockMapping(value: unknown): IllustrationConsumerLockMappingV1 {
  const record = plainRecord(value);
  exact(record, ["derivativeId", "destination", "recipeDigest", "sha256", "mime", "byteLength"]);
  return Object.freeze({
    derivativeId: identifier(own(record, "derivativeId")),
    destination: normalizeDestination(own(record, "destination")),
    recipeDigest: digest(own(record, "recipeDigest")),
    sha256: digest(own(record, "sha256")),
    mime: enumeration(own(record, "mime"), MIMES),
    byteLength: positiveInteger(own(record, "byteLength"), ILLUSTRATION_CARRIER_LIMITS.maxImageBytes),
  });
}

interface NormalizedLock {
  readonly base: LockBase;
  readonly lockDigest?: Digest;
}

function normalizeLock(value: unknown, requireDigest: boolean, canonicalize: boolean): NormalizedLock {
  const record = plainRecord(value);
  exact(record, ["schema", "schemaVersion", "packageId", "illustrationId", "carrierRevision", "profileDigest", "manifestDigest", "recordDigest", "mappings"], ["lockDigest"]);
  if (own(record, "schema") !== ILLUSTRATION_CONSUMER_LOCK_SCHEMA_ID) fail("INVALID_SCHEMA");
  if (own(record, "schemaVersion") !== ILLUSTRATION_CONSUMER_LOCK_SCHEMA_VERSION) fail("INVALID_VERSION");
  const rawMappings = denseArray(own(record, "mappings"), ILLUSTRATION_CARRIER_LIMITS.maxMappings);
  const parsedMappings = rawMappings.map((entry) => normalizeLockMapping(entry));
  checkMappingUniqueness(parsedMappings, canonicalize);
  const mappings = canonicalize ? [...parsedMappings].sort(mappingOrder) : parsedMappings;
  const base = Object.freeze({
    schema: ILLUSTRATION_CONSUMER_LOCK_SCHEMA_ID,
    schemaVersion: ILLUSTRATION_CONSUMER_LOCK_SCHEMA_VERSION,
    packageId: identifier(own(record, "packageId")),
    illustrationId: identifier(own(record, "illustrationId")),
    carrierRevision: positiveInteger(own(record, "carrierRevision"), ILLUSTRATION_CARRIER_LIMITS.maxPackageRevision),
    profileDigest: digest(own(record, "profileDigest")),
    manifestDigest: digest(own(record, "manifestDigest")),
    recordDigest: digest(own(record, "recordDigest")),
    mappings: Object.freeze(mappings),
  });
  const lockDigest = Object.hasOwn(record, "lockDigest") ? digest(own(record, "lockDigest")) : undefined;
  if (requireDigest && lockDigest === undefined) fail("MISSING_FIELD");
  return lockDigest === undefined ? { base } : { base, lockDigest };
}

function buildLockBase(value: unknown): LockBase {
  const record = plainRecord(value);
  exact(record, ["packageId", "illustrationId", "carrierRevision", "profileDigest", "manifestDigest", "recordDigest", "mappings"]);
  return normalizeLock({
    schema: ILLUSTRATION_CONSUMER_LOCK_SCHEMA_ID,
    schemaVersion: ILLUSTRATION_CONSUMER_LOCK_SCHEMA_VERSION,
    packageId: own(record, "packageId"),
    illustrationId: own(record, "illustrationId"),
    carrierRevision: own(record, "carrierRevision"),
    profileDigest: own(record, "profileDigest"),
    manifestDigest: own(record, "manifestDigest"),
    recordDigest: own(record, "recordDigest"),
    mappings: own(record, "mappings"),
  }, false, true).base;
}

export function computeIllustrationConsumerLockDigest(value: unknown): Digest {
  return guarded(() => digestCanonical(ILLUSTRATION_CONSUMER_LOCK_DIGEST_BASIS, buildLockBase(value)));
}

export function createIllustrationConsumerLock(value: IllustrationConsumerLockInput): IllustrationConsumerLockV1 {
  return guarded(() => {
    const base = buildLockBase(value);
    return validateIllustrationConsumerLock({
      ...base,
      lockDigest: digestCanonical(ILLUSTRATION_CONSUMER_LOCK_DIGEST_BASIS, base),
    });
  });
}

export function validateIllustrationConsumerLock(value: unknown): IllustrationConsumerLockV1 {
  return guarded(() => {
    const normalized = normalizeLock(value, true, false);
    if (normalized.lockDigest !== digestCanonical(ILLUSTRATION_CONSUMER_LOCK_DIGEST_BASIS, normalized.base)) fail("DIGEST_MISMATCH");
    return deepFreeze({ ...normalized.base, lockDigest: normalized.lockDigest });
  });
}

export function serializeIllustrationConsumerLock(value: unknown): string {
  return prettyCanonical(validateIllustrationConsumerLock(value));
}

function parseWire<T>(
  source: string | Uint8Array,
  sourceName: string,
  validate: (value: unknown) => T,
  serialize: (value: T) => string,
): T {
  return guarded(() => {
    void sourceName;
    const textValue = textWire(source, ILLUSTRATION_CARRIER_LIMITS.maxWireBytes);
    assertWireDepth(textValue);
    let parsed: unknown;
    try {
      parsed = parseDuplicateFreeJson(textValue, {
        operation: "validate",
        domain: "brand",
        source: "illustration-carrier-v1",
      });
    } catch {
      fail("INVALID_JSON");
    }
    const value = validate(parsed);
    if (serialize(value) !== textValue) fail("NONCANONICAL_JSON");
    return value;
  });
}

export function parseIllustrationCarrierManifest(source: string | Uint8Array, sourceName = "manifest.json"): IllustrationCarrierManifestV1 {
  return parseWire(source, sourceName, (parsed) => validateIllustrationCarrierManifest(parsed), serializeIllustrationCarrierManifest);
}

export function parseIllustrationConsumerProfile(source: string | Uint8Array, sourceName = "profile.json"): IllustrationConsumerProfileV1 {
  return parseWire(source, sourceName, (parsed) => validateIllustrationConsumerProfile(parsed), serializeIllustrationConsumerProfile);
}

export function parseIllustrationConsumerLock(source: string | Uint8Array, sourceName = "lock.json"): IllustrationConsumerLockV1 {
  return parseWire(source, sourceName, (parsed) => validateIllustrationConsumerLock(parsed), serializeIllustrationConsumerLock);
}

function extensionFor(mime: IllustrationCarrierMime): "png" | "webp" {
  return mime === "image/png" ? "png" : "webp";
}

/** Derive carrier paths from validated IDs and MIME values; no input path is accepted. */
export function deriveIllustrationCarrierPaths(value: unknown): IllustrationCarrierPathsV1 {
  return guarded(() => {
    const manifest = validateIllustrationCarrierManifest(value);
    const recipes = manifest.derivatives.map((derivative) => `recipes/${derivative.id}.json`);
    const derivatives = manifest.derivatives.map((derivative) => `derivatives/${derivative.id}.${extensionFor(derivative.mime)}`);
    return deepFreeze({
      manifest: "manifest.json" as const,
      record: "record.json" as const,
      recipes: Object.freeze(recipes),
      derivatives: Object.freeze(derivatives),
      all: Object.freeze(["manifest.json", "record.json", ...recipes, ...derivatives]),
    });
  });
}
