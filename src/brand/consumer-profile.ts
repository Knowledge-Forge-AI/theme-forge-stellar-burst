import { parse as parseToml, TomlError } from "smol-toml";

import { fail, fromCaught, ok, type DiagnosticContext } from "../diagnostics.js";
import { computeSha256, type Sha256Digest } from "../digests.js";
import { compareUtf8 } from "../provenance.js";
import type { Result } from "../types.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import { isValidBrandRole } from "./brand-schema.js";

export const CONSUMER_PROFILES_SCHEMA_ID = "tfsb.consumer-profiles" as const;
export const CONSUMER_PROFILES_SCHEMA_VERSION = 1 as const;
export const CONSUMER_PROFILES_MAX_BYTES = 1_048_576;
export const CONSUMER_PROFILES_MAX_PROFILES = 32;
export const CONSUMER_PROFILE_MAX_PARAMETERS = 16;
export const CONSUMER_PROFILE_MAX_PARAMETER_VALUES = 16;
export const CONSUMER_PROFILE_MAX_COMPOSES = 4;
export const CONSUMER_PROFILE_MAX_RULES = 256;
export const CONSUMER_PROFILES_DIGEST_BASIS = "tfsb.consumer-profiles-v1\n" as const;
export const CONSUMER_PROFILE_DIGEST_BASIS = "tfsb-consumer-profile-v1\n" as const;

export type ConsumerProfileRequirement = "required" | "optional";
export type ConsumerProfileFilenamePolicy = "asset-id.svg" | "source-basename";

export interface ConsumerProfileParameter {
  readonly id: string;
  readonly values: readonly string[];
}

export interface ConsumerProfileCondition {
  readonly parameter: string;
  readonly equals: string;
}

export interface ConsumerProfileOutputRule {
  readonly asset?: string;
  readonly companion?: string;
  readonly family?: string;
  readonly role?: string;
  readonly variant?: string;
  readonly destination?: string;
  readonly destinationDirectory?: string;
  readonly filenamePolicy?: ConsumerProfileFilenamePolicy;
  readonly requirement: ConsumerProfileRequirement;
  readonly collision: "error";
  readonly when: readonly ConsumerProfileCondition[];
}

export interface ConsumerProfile {
  readonly id: string;
  readonly qualifiedId: string;
  readonly version: number;
  readonly compatiblePackage: string;
  readonly minimumBrandVersion?: string;
  readonly maximumBrandVersionExclusive?: string;
  readonly composes: readonly string[];
  readonly parameters: readonly ConsumerProfileParameter[];
  readonly outputs: readonly ConsumerProfileOutputRule[];
}

export interface ConsumerProfilesModel {
  readonly schema: typeof CONSUMER_PROFILES_SCHEMA_ID;
  readonly schemaVersion: typeof CONSUMER_PROFILES_SCHEMA_VERSION;
  readonly profiles: readonly ConsumerProfile[];
}

type UnknownRecord = Record<string, unknown>;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const QUALIFIED_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function context(source?: string): DiagnosticContext {
  return { operation: "parse", domain: "brand", ...(source === undefined ? {} : { source }) };
}

function record(value: unknown, ctx: DiagnosticContext, location: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a TOML table.", location);
  return value as UnknownRecord;
}

function array(value: unknown, ctx: DiagnosticContext, location: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a TOML array.", location);
  return value;
}

function string(value: unknown, ctx: DiagnosticContext, location: string): string {
  if (typeof value !== "string") fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a string.", location);
  return value;
}

function integer(value: unknown, ctx: DiagnosticContext, location: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a safe integer.", location);
  if (value < min || value > max) fail(ctx, "SCHEMA_INVALID_RANGE", `Expected an integer from ${min} through ${max}.`, location);
  return value;
}

function keys(value: UnknownRecord, allowed: readonly string[], ctx: DiagnosticContext, location: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(ctx, "SCHEMA_UNKNOWN_KEY", `Unknown key '${key}'.`, location === "" ? key : `${location}.${key}`);
}

