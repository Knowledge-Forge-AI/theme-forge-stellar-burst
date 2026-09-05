import { fail, fromCaught, ok, type DiagnosticContext, DiagnosticError } from "../diagnostics.js";
import { computeSha256, type Sha256Digest } from "../digests.js";
import { compareUtf8 } from "../provenance.js";
import type { AnyNormalizedProject } from "../schema-dispatch.js";
import type { Result } from "../types.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import type { ConsumerProfilesModel } from "./consumer-profile.js";
import { isProtectedConsumerDestination, validateConsumerDestination } from "./consumer-profile.js";
import { BRAND_PACKAGE_COMPANION_PURPOSES } from "./brand-package.js";
import { isValidBrandRole } from "./brand-schema.js";

export const CONSUMER_LOCK_SCHEMA = "tfsb.brand-lock" as const;
export const CONSUMER_LOCK_SCHEMA_VERSION = 1 as const;
export const CONSUMER_LOCK_MAX_BYTES = 1_048_576;
export const CONSUMER_LOCK_MAX_PACKAGES = 8;
export const CONSUMER_LOCK_MAX_PROFILES = 8;
export const CONSUMER_LOCK_MAX_INSTALLED = 512;
export const CONSUMER_LOCK_DIGEST_BASIS = "tfsb-brand-lock-v1\n" as const;
export const CONSUMER_PROJECT_DIGEST_BASIS = "tfsb-consumer-project-v1\n" as const;

export interface ConsumerLocalBundleSource {
  readonly kind: "local-bundle";
  readonly packageId: string;
  readonly brandVersion: string;
  readonly genericManifestByteDigest: Sha256Digest;
  readonly brandManifestDigest: Sha256Digest;
}

export interface ConsumerNpmInstalledSource extends Omit<ConsumerLocalBundleSource, "kind"> {
  readonly kind: "npm-installed";
  readonly npmName: string;
  readonly npmVersion: string;
}
export type ConsumerLockSource = ConsumerLocalBundleSource | ConsumerNpmInstalledSource;

export interface ConsumerLockSelectedProfile {
  readonly id: string;
  readonly version: number;
  readonly digest: Sha256Digest;
  readonly parameters: Readonly<Record<string, string>>;
}

export interface ConsumerLockAssetMapping {
  readonly kind: "asset";
  readonly assetId: string;
  readonly family?: string;
  readonly role?: string;
  readonly variant?: string;
  readonly destination: string;
  readonly canonicalAssetDigest: Sha256Digest;
  readonly svgDigest: Sha256Digest;
  readonly installedDigest: Sha256Digest;
}

export interface ConsumerLockCompanionMapping {
  readonly kind: "companion";
  readonly companionId: string;
  readonly purpose: string;
  readonly destination: string;
  readonly sourceDigest: Sha256Digest;
  readonly installedDigest: Sha256Digest;
}
export type ConsumerLockInstalledMapping = ConsumerLockAssetMapping | ConsumerLockCompanionMapping;

export interface ConsumerLockPackage {
  readonly packageId: string;
  readonly brandVersion: string;
  readonly source: ConsumerLockSource;
  readonly genericManifestByteDigest: Sha256Digest;
  readonly brandManifestDigest: Sha256Digest;
  readonly brandSystemDigest: Sha256Digest;
  readonly tokenDigest: Sha256Digest | null;
  readonly recipeDigest: Sha256Digest | null;
  readonly qaDigest: Sha256Digest | null;
  readonly consumerProfileDigest: Sha256Digest | null;
  readonly exportDigest: Sha256Digest | null;
  readonly brandPackageDigest: Sha256Digest;
  readonly profiles: readonly ConsumerLockSelectedProfile[];
  readonly installed: readonly ConsumerLockInstalledMapping[];
}

export interface ConsumerBrandLockWithoutDigest {
  readonly schema: typeof CONSUMER_LOCK_SCHEMA;
  readonly schemaVersion: typeof CONSUMER_LOCK_SCHEMA_VERSION;
  readonly consumerProjectDigest: Sha256Digest;
  readonly packages: readonly ConsumerLockPackage[];
  readonly toolVersion: string;
}
export interface ConsumerBrandLock extends ConsumerBrandLockWithoutDigest { readonly lockDigest: Sha256Digest; }

type Rec = Record<string, unknown>;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const QUALIFIED = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function ctx(source?: string): DiagnosticContext { return { operation: "parse", domain: "brand", ...(source === undefined ? {} : { source }) }; }
function rec(value: unknown, context: DiagnosticContext, at: string): Rec { if (typeof value !== "object" || value === null || Array.isArray(value)) fail(context, "CONSUMER_LOCK_INVALID", "Expected an object.", at); return value as Rec; }
function arr(value: unknown, context: DiagnosticContext, at: string): readonly unknown[] { if (!Array.isArray(value)) fail(context, "CONSUMER_LOCK_INVALID", "Expected an array.", at); return value; }
function str(value: unknown, context: DiagnosticContext, at: string): string { if (typeof value !== "string") fail(context, "CONSUMER_LOCK_INVALID", "Expected a string.", at); return value; }
function int(value: unknown, context: DiagnosticContext, at: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(context, "CONSUMER_LOCK_INVALID", "Expected a safe integer.", at); return value; }
function exact(value: Rec, allowed: readonly string[], context: DiagnosticContext, at: string): void {
  const actual = Object.keys(value);
  for (const key of actual) if (!allowed.includes(key)) fail(context, "SCHEMA_UNKNOWN_KEY", `Unknown key '${key}'.`, at === "" ? key : `${at}.${key}`);
  for (const key of allowed) if (!Object.hasOwn(value, key)) fail(context, "CONSUMER_LOCK_INVALID", `Missing key '${key}'.`, at === "" ? key : `${at}.${key}`);
}
function digest(value: unknown, context: DiagnosticContext, at: string): Sha256Digest { const text = str(value, context, at); if (!DIGEST.test(text)) fail(context, "CONSUMER_LOCK_INVALID_DIGEST", "Expected sha256:<64-lowercase-hex>.", at); return text as Sha256Digest; }
function nullableDigest(value: unknown, context: DiagnosticContext, at: string): Sha256Digest | null { return value === null ? null : digest(value, context, at); }
function identifier(value: unknown, context: DiagnosticContext, at: string): string { const text = str(value, context, at); if (Buffer.byteLength(text) > 64 || !ID.test(text)) fail(context, "CONSUMER_LOCK_INVALID_IDENTITY", "Expected a bounded lowercase kebab identifier.", at); return text; }