function identifier(value: unknown, ctx: DiagnosticContext, location: string): string {
  const text = string(value, ctx, location);
  if (Buffer.byteLength(text, "utf8") > 64 || !ID.test(text)) fail(ctx, "SCHEMA_INVALID_IDENTIFIER", "Expected a 1..64 byte lowercase kebab identifier.", location);
  return text;
}

function qualifiedIdentifier(value: unknown, ctx: DiagnosticContext, location: string): string {
  const text = string(value, ctx, location);
  if (Buffer.byteLength(text, "utf8") > 129 || !QUALIFIED_ID.test(text)) fail(ctx, "SCHEMA_INVALID_IDENTIFIER", "Expected '<package-id>/<profile-id>'.", location);
  return text;
}

function semver(value: unknown, ctx: DiagnosticContext, location: string): string {
  const text = string(value, ctx, location);
  if (Buffer.byteLength(text, "utf8") > 128 || !SEMVER.test(text)) fail(ctx, "SCHEMA_INVALID_SEMVER", "Expected a strict SemVer value.", location);
  return text;
}

function compareSemver(left: string, right: string): number {
  const a = SEMVER.exec(left)!;
  const b = SEMVER.exec(right)!;
  const numeric = (first: string, second: string): number => first.length !== second.length ? first.length - second.length : first < second ? -1 : first > second ? 1 : 0;
  for (let i = 1; i <= 3; i++) {
    const delta = numeric(a[i]!, b[i]!);
    if (delta !== 0) return delta;
  }
  const ap = a[4], bp = b[4];
  if (ap === undefined) return bp === undefined ? 0 : 1;
  if (bp === undefined) return -1;
  const aa = ap.split("."), bb = bp.split(".");
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const av = aa[i], bv = bb[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av), bn = /^\d+$/.test(bv);
    if (an && bn) return numeric(av, bv);
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

export function validateConsumerDestination(value: unknown, location = "destination"): string {
  const ctx = context();
  const text = string(value, ctx, location);
  if (text !== text.normalize("NFC") || text.length === 0 || Buffer.byteLength(text, "utf8") > 4096 || text.includes("\\") || text.includes("\0") || /[\x00-\x1f\x7f<>:"|?*${}]/.test(text) || text.startsWith("~") || text.startsWith("/") || text.startsWith("//") || /^[A-Za-z]:/.test(text)) {
    fail(ctx, "CONSUMER_DESTINATION_INVALID", "Destination must be a bounded NFC consumer-relative path using '/'.", location);
  }
  const parts = text.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > 255 || part.endsWith(" ") || part.endsWith(".") || WINDOWS_RESERVED.test(part)) {
      fail(ctx, "CONSUMER_DESTINATION_INVALID", "Destination contains an unsafe or nonportable component.", location);
    }
  }
  return text;
}

export function isProtectedConsumerDestination(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === ".git" || lower.startsWith(".git/") || lower === ".tfsb" || lower.startsWith(".tfsb/") || lower === ".tfsb-preview" || lower.startsWith(".tfsb-preview/") ||
    lower === "node_modules" || lower.startsWith("node_modules/") ||
    lower === ".tfsb.lock" || lower.startsWith(".tfsb-consumer-transaction-") ||
    /(?:^|\/)\.tfsb-(?:stage|backup)-/.test(lower) || /(?:^|\/)\..+\.tfsb-consumer-(?:stage|backup)-/.test(lower);
}

function canonicalRule(rule: ConsumerProfileOutputRule): string { return encodeCanonicalJson(rule); }