class ClosedJsonParser {
  #i = 0;
  constructor(private readonly source: string, private readonly context: DiagnosticContext) {}
  parse(): unknown { const value = this.value(); this.ws(); if (this.#i !== this.source.length) this.bad(); return value; }
  private ws(): void { while (/\s/.test(this.source[this.#i] ?? "")) this.#i++; }
  private bad(): never { fail(this.context, "CONSUMER_LOCK_INVALID_JSON", "Input is not valid duplicate-free JSON."); }
  private value(): unknown {
    this.ws(); const ch = this.source[this.#i];
    if (ch === "{") return this.object();
    if (ch === "[") return this.array();
    if (ch === '"') return this.string();
    for (const [word, value] of [["true", true], ["false", false], ["null", null]] as const) if (this.source.startsWith(word, this.#i)) { this.#i += word.length; return value; }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.#i));
    if (match !== null) { this.#i += match[0].length; const number = Number(match[0]); if (!Number.isFinite(number)) this.bad(); return number; }
    return this.bad();
  }
  private string(): string {
    const start = this.#i++;
    while (this.#i < this.source.length) {
      const ch = this.source[this.#i++]!;
      if (ch === '"') { try { return JSON.parse(this.source.slice(start, this.#i)) as string; } catch { return this.bad(); } }
      if (ch === "\\") { if (this.source[this.#i] === "u") this.#i += 5; else this.#i++; }
      else if (ch.charCodeAt(0) < 0x20) this.bad();
    }
    return this.bad();
  }
  private object(): Rec {
    this.#i++; const out: Rec = Object.create(null) as Rec; const seen = new Set<string>(); this.ws();
    if (this.source[this.#i] === "}") { this.#i++; return out; }
    while (true) {
      this.ws(); if (this.source[this.#i] !== '"') this.bad(); const key = this.string();
      if (seen.has(key)) fail(this.context, "SCHEMA_DUPLICATE_KEY", `Duplicate JSON key '${key}'.`); seen.add(key);
      this.ws(); if (this.source[this.#i++] !== ":") this.bad(); out[key] = this.value(); this.ws();
      const ch = this.source[this.#i++]; if (ch === "}") return out; if (ch !== ",") this.bad();
    }
  }
  private array(): readonly unknown[] {
    this.#i++; const out: unknown[] = []; this.ws(); if (this.source[this.#i] === "]") { this.#i++; return out; }
    while (true) { out.push(this.value()); this.ws(); const ch = this.source[this.#i++]; if (ch === "]") return out; if (ch !== ",") this.bad(); }
  }
}

export function parseDuplicateFreeJson(source: string, context: DiagnosticContext): unknown {
  return new ClosedJsonParser(source, context).parse();
}

function parseSource(value: unknown, context: DiagnosticContext, at: string): ConsumerLockSource {
  const source = rec(value, context, at), kind = str(source.kind, context, `${at}.kind`);
  const common = ["kind", "packageId", "brandVersion", "genericManifestByteDigest", "brandManifestDigest"];
  if (kind === "npm-installed") exact(source, [...common, "npmName", "npmVersion"], context, at);
  else if (kind === "local-bundle") exact(source, common, context, at);
  else fail(context, "CONSUMER_LOCK_INVALID_SOURCE", "Unknown consumer source kind.", `${at}.kind`);
  const packageId = identifier(source.packageId, context, `${at}.packageId`), brandVersion = str(source.brandVersion, context, `${at}.brandVersion`);
  if (!SEMVER.test(brandVersion)) fail(context, "CONSUMER_LOCK_INVALID_IDENTITY", "Invalid brand SemVer.", `${at}.brandVersion`);
  const commonValue = { packageId, brandVersion, genericManifestByteDigest: digest(source.genericManifestByteDigest, context, `${at}.genericManifestByteDigest`), brandManifestDigest: digest(source.brandManifestDigest, context, `${at}.brandManifestDigest`) };
  if (kind === "local-bundle") return Object.freeze({ kind, ...commonValue });
  const npmName = str(source.npmName, context, `${at}.npmName`), npmVersion = str(source.npmVersion, context, `${at}.npmVersion`);
  if (npmName.length < 1 || npmName.length > 214 || /[\s\\]/.test(npmName) || npmName.startsWith("/") || !SEMVER.test(npmVersion)) fail(context, "CONSUMER_LOCK_INVALID_IDENTITY", "Invalid npm identity.", at);
  return Object.freeze({ kind, ...commonValue, npmName, npmVersion });
}

function parseProfile(value: unknown, context: DiagnosticContext, at: string): ConsumerLockSelectedProfile {
  const profile = rec(value, context, at); exact(profile, ["id", "version", "digest", "parameters"], context, at);
  const id = str(profile.id, context, `${at}.id`); if (!QUALIFIED.test(id)) fail(context, "CONSUMER_LOCK_INVALID_IDENTITY", "Selected profile must have qualified identity.", `${at}.id`);
  const version = int(profile.version, context, `${at}.version`); if (version < 1 || version > 65_535) fail(context, "CONSUMER_LOCK_INVALID", "Profile version is out of range.", `${at}.version`);
  const parametersRaw = rec(profile.parameters, context, `${at}.parameters`), parameters: Record<string, string> = {};
  const parameterKeys = Object.keys(parametersRaw).sort(compareUtf8);
  if (parameterKeys.length > 16) fail(context, "RESOURCE_LIMIT_EXCEEDED", "Selected parameter map exceeds 16 entries.", `${at}.parameters`);
  for (const key of parameterKeys) { if (!ID.test(key) || typeof parametersRaw[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parametersRaw[key] as string) || Buffer.byteLength(parametersRaw[key] as string, "utf8") > 64) fail(context, "CONSUMER_LOCK_INVALID", "Invalid selected parameter map.", `${at}.parameters`); parameters[key] = parametersRaw[key] as string; }
  return Object.freeze({ id, version, digest: digest(profile.digest, context, `${at}.digest`), parameters: Object.freeze(parameters) });
}

function parseMapping(value: unknown, context: DiagnosticContext, at: string): ConsumerLockInstalledMapping {
  const mapping = rec(value, context, at), kind = str(mapping.kind, context, `${at}.kind`);
  const destination = validateConsumerDestination(mapping.destination, `${at}.destination`);
  if (isProtectedConsumerDestination(destination)) fail(context, "CONSUMER_DESTINATION_PROTECTED", "Lock mapping targets a protected path.", `${at}.destination`);
  if (kind === "companion") {
    exact(mapping, ["kind", "companionId", "purpose", "destination", "sourceDigest", "installedDigest"], context, at);
    const purpose = str(mapping.purpose, context, `${at}.purpose`);
    if (!(BRAND_PACKAGE_COMPANION_PURPOSES as readonly string[]).includes(purpose)) fail(context, "CONSUMER_LOCK_INVALID", "Companion purpose must preserve the closed owner-authored classification.", `${at}.purpose`);
    return Object.freeze({ kind, companionId: identifier(mapping.companionId, context, `${at}.companionId`), purpose, destination, sourceDigest: digest(mapping.sourceDigest, context, `${at}.sourceDigest`), installedDigest: digest(mapping.installedDigest, context, `${at}.installedDigest`) });
  }
  if (kind !== "asset") fail(context, "CONSUMER_LOCK_INVALID", "Unknown installed mapping kind.", `${at}.kind`);
  const hasBinding = mapping.family !== undefined || mapping.role !== undefined || mapping.variant !== undefined;
  exact(mapping, hasBinding ? ["kind", "assetId", "family", "role", "variant", "destination", "canonicalAssetDigest", "svgDigest", "installedDigest"] : ["kind", "assetId", "destination", "canonicalAssetDigest", "svgDigest", "installedDigest"], context, at);
  if (hasBinding && (mapping.family === undefined || mapping.role === undefined || mapping.variant === undefined)) fail(context, "CONSUMER_LOCK_INVALID", "Asset binding identity must be complete.", at);
  const role = hasBinding ? str(mapping.role, context, `${at}.role`) : undefined;
  if (role !== undefined && !isValidBrandRole(role)) fail(context, "CONSUMER_LOCK_INVALID", "Asset binding role is invalid.", `${at}.role`);
  return Object.freeze({ kind, assetId: identifier(mapping.assetId, context, `${at}.assetId`), ...(hasBinding ? { family: identifier(mapping.family, context, `${at}.family`), role: role!, variant: identifier(mapping.variant, context, `${at}.variant`) } : {}), destination, canonicalAssetDigest: digest(mapping.canonicalAssetDigest, context, `${at}.canonicalAssetDigest`), svgDigest: digest(mapping.svgDigest, context, `${at}.svgDigest`), installedDigest: digest(mapping.installedDigest, context, `${at}.installedDigest`) });
}

function parsePackage(value: unknown, context: DiagnosticContext, at: string): ConsumerLockPackage {
  const pkg = rec(value, context, at);
  exact(pkg, ["packageId", "brandVersion", "source", "genericManifestByteDigest", "brandManifestDigest", "brandSystemDigest", "tokenDigest", "recipeDigest", "qaDigest", "consumerProfileDigest", "exportDigest", "brandPackageDigest", "profiles", "installed"], context, at);
  const packageId = identifier(pkg.packageId, context, `${at}.packageId`), brandVersion = str(pkg.brandVersion, context, `${at}.brandVersion`), source = parseSource(pkg.source, context, `${at}.source`);
  if (!SEMVER.test(brandVersion) || source.packageId !== packageId || source.brandVersion !== brandVersion) fail(context, "CONSUMER_LOCK_INCONSISTENT", "Package and source identities disagree.", at);
  const genericManifestByteDigest = digest(pkg.genericManifestByteDigest, context, `${at}.genericManifestByteDigest`), brandManifestDigest = digest(pkg.brandManifestDigest, context, `${at}.brandManifestDigest`);
  if (source.genericManifestByteDigest !== genericManifestByteDigest || source.brandManifestDigest !== brandManifestDigest) fail(context, "CONSUMER_LOCK_INCONSISTENT", "Package and source manifest identities disagree.", at);
  const profilesRaw = arr(pkg.profiles, context, `${at}.profiles`), installedRaw = arr(pkg.installed, context, `${at}.installed`);
  if (profilesRaw.length < 1) fail(context, "CONSUMER_LOCK_INCONSISTENT", "Each locked package must select at least one profile.", `${at}.profiles`);
  const profiles = profilesRaw.map((entry, i) => parseProfile(entry, context, `${at}.profiles[${i}]`)).sort((a, b) => compareUtf8(a.id, b.id));
  const installed = installedRaw.map((entry, i) => parseMapping(entry, context, `${at}.installed[${i}]`)).sort((a, b) => compareUtf8(a.destination, b.destination));
  if (profiles.some((profile) => !profile.id.startsWith(`${packageId}/`))) fail(context, "CONSUMER_LOCK_INCONSISTENT", "Selected profile belongs to another package.", `${at}.profiles`);
  if (new Set(profiles.map((entry) => entry.id)).size !== profiles.length || new Set(installed.map((entry) => entry.destination.toLowerCase())).size !== installed.length) fail(context, "CONSUMER_LOCK_DUPLICATE", "Package contains duplicate profile or destination identity.", at);
  const consumerProfileDigest = nullableDigest(pkg.consumerProfileDigest, context, `${at}.consumerProfileDigest`);
  if (consumerProfileDigest === null) fail(context, "CONSUMER_LOCK_INCONSISTENT", "A package with selected profiles requires consumerProfileDigest.", `${at}.consumerProfileDigest`);
  return Object.freeze({ packageId, brandVersion, source, genericManifestByteDigest, brandManifestDigest, brandSystemDigest: digest(pkg.brandSystemDigest, context, `${at}.brandSystemDigest`), tokenDigest: nullableDigest(pkg.tokenDigest, context, `${at}.tokenDigest`), recipeDigest: nullableDigest(pkg.recipeDigest, context, `${at}.recipeDigest`), qaDigest: nullableDigest(pkg.qaDigest, context, `${at}.qaDigest`), consumerProfileDigest, exportDigest: nullableDigest(pkg.exportDigest, context, `${at}.exportDigest`), brandPackageDigest: digest(pkg.brandPackageDigest, context, `${at}.brandPackageDigest`), profiles: Object.freeze(profiles), installed: Object.freeze(installed) });
}

export function computeConsumerLockDigest(lock: ConsumerBrandLockWithoutDigest): Sha256Digest { return computeSha256(Buffer.from(CONSUMER_LOCK_DIGEST_BASIS + encodeCanonicalJson(lock), "utf8")); }
export function computeConsumerProjectDigest(project: AnyNormalizedProject, localConsumerProfiles: ConsumerProfilesModel | null): Sha256Digest { return computeSha256(Buffer.from(CONSUMER_PROJECT_DIGEST_BASIS + encodeCanonicalJson({ project, localConsumerProfiles }), "utf8")); }

export function createConsumerBrandLock(value: ConsumerBrandLockWithoutDigest): ConsumerBrandLock {
  const packages = [...value.packages].map((pkg) => Object.freeze({ ...pkg, profiles: Object.freeze([...pkg.profiles].sort((a, b) => compareUtf8(a.id, b.id))), installed: Object.freeze([...pkg.installed].sort((a, b) => compareUtf8(a.destination, b.destination))) })).sort((a, b) => compareUtf8(a.packageId, b.packageId));
  const without = Object.freeze({ ...value, packages: Object.freeze(packages) });
  const lock = Object.freeze({ ...without, lockDigest: computeConsumerLockDigest(without) });
  const reparsed = parseConsumerBrandLock(serializeConsumerBrandLock(lock));
  if (!reparsed.ok) throw new DiagnosticError(reparsed.diagnostics[0]!);
  return reparsed.value;
}

export function serializeConsumerBrandLock(lock: ConsumerBrandLock): string { return `${encodeCanonicalJson(lock)}\n`; }

export function parseConsumerBrandLock(source: string, sourceName = ".tfsb/brand.lock.json"): Result<ConsumerBrandLock> {
  const context = ctx(sourceName);
  try {
    if (Buffer.byteLength(source, "utf8") > CONSUMER_LOCK_MAX_BYTES) fail(context, "RESOURCE_LIMIT_EXCEEDED", "brand.lock.json exceeds 1 MiB.", sourceName);
    if (source.startsWith("\uFEFF")) fail(context, "SCHEMA_INVALID_BOM", "UTF-8 BOM is forbidden.", sourceName);
    const root = rec(parseDuplicateFreeJson(source, context), context, "");
    exact(root, ["schema", "schemaVersion", "consumerProjectDigest", "packages", "toolVersion", "lockDigest"], context, "");
    if (str(root.schema, context, "schema") !== CONSUMER_LOCK_SCHEMA || int(root.schemaVersion, context, "schemaVersion") !== 1) fail(context, "SCHEMA_INVALID_VERSION", "Unsupported consumer lock schema.");
    const packageRaw = arr(root.packages, context, "packages"); if (packageRaw.length > CONSUMER_LOCK_MAX_PACKAGES) fail(context, "RESOURCE_LIMIT_EXCEEDED", "A lock may contain at most eight packages.", "packages");
    const packages = packageRaw.map((entry, i) => parsePackage(entry, context, `packages[${i}]`)).sort((a, b) => compareUtf8(a.packageId, b.packageId));
    if (new Set(packages.map((entry) => entry.packageId)).size !== packages.length) fail(context, "CONSUMER_LOCK_DUPLICATE", "Duplicate package identity.", "packages");
    const profiles = packages.flatMap((pkg) => pkg.profiles), installed = packages.flatMap((pkg) => pkg.installed);
    if (profiles.length > CONSUMER_LOCK_MAX_PROFILES || installed.length > CONSUMER_LOCK_MAX_INSTALLED) fail(context, "RESOURCE_LIMIT_EXCEEDED", "Lock profile or installed mapping limit exceeded.");
    const destinations = installed.map((entry) => entry.destination);
    const folded = new Set<string>();
    for (const destination of destinations.sort(compareUtf8)) {
      const portable = destination.toLowerCase(); if (folded.has(portable)) fail(context, "CONSUMER_LOCK_DUPLICATE", "Duplicate portable destination.", destination); folded.add(portable);
      if (destinations.some((other) => other !== destination && (other.startsWith(`${destination}/`) || destination.startsWith(`${other}/`)))) fail(context, "CONSUMER_LOCK_OVERLAP", "Installed destinations overlap.", destination);
    }
    const toolVersion = str(root.toolVersion, context, "toolVersion");
    if (!SEMVER.test(toolVersion)) fail(context, "CONSUMER_LOCK_INVALID_IDENTITY", "toolVersion must be strict SemVer.", "toolVersion");
    const without: ConsumerBrandLockWithoutDigest = Object.freeze({ schema: CONSUMER_LOCK_SCHEMA, schemaVersion: 1, consumerProjectDigest: digest(root.consumerProjectDigest, context, "consumerProjectDigest"), packages: Object.freeze(packages), toolVersion });
    const lockDigest = digest(root.lockDigest, context, "lockDigest"); if (computeConsumerLockDigest(without) !== lockDigest) fail(context, "CONSUMER_LOCK_DIGEST_MISMATCH", "Consumer lock self-digest does not match.", "lockDigest");
    const lock = Object.freeze({ ...without, lockDigest });
    if (serializeConsumerBrandLock(lock) !== source) fail(context, "CONSUMER_LOCK_NONCANONICAL", "brand.lock.json must use canonical JSON with one final LF.", sourceName);
    return ok(lock);
  } catch (error) {
    return fromCaught(error, context, "CONSUMER_LOCK_INVALID_JSON", "Failed to parse consumer lock.", (caught) => caught instanceof SyntaxError || caught instanceof DiagnosticError);
  }
}

export function mergeConsumerLockPackage(lock: ConsumerBrandLock | undefined, packageRecord: ConsumerLockPackage, consumerProjectDigest: Sha256Digest, toolVersion: string, mode: "install" | "sync"): ConsumerBrandLock {
  const existing = lock?.packages.find((entry) => entry.packageId === packageRecord.packageId);
  if (mode === "install" && existing !== undefined) throw new Error(`Consumer package '${packageRecord.packageId}' is already installed.`);
  if (mode === "sync" && existing === undefined) throw new Error(`Consumer package '${packageRecord.packageId}' is not installed.`);
  const packages = [...(lock?.packages.filter((entry) => entry.packageId !== packageRecord.packageId) ?? []), packageRecord];
  if (packages.length > CONSUMER_LOCK_MAX_PACKAGES) throw new Error("Consumer package limit exceeded.");
  return createConsumerBrandLock({ schema: CONSUMER_LOCK_SCHEMA, schemaVersion: 1, consumerProjectDigest, packages, toolVersion });
}