function parseProfile(value: unknown, ctx: DiagnosticContext, index: number): ConsumerProfile {
  const loc = `profiles[${index}]`;
  const rec = record(value, ctx, loc);
  keys(rec, ["id", "version", "compatible_package", "minimum_brand_version", "maximum_brand_version_exclusive", "composes", "parameters", "outputs"], ctx, loc);
  const id = identifier(rec.id, ctx, `${loc}.id`);
  const compatiblePackage = identifier(rec.compatible_package, ctx, `${loc}.compatible_package`);
  const version = integer(rec.version, ctx, `${loc}.version`, 1, 65_535);
  const minimumBrandVersion = rec.minimum_brand_version === undefined ? undefined : semver(rec.minimum_brand_version, ctx, `${loc}.minimum_brand_version`);
  const maximumBrandVersionExclusive = rec.maximum_brand_version_exclusive === undefined ? undefined : semver(rec.maximum_brand_version_exclusive, ctx, `${loc}.maximum_brand_version_exclusive`);
  if (minimumBrandVersion !== undefined && maximumBrandVersionExclusive !== undefined && compareSemver(maximumBrandVersionExclusive, minimumBrandVersion) <= 0) {
    fail(ctx, "CONSUMER_PROFILE_INVALID_VERSION_RANGE", "maximum_brand_version_exclusive must be greater than minimum_brand_version.", loc);
  }

  const composesRaw = rec.composes === undefined ? [] : array(rec.composes, ctx, `${loc}.composes`);
  if (composesRaw.length > CONSUMER_PROFILE_MAX_COMPOSES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "A profile may directly compose at most four profiles.", `${loc}.composes`);
  const composes = composesRaw.map((entry, i) => qualifiedIdentifier(entry, ctx, `${loc}.composes[${i}]`)).sort(compareUtf8);
  if (new Set(composes).size !== composes.length) fail(ctx, "SCHEMA_DUPLICATE_KEY", "Composed profile identities must be unique.", `${loc}.composes`);

  const parametersRaw = rec.parameters === undefined ? [] : array(rec.parameters, ctx, `${loc}.parameters`);
  if (parametersRaw.length > CONSUMER_PROFILE_MAX_PARAMETERS) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "A profile may declare at most 16 parameters.", `${loc}.parameters`);
  const parameters: ConsumerProfileParameter[] = [];
  const parameterValues = new Map<string, ReadonlySet<string>>();
  for (let i = 0; i < parametersRaw.length; i++) {
    const ploc = `${loc}.parameters[${i}]`, prec = record(parametersRaw[i], ctx, ploc);
    keys(prec, ["id", "values"], ctx, ploc);
    const parameterId = identifier(prec.id, ctx, `${ploc}.id`);
    if (parameterValues.has(parameterId)) fail(ctx, "SCHEMA_DUPLICATE_KEY", `Duplicate parameter '${parameterId}'.`, `${ploc}.id`);
    const rawValues = array(prec.values, ctx, `${ploc}.values`);
    if (rawValues.length < 1 || rawValues.length > CONSUMER_PROFILE_MAX_PARAMETER_VALUES) fail(ctx, "SCHEMA_INVALID_RANGE", "Parameter values must contain 1..16 entries.", `${ploc}.values`);
    const values = rawValues.map((entry, vi) => {
      const item = string(entry, ctx, `${ploc}.values[${vi}]`);
      if (Buffer.byteLength(item, "utf8") > 64 || !VALUE.test(item)) fail(ctx, "SCHEMA_INVALID_IDENTIFIER", "Parameter values must be bounded identifier literals.", `${ploc}.values[${vi}]`);
      return item;
    }).sort(compareUtf8);
    if (new Set(values).size !== values.length) fail(ctx, "SCHEMA_DUPLICATE_KEY", `Parameter '${parameterId}' contains duplicate values.`, `${ploc}.values`);
    parameterValues.set(parameterId, new Set(values));
    parameters.push(Object.freeze({ id: parameterId, values: Object.freeze(values) }));
  }
  parameters.sort((a, b) => compareUtf8(a.id, b.id));

  const outputsRaw = array(rec.outputs, ctx, `${loc}.outputs`);
  if (outputsRaw.length < 1 || outputsRaw.length > CONSUMER_PROFILE_MAX_RULES) fail(ctx, "SCHEMA_INVALID_RANGE", "Profile outputs must contain 1..256 rules.", `${loc}.outputs`);
  const outputs: ConsumerProfileOutputRule[] = [];
  for (let i = 0; i < outputsRaw.length; i++) {
    const oloc = `${loc}.outputs[${i}]`, out = record(outputsRaw[i], ctx, oloc);
    keys(out, ["asset", "companion", "family", "role", "variant", "destination", "destination_directory", "filename_policy", "requirement", "collision", "when"], ctx, oloc);
    const hasAsset = out.asset !== undefined, hasCompanion = out.companion !== undefined;
    const tripleCount = Number(out.family !== undefined) + Number(out.role !== undefined) + Number(out.variant !== undefined);
    if (Number(hasAsset) + Number(hasCompanion) + Number(tripleCount > 0) !== 1 || (tripleCount !== 0 && tripleCount !== 3)) fail(ctx, "CONSUMER_PROFILE_INVALID_SELECTOR", "Each output must select exactly asset, companion, or family+role+variant.", oloc);
    const asset = hasAsset ? identifier(out.asset, ctx, `${oloc}.asset`) : undefined;
    const companion = hasCompanion ? identifier(out.companion, ctx, `${oloc}.companion`) : undefined;
    const family = tripleCount === 3 ? identifier(out.family, ctx, `${oloc}.family`) : undefined;
    const role = tripleCount === 3 ? string(out.role, ctx, `${oloc}.role`) : undefined;
    if (role !== undefined && !isValidBrandRole(role)) fail(ctx, "SCHEMA_INVALID_ROLE", `Invalid brand role '${role}'.`, `${oloc}.role`);
    const variant = tripleCount === 3 ? identifier(out.variant, ctx, `${oloc}.variant`) : undefined;
    const hasDestination = out.destination !== undefined;
    const hasDirectory = out.destination_directory !== undefined || out.filename_policy !== undefined;
    if (Number(hasDestination) + Number(hasDirectory) !== 1 || (hasDirectory && (out.destination_directory === undefined || out.filename_policy === undefined))) fail(ctx, "CONSUMER_PROFILE_INVALID_DESTINATION", "Use exactly destination or destination_directory plus filename_policy.", oloc);
    const destination = hasDestination ? validateConsumerDestination(out.destination, `${oloc}.destination`) : undefined;
    const destinationDirectory = hasDirectory ? validateConsumerDestination(out.destination_directory, `${oloc}.destination_directory`) : undefined;
    const policyText = hasDirectory ? string(out.filename_policy, ctx, `${oloc}.filename_policy`) : undefined;
    if (policyText !== undefined && policyText !== "asset-id.svg" && policyText !== "source-basename") fail(ctx, "SCHEMA_INVALID_ENUM", "filename_policy must be 'asset-id.svg' or 'source-basename'.", `${oloc}.filename_policy`);
    if (policyText === "asset-id.svg" && companion !== undefined) fail(ctx, "CONSUMER_PROFILE_INVALID_FILENAME_POLICY", "asset-id.svg is invalid for companion selectors.", `${oloc}.filename_policy`);
    if ((destination !== undefined && isProtectedConsumerDestination(destination)) || (destinationDirectory !== undefined && isProtectedConsumerDestination(destinationDirectory))) fail(ctx, "CONSUMER_DESTINATION_PROTECTED", "Profile output targets a protected consumer path.", oloc);
    const requirement = string(out.requirement, ctx, `${oloc}.requirement`);
    if (requirement !== "required" && requirement !== "optional") fail(ctx, "SCHEMA_INVALID_ENUM", "requirement must be required or optional.", `${oloc}.requirement`);
    if (string(out.collision, ctx, `${oloc}.collision`) !== "error") fail(ctx, "SCHEMA_INVALID_ENUM", "collision must be error in schema 1.", `${oloc}.collision`);
    const whenRaw = out.when === undefined ? [] : array(out.when, ctx, `${oloc}.when`);
    const when: ConsumerProfileCondition[] = [];
    const conditioned = new Set<string>();
    for (let wi = 0; wi < whenRaw.length; wi++) {
      const wloc = `${oloc}.when[${wi}]`, w = record(whenRaw[wi], ctx, wloc);
      keys(w, ["parameter", "equals"], ctx, wloc);
      const parameter = identifier(w.parameter, ctx, `${wloc}.parameter`);
      const equals = string(w.equals, ctx, `${wloc}.equals`);
      const allowed = parameterValues.get(parameter);
      if (allowed === undefined) fail(ctx, "CONSUMER_PROFILE_UNKNOWN_PARAMETER", `Condition references undeclared parameter '${parameter}'.`, `${wloc}.parameter`);
      if (!allowed.has(equals)) fail(ctx, "CONSUMER_PROFILE_DISALLOWED_PARAMETER", `Condition value '${equals}' is not allowed for '${parameter}'.`, `${wloc}.equals`);
      if (conditioned.has(parameter)) fail(ctx, "SCHEMA_DUPLICATE_KEY", `Condition repeats parameter '${parameter}'.`, wloc);
      conditioned.add(parameter);
      when.push(Object.freeze({ parameter, equals }));
    }
    when.sort((a, b) => compareUtf8(a.parameter, b.parameter));
    outputs.push(Object.freeze({ ...(asset === undefined ? {} : { asset }), ...(companion === undefined ? {} : { companion }), ...(family === undefined ? {} : { family, role: role!, variant: variant! }), ...(destination === undefined ? {} : { destination }), ...(destinationDirectory === undefined ? {} : { destinationDirectory, filenamePolicy: policyText as ConsumerProfileFilenamePolicy }), requirement, collision: "error", when: Object.freeze(when) }));
  }
  outputs.sort((a, b) => compareUtf8(canonicalRule(a), canonicalRule(b)));
  const ruleKeys = outputs.map(canonicalRule);
  if (new Set(ruleKeys).size !== ruleKeys.length) fail(ctx, "SCHEMA_DUPLICATE_KEY", "Profile contains duplicate output rules.", `${loc}.outputs`);
  return Object.freeze({ id, qualifiedId: `${compatiblePackage}/${id}`, version, compatiblePackage, ...(minimumBrandVersion === undefined ? {} : { minimumBrandVersion }), ...(maximumBrandVersionExclusive === undefined ? {} : { maximumBrandVersionExclusive }), composes: Object.freeze(composes), parameters: Object.freeze(parameters), outputs: Object.freeze(outputs) });
}

export function parseConsumerProfilesToml(source: string, sourceName = ".tfsb/consumer-profiles.toml"): Result<ConsumerProfilesModel> {
  const ctx = context(sourceName);
  try {
    const bytes = Buffer.byteLength(source, "utf8");
    if (bytes > CONSUMER_PROFILES_MAX_BYTES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `consumer-profiles.toml exceeds ${CONSUMER_PROFILES_MAX_BYTES} bytes.`, sourceName);
    if (source.startsWith("\uFEFF")) fail(ctx, "SCHEMA_INVALID_BOM", "UTF-8 BOM is forbidden.", sourceName);
    let parsed: unknown;
    try { parsed = parseToml(source); }
    catch (error) {
      if (error instanceof TomlError) fail(ctx, /duplicate|already defined|redefine/i.test(error.message) ? "SCHEMA_DUPLICATE_KEY" : "SCHEMA_INVALID_SYNTAX", `TOML parse error: ${error.message}`);
      throw error;
    }
    const root = record(parsed, ctx, "");
    keys(root, ["schema", "schema_version", "profiles"], ctx, "");
    if (string(root.schema, ctx, "schema") !== CONSUMER_PROFILES_SCHEMA_ID) fail(ctx, "SCHEMA_INVALID_ID", `Expected schema '${CONSUMER_PROFILES_SCHEMA_ID}'.`, "schema");
    if (integer(root.schema_version, ctx, "schema_version", 1, 1) !== 1) fail(ctx, "SCHEMA_INVALID_VERSION", "Unsupported consumer profile schema version.", "schema_version");
    const rawProfiles = array(root.profiles, ctx, "profiles");
    if (rawProfiles.length < 1 || rawProfiles.length > CONSUMER_PROFILES_MAX_PROFILES) fail(ctx, "SCHEMA_INVALID_RANGE", "consumer-profiles.toml must contain 1..32 profiles.", "profiles");
    const profiles = rawProfiles.map((entry, i) => parseProfile(entry, ctx, i)).sort((a, b) => compareUtf8(a.qualifiedId, b.qualifiedId));
    if (new Set(profiles.map((profile) => profile.qualifiedId)).size !== profiles.length) fail(ctx, "CONSUMER_PROFILE_DUPLICATE_IDENTITY", "Qualified profile identities must be unique.", "profiles");
    return ok(Object.freeze({ schema: CONSUMER_PROFILES_SCHEMA_ID, schemaVersion: CONSUMER_PROFILES_SCHEMA_VERSION, profiles: Object.freeze(profiles) }));
  } catch (error) {
    return fromCaught(error, ctx, "SCHEMA_INVALID_SYNTAX", "Failed to validate consumer-profiles.toml.", (caught) => caught instanceof TomlError);
  }
}

function q(value: string): string { return JSON.stringify(value).replace(/\u007f/g, "\\u007F"); }

export function serializeConsumerProfilesToml(model: ConsumerProfilesModel): string {
  const lines = [`schema = ${q(CONSUMER_PROFILES_SCHEMA_ID)}`, "schema_version = 1"];
  for (const profile of [...model.profiles].sort((a, b) => compareUtf8(a.qualifiedId, b.qualifiedId))) {
    lines.push("", "[[profiles]]", `id = ${q(profile.id)}`, `version = ${profile.version}`, `compatible_package = ${q(profile.compatiblePackage)}`);
    if (profile.minimumBrandVersion !== undefined) lines.push(`minimum_brand_version = ${q(profile.minimumBrandVersion)}`);
    if (profile.maximumBrandVersionExclusive !== undefined) lines.push(`maximum_brand_version_exclusive = ${q(profile.maximumBrandVersionExclusive)}`);
    if (profile.composes.length > 0) lines.push(`composes = [${profile.composes.map(q).join(", ")}]`);
    for (const parameter of profile.parameters) lines.push("", "[[profiles.parameters]]", `id = ${q(parameter.id)}`, `values = [${parameter.values.map(q).join(", ")}]`);
    for (const output of profile.outputs) {
      lines.push("", "[[profiles.outputs]]");
      if (output.asset !== undefined) lines.push(`asset = ${q(output.asset)}`);
      else if (output.companion !== undefined) lines.push(`companion = ${q(output.companion)}`);
      else lines.push(`family = ${q(output.family!)}`, `role = ${q(output.role!)}`, `variant = ${q(output.variant!)}`);
      if (output.destination !== undefined) lines.push(`destination = ${q(output.destination)}`);
      else lines.push(`destination_directory = ${q(output.destinationDirectory!)}`, `filename_policy = ${q(output.filenamePolicy!)}`);
      lines.push(`requirement = ${q(output.requirement)}`, 'collision = "error"');
      for (const condition of output.when) lines.push("", "[[profiles.outputs.when]]", `parameter = ${q(condition.parameter)}`, `equals = ${q(condition.equals)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function computeConsumerProfilesDomainDigest(model: ConsumerProfilesModel): Sha256Digest {
  return computeSha256(Buffer.from(CONSUMER_PROFILES_DIGEST_BASIS + encodeCanonicalJson(model), "utf8"));
}

export function computeConsumerProfileDigest(profile: ConsumerProfile): Sha256Digest {
  return computeSha256(Buffer.from(CONSUMER_PROFILE_DIGEST_BASIS + encodeCanonicalJson(profile), "utf8"));
}

export function isBrandVersionCompatible(profile: ConsumerProfile, version: string): boolean {
  if (!SEMVER.test(version)) return false;
  return (profile.minimumBrandVersion === undefined || compareSemver(version, profile.minimumBrandVersion) >= 0) &&
    (profile.maximumBrandVersionExclusive === undefined || compareSemver(version, profile.maximumBrandVersionExclusive) < 0);
}
