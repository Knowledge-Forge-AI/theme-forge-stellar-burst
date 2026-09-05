import { parse as parseToml, TomlError } from "smol-toml";

import { fail, fromCaught, ok, type DiagnosticContext } from "../diagnostics.js";
import { compareUtf8 } from "../provenance.js";
import type { Result } from "../types.js";
import {
  BRAND_BUILTIN_ROLES,
  BRAND_SCHEMA_ID,
  BRAND_SCHEMA_VERSION,
  BRAND_TOML_MAX_BYTES,
} from "./brand-files.js";

export const BRAND_MAX_FAMILIES = 32;
export const BRAND_MAX_ROLES = 64;
export const BRAND_MAX_VARIANTS = 256;
export const BRAND_MAX_BINDINGS = 1024;
export const BRAND_MAX_BINDINGS_PER_ASSET = 8;
export const BRAND_MAX_REQUIREMENTS = 256;
export const BRAND_MIN_DISPLAY_ORDER = 0;
export const BRAND_MAX_DISPLAY_ORDER = 65535;
export const BRAND_MIN_DIMENSION_PX = 1;
export const BRAND_MAX_DIMENSION_PX = 16384;
export const BRAND_MAX_REFERENCED_ASSETS = 128;
export const BRAND_MAX_HUMAN_NAME_BYTES = 256;

export const BRAND_BACKGROUNDS = ["any", "light", "dark", "transparent"] as const;
export type BrandBackground = (typeof BRAND_BACKGROUNDS)[number];

export const BRAND_COLOR_MODES = ["full-color", "monochrome", "reversed"] as const;
export type BrandColorMode = (typeof BRAND_COLOR_MODES)[number];

export const BRAND_SCALES = ["standard", "simplified"] as const;
export type BrandScale = (typeof BRAND_SCALES)[number];

export const BRAND_VARIANT_STATUSES = ["primary", "secondary"] as const;
export type BrandVariantStatus = (typeof BRAND_VARIANT_STATUSES)[number];

export const BRAND_AUTHORITIES = ["source", "derived"] as const;
export type BrandAuthority = (typeof BRAND_AUTHORITIES)[number];

export interface BrandEnabledDomains {
  readonly tokens: boolean;
  readonly recipes: boolean;
  readonly qa: boolean;
  readonly consumerProfiles: boolean;
  readonly package: boolean;
  readonly exports: boolean;
}

export interface BrandFamily {
  readonly id: string;
  readonly name: string;
  readonly requiredRoles: readonly string[];
  readonly optionalRoles: readonly string[];
}

export interface BrandVariant {
  readonly family: string;
  readonly id: string;
  readonly backgrounds: readonly BrandBackground[];
  readonly colorMode: BrandColorMode;
  readonly scale: BrandScale;
  readonly status: BrandVariantStatus;
  readonly minimumWidthPx?: number;
  readonly minimumHeightPx?: number;
  readonly displayOrder?: number;
}

export interface BrandRequirement {
  readonly family: string;
  readonly role: string;
  readonly background?: BrandBackground;
  readonly colorMode?: BrandColorMode;
  readonly scale?: BrandScale;
}

export interface BrandBinding {
  readonly family: string;
  readonly role: string;
  readonly variant: string;
  readonly asset: string;
  readonly authority: BrandAuthority;
}

export interface BrandModel {
  readonly schema: typeof BRAND_SCHEMA_ID;
  readonly schemaVersion: typeof BRAND_SCHEMA_VERSION;
  readonly enabledDomains: BrandEnabledDomains;
  readonly families: readonly BrandFamily[];
  readonly variants: readonly BrandVariant[];
  readonly requirements?: readonly BrandRequirement[];
  readonly bindings: readonly BrandBinding[];
}

type UnknownRecord = Record<string, unknown>;

const IDENTIFIER_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const EXTENSION_ROLE_REGEX = /^x\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

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

export function isValidBrandRole(role: string): boolean {
  if ((BRAND_BUILTIN_ROLES as readonly string[]).includes(role)) return true;
  if (Buffer.byteLength(role, "utf8") > 129) return false;
  return EXTENSION_ROLE_REGEX.test(role);
}

function validateRole(value: unknown, ctx: DiagnosticContext, location: string): string {
  const str = asString(value, ctx, location);
  if (!isValidBrandRole(str)) {
    fail(
      ctx,
      "SCHEMA_INVALID_ROLE",
      "Role '" + str + "' must be a built-in role or valid extension role 'x.<namespace>.<name>' (at most 129 bytes).",
      location,
    );
  }
  return str;
}

function validateHumanName(value: unknown, ctx: DiagnosticContext, location: string): string {
  const str = asString(value, ctx, location);
  const bytes = Buffer.byteLength(str, "utf8");
  if (bytes < 1 || bytes > BRAND_MAX_HUMAN_NAME_BYTES || /[\x00-\x1F\x7F]/.test(str)) {
    fail(
      ctx,
      "SCHEMA_INVALID_TEXT",
      "Human name must be 1.." + BRAND_MAX_HUMAN_NAME_BYTES + " UTF-8 bytes without control characters.",
      location,
    );
  }
  return str;
}

export function parseBrandToml(source: string, sourceName = ".tfsb/brand.toml"): Result<BrandModel> {
  const ctx = context(sourceName);
  try {
    const byteLength = Buffer.byteLength(source, "utf8");
    if (byteLength > BRAND_TOML_MAX_BYTES) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "brand.toml size " + byteLength + " bytes exceeds limit " + BRAND_TOML_MAX_BYTES + " bytes.",
        sourceName,
      );
    }

    if (source.startsWith("\uFEFF")) {
      fail(ctx, "SCHEMA_INVALID_BOM", "UTF-8 BOM is forbidden in brand.toml.");
    }

    let parsed: unknown;
    try {
      parsed = parseToml(source);
    } catch (error) {
      if (error instanceof TomlError) {
        const msg = error.message.toLowerCase();
        const code = msg.includes("duplicate") || msg.includes("already defined") || msg.includes("redefine")
          ? "SCHEMA_DUPLICATE_KEY"
          : "SCHEMA_INVALID_SYNTAX";
        fail(ctx, code, "TOML parse error: " + error.message);
      }
      fail(ctx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand.toml.");
    }

    const root = asRecord(parsed, ctx, "");
    expectKeys(
      root,
      ["schema", "schema_version", "enabled_domains", "families", "variants", "requirements", "bindings"],
      ctx,
      "",
    );

    const schema = asString(root.schema, ctx, "schema");
    if (schema !== BRAND_SCHEMA_ID) {
      fail(ctx, "SCHEMA_INVALID_ID", "Expected schema '" + BRAND_SCHEMA_ID + "', got '" + schema + "'.", "schema");
    }

    const schemaVersion = asInteger(root.schema_version, ctx, "schema_version");
    if (schemaVersion !== BRAND_SCHEMA_VERSION) {
      fail(
        ctx,
        "SCHEMA_INVALID_VERSION",
        "Expected schema_version " + BRAND_SCHEMA_VERSION + ", got " + schemaVersion + ".",
        "schema_version",
      );
    }

    // enabled_domains
    const domainsRecord = asRecord(root.enabled_domains, ctx, "enabled_domains");
    expectKeys(domainsRecord, ["tokens", "recipes", "qa", "consumer_profiles", "package", "exports"], ctx, "enabled_domains");
    const enabledDomains: BrandEnabledDomains = Object.freeze({
      tokens: asBoolean(domainsRecord.tokens, ctx, "enabled_domains.tokens"),
      recipes: asBoolean(domainsRecord.recipes, ctx, "enabled_domains.recipes"),
      qa: asBoolean(domainsRecord.qa, ctx, "enabled_domains.qa"),
      consumerProfiles: asBoolean(domainsRecord.consumer_profiles, ctx, "enabled_domains.consumer_profiles"),
      package: asBoolean(domainsRecord.package, ctx, "enabled_domains.package"),
      exports: asBoolean(domainsRecord.exports, ctx, "enabled_domains.exports"),
    });

    const distinctRoles = new Set<string>();
    const referencedAssets = new Set<string>();
    const assetBindingCounts = new Map<string, number>();

    // families
    const familiesRaw = asArray(root.families, ctx, "families");
    if (familiesRaw.length === 0) {
      fail(ctx, "SCHEMA_INVALID_RANGE", "At least one family is required.", "families");
    }
    if (familiesRaw.length > BRAND_MAX_FAMILIES) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Families count " + familiesRaw.length + " exceeds limit " + BRAND_MAX_FAMILIES + ".",
        "families",
      );
    }

    const familyIds = new Set<string>();
    const familyMap = new Map<string, { requiredRoles: Set<string>; optionalRoles: Set<string> }>();
    const families: BrandFamily[] = [];

    for (let i = 0; i < familiesRaw.length; i++) {
      const loc = "families[" + i + "]";
      const rec = asRecord(familiesRaw[i], ctx, loc);
      expectKeys(rec, ["id", "name", "required_roles", "optional_roles"], ctx, loc);
      const id = validateIdentifier(rec.id, ctx, loc + ".id");
      if (familyIds.has(id)) {
        fail(ctx, "BRAND_DUPLICATE_FAMILY", "Family id '" + id + "' is duplicated.", loc + ".id");
      }
      familyIds.add(id);
      const name = validateHumanName(rec.name, ctx, loc + ".name");

      const reqRolesRaw = asArray(rec.required_roles, ctx, loc + ".required_roles");
      const seenReq = new Set<string>();
      const reqRoles: string[] = [];
      for (let r = 0; r < reqRolesRaw.length; r++) {
        const rLoc = loc + ".required_roles[" + r + "]";
        const role = validateRole(reqRolesRaw[r], ctx, rLoc);
        if (seenReq.has(role)) {
          fail(ctx, "SCHEMA_DUPLICATE_KEY", "Role '" + role + "' is duplicated in required_roles.", rLoc);
        }
        seenReq.add(role);
        distinctRoles.add(role);
        reqRoles.push(role);
      }

      const optRolesRaw = asArray(rec.optional_roles, ctx, loc + ".optional_roles");
      const seenOpt = new Set<string>();
      const optRoles: string[] = [];
      for (let o = 0; o < optRolesRaw.length; o++) {
        const oLoc = loc + ".optional_roles[" + o + "]";
        const role = validateRole(optRolesRaw[o], ctx, oLoc);
        if (seenOpt.has(role)) {
          fail(ctx, "SCHEMA_DUPLICATE_KEY", "Role '" + role + "' is duplicated in optional_roles.", oLoc);
        }
        if (seenReq.has(role)) {
          fail(
            ctx,
            "BRAND_ROLE_CONFLICT",
            "Role '" + role + "' cannot be declared both required and optional in family '" + id + "'.",
            oLoc,
          );
        }
        seenOpt.add(role);
        distinctRoles.add(role);
        optRoles.push(role);
      }

      familyMap.set(id, { requiredRoles: seenReq, optionalRoles: seenOpt });
      reqRoles.sort(compareUtf8);
      optRoles.sort(compareUtf8);
      families.push(Object.freeze({ id, name, requiredRoles: Object.freeze(reqRoles), optionalRoles: Object.freeze(optRoles) }));
    }

    // variants
    const variantsRaw = asArray(root.variants, ctx, "variants");
    if (variantsRaw.length === 0) {
      fail(ctx, "SCHEMA_INVALID_RANGE", "At least one variant is required.", "variants");
    }
    if (variantsRaw.length > BRAND_MAX_VARIANTS) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Variants count " + variantsRaw.length + " exceeds limit " + BRAND_MAX_VARIANTS + ".",
        "variants",
      );
    }

    const variantKeys = new Set<string>(); // `${family}:${id}`
    const variants: BrandVariant[] = [];

    for (let i = 0; i < variantsRaw.length; i++) {
      const loc = "variants[" + i + "]";
      const rec = asRecord(variantsRaw[i], ctx, loc);
      expectKeys(
        rec,
        [
          "family",
          "id",
          "backgrounds",
          "color_mode",
          "scale",
          "status",
          "minimum_width_px",
          "minimum_height_px",
          "display_order",
        ],
        ctx,
        loc,
      );

      const family = validateIdentifier(rec.family, ctx, loc + ".family");
      if (!familyIds.has(family)) {
        fail(ctx, "BRAND_UNKNOWN_FAMILY", "Variant references undeclared family '" + family + "'.", loc + ".family");
      }

      const id = validateIdentifier(rec.id, ctx, loc + ".id");
      const vKey = family + ":" + id;
      if (variantKeys.has(vKey)) {
        fail(
          ctx,
          "BRAND_DUPLICATE_VARIANT",
          "Variant id '" + id + "' is duplicated in family '" + family + "'.",
          loc + ".id",
        );
      }
      variantKeys.add(vKey);

      const bgRaw = asArray(rec.backgrounds, ctx, loc + ".backgrounds");
      if (bgRaw.length === 0) {
        fail(ctx, "SCHEMA_INVALID_RANGE", "Variant must declare at least one background.", loc + ".backgrounds");
      }
      const seenBg = new Set<BrandBackground>();
      const backgrounds: BrandBackground[] = [];
      for (let b = 0; b < bgRaw.length; b++) {
        const bgStr = asString(bgRaw[b], ctx, loc + ".backgrounds[" + b + "]");
        if (!(BRAND_BACKGROUNDS as readonly string[]).includes(bgStr)) {
          fail(
            ctx,
            "SCHEMA_INVALID_ENUM",
            "Background '" + bgStr + "' is invalid; expected one of " + BRAND_BACKGROUNDS.join(", ") + ".",
            loc + ".backgrounds[" + b + "]",
          );
        }
        const bg = bgStr as BrandBackground;
        if (seenBg.has(bg)) {
          fail(ctx, "SCHEMA_DUPLICATE_KEY", "Background '" + bg + "' is duplicated in variant.", loc + ".backgrounds[" + b + "]");
        }
        seenBg.add(bg);
        backgrounds.push(bg);
      }
      if (seenBg.has("any") && backgrounds.length > 1) {
        fail(
          ctx,
          "BRAND_BACKGROUND_CONFLICT",
          "Background 'any' cannot coexist with other background declarations in a variant.",
          loc + ".backgrounds",
        );
      }
      backgrounds.sort(compareUtf8);

      const colorModeStr = asString(rec.color_mode, ctx, loc + ".color_mode");
      if (!(BRAND_COLOR_MODES as readonly string[]).includes(colorModeStr)) {
        fail(
          ctx,
          "SCHEMA_INVALID_ENUM",
          "color_mode '" + colorModeStr + "' is invalid; expected one of " + BRAND_COLOR_MODES.join(", ") + ".",
          loc + ".color_mode",
        );
      }
      const colorMode = colorModeStr as BrandColorMode;

      const scaleStr = asString(rec.scale, ctx, loc + ".scale");
      if (!(BRAND_SCALES as readonly string[]).includes(scaleStr)) {
        fail(
          ctx,
          "SCHEMA_INVALID_ENUM",
          "scale '" + scaleStr + "' is invalid; expected one of " + BRAND_SCALES.join(", ") + ".",
          loc + ".scale",
        );
      }
      const scale = scaleStr as BrandScale;

      const statusStr = asString(rec.status, ctx, loc + ".status");
      if (!(BRAND_VARIANT_STATUSES as readonly string[]).includes(statusStr)) {
        fail(
          ctx,
          "SCHEMA_INVALID_ENUM",
          "status '" + statusStr + "' is invalid; expected one of " + BRAND_VARIANT_STATUSES.join(", ") + ".",
          loc + ".status",
        );
      }
      const status = statusStr as BrandVariantStatus;

      const minimumWidthPx =
        rec.minimum_width_px === undefined
          ? undefined
          : asInteger(rec.minimum_width_px, ctx, loc + ".minimum_width_px", BRAND_MIN_DIMENSION_PX, BRAND_MAX_DIMENSION_PX);
      const minimumHeightPx =
        rec.minimum_height_px === undefined
          ? undefined
          : asInteger(rec.minimum_height_px, ctx, loc + ".minimum_height_px", BRAND_MIN_DIMENSION_PX, BRAND_MAX_DIMENSION_PX);
      const displayOrder =
        rec.display_order === undefined
          ? undefined
          : asInteger(rec.display_order, ctx, loc + ".display_order", BRAND_MIN_DISPLAY_ORDER, BRAND_MAX_DISPLAY_ORDER);

      variants.push(
        Object.freeze({
          family,
          id,
          backgrounds: Object.freeze(backgrounds),
          colorMode,
          scale,
          status,
          ...(minimumWidthPx === undefined ? {} : { minimumWidthPx }),
          ...(minimumHeightPx === undefined ? {} : { minimumHeightPx }),
          ...(displayOrder === undefined ? {} : { displayOrder }),
        }),
      );
    }

    // requirements (optional)
    let totalRequirementsCount = 0;
    for (const fam of families) {
      totalRequirementsCount += fam.requiredRoles.length;
    }

    let requirements: BrandRequirement[] | undefined;
    if (root.requirements !== undefined) {
      const reqRaw = asArray(root.requirements, ctx, "requirements");
      totalRequirementsCount += reqRaw.length;
      if (totalRequirementsCount > BRAND_MAX_REQUIREMENTS) {
        fail(
          ctx,
          "RESOURCE_LIMIT_EXCEEDED",
          "Total required predicates count " + totalRequirementsCount + " exceeds limit " + BRAND_MAX_REQUIREMENTS + ".",
          "requirements",
        );
      }
      if (reqRaw.length > 0) {
        requirements = [];
        const seenReqTuples = new Set<string>();
        for (let i = 0; i < reqRaw.length; i++) {
          const loc = "requirements[" + i + "]";
          const rec = asRecord(reqRaw[i], ctx, loc);
          expectKeys(rec, ["family", "role", "background", "color_mode", "scale"], ctx, loc);

          const family = validateIdentifier(rec.family, ctx, loc + ".family");
          if (!familyIds.has(family)) {
            fail(ctx, "BRAND_UNKNOWN_FAMILY", "Requirement references undeclared family '" + family + "'.", loc + ".family");
          }
          const role = validateRole(rec.role, ctx, loc + ".role");
          const famEntry = familyMap.get(family);
          if (famEntry?.optionalRoles.has(role)) {
            fail(
              ctx,
              "BRAND_ROLE_CONFLICT",
              "Role '" + role + "' cannot be declared both required and optional in family '" + family + "'.",
              loc + ".role",
            );
          }
          distinctRoles.add(role);

          let background: BrandBackground | undefined;
          if (rec.background !== undefined) {
            const bgStr = asString(rec.background, ctx, loc + ".background");
            if (!(BRAND_BACKGROUNDS as readonly string[]).includes(bgStr)) {
              fail(ctx, "SCHEMA_INVALID_ENUM", "Invalid requirement background '" + bgStr + "'.", loc + ".background");
            }
            background = bgStr as BrandBackground;
          }

          let colorMode: BrandColorMode | undefined;
          if (rec.color_mode !== undefined) {
            const cmStr = asString(rec.color_mode, ctx, loc + ".color_mode");
            if (!(BRAND_COLOR_MODES as readonly string[]).includes(cmStr)) {
              fail(ctx, "SCHEMA_INVALID_ENUM", "Invalid requirement color_mode '" + cmStr + "'.", loc + ".color_mode");
            }
            colorMode = cmStr as BrandColorMode;
          }

          let scale: BrandScale | undefined;
          if (rec.scale !== undefined) {
            const scStr = asString(rec.scale, ctx, loc + ".scale");
            if (!(BRAND_SCALES as readonly string[]).includes(scStr)) {
              fail(ctx, "SCHEMA_INVALID_ENUM", "Invalid requirement scale '" + scStr + "'.", loc + ".scale");
            }
            scale = scStr as BrandScale;
          }

          const tupleKey = family + ":" + role + ":" + (background ?? "") + ":" + (colorMode ?? "") + ":" + (scale ?? "");
          if (seenReqTuples.has(tupleKey)) {
            fail(ctx, "BRAND_DUPLICATE_REQUIREMENT", "Duplicate requirement predicate in requirements.", loc);
          }
          seenReqTuples.add(tupleKey);

          requirements.push(
            Object.freeze({
              family,
              role,
              ...(background === undefined ? {} : { background }),
              ...(colorMode === undefined ? {} : { colorMode }),
              ...(scale === undefined ? {} : { scale }),
            }),
          );
        }
      }
    } else {
      if (totalRequirementsCount > BRAND_MAX_REQUIREMENTS) {
        fail(
          ctx,
          "RESOURCE_LIMIT_EXCEEDED",
          "Total required predicates count " + totalRequirementsCount + " exceeds limit " + BRAND_MAX_REQUIREMENTS + ".",
          "families",
        );
      }
    }

    // bindings
    const bindingsRaw = asArray(root.bindings, ctx, "bindings");
    if (bindingsRaw.length === 0) {
      fail(ctx, "SCHEMA_INVALID_RANGE", "At least one binding is required.", "bindings");
    }
    if (bindingsRaw.length > BRAND_MAX_BINDINGS) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Bindings count " + bindingsRaw.length + " exceeds limit " + BRAND_MAX_BINDINGS + ".",
        "bindings",
      );
    }

    const seenBindingTriples = new Set<string>(); // `${family}:${role}:${variant}`
    const bindings: BrandBinding[] = [];

    for (let i = 0; i < bindingsRaw.length; i++) {
      const loc = "bindings[" + i + "]";
      const rec = asRecord(bindingsRaw[i], ctx, loc);
      expectKeys(rec, ["family", "role", "variant", "asset", "authority"], ctx, loc);

      const family = validateIdentifier(rec.family, ctx, loc + ".family");
      if (!familyIds.has(family)) {
        fail(ctx, "BRAND_UNKNOWN_FAMILY", "Binding references undeclared family '" + family + "'.", loc + ".family");
      }

      const role = validateRole(rec.role, ctx, loc + ".role");
      distinctRoles.add(role);

      const variant = validateIdentifier(rec.variant, ctx, loc + ".variant");
      const vKey = family + ":" + variant;
      if (!variantKeys.has(vKey)) {
        fail(
          ctx,
          "BRAND_UNKNOWN_VARIANT",
          "Binding references unknown variant '" + variant + "' in family '" + family + "'.",
          loc + ".variant",
        );
      }

      const asset = validateIdentifier(rec.asset, ctx, loc + ".asset");
      referencedAssets.add(asset);
      const currentAssetBindings = (assetBindingCounts.get(asset) ?? 0) + 1;
      if (currentAssetBindings > BRAND_MAX_BINDINGS_PER_ASSET) {
        fail(
          ctx,
          "RESOURCE_LIMIT_EXCEEDED",
          "Asset '" + asset + "' exceeds maximum " + BRAND_MAX_BINDINGS_PER_ASSET + " bindings.",
          loc + ".asset",
        );
      }
      assetBindingCounts.set(asset, currentAssetBindings);

      const authStr = asString(rec.authority, ctx, loc + ".authority");
      if (!(BRAND_AUTHORITIES as readonly string[]).includes(authStr)) {
        fail(
          ctx,
          "SCHEMA_INVALID_ENUM",
          "authority '" + authStr + "' is invalid; expected one of " + BRAND_AUTHORITIES.join(", ") + ".",
          loc + ".authority",
        );
      }
      const authority = authStr as BrandAuthority;

      const tripleKey = family + ":" + role + ":" + variant;
      if (seenBindingTriples.has(tripleKey)) {
        fail(
          ctx,
          "BRAND_DUPLICATE_BINDING",
          "Binding for family '" + family + "', role '" + role + "', variant '" + variant + "' is duplicated.",
          loc,
        );
      }
      seenBindingTriples.add(tripleKey);

      bindings.push(Object.freeze({ family, role, variant, asset, authority }));
    }

    if (distinctRoles.size > BRAND_MAX_ROLES) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Distinct roles count " + distinctRoles.size + " exceeds limit " + BRAND_MAX_ROLES + ".",
        "brand",
      );
    }
    if (referencedAssets.size > BRAND_MAX_REFERENCED_ASSETS) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Referenced assets count " + referencedAssets.size + " exceeds limit " + BRAND_MAX_REFERENCED_ASSETS + ".",
        "brand",
      );
    }

    // Sort arrays canonically
    families.sort((a, b) => compareUtf8(a.id, b.id));
    variants.sort((a, b) => compareUtf8(a.family, b.family) || compareUtf8(a.id, b.id));
    if (requirements !== undefined) {
      requirements.sort(
        (a, b) =>
          compareUtf8(a.family, b.family) ||
          compareUtf8(a.role, b.role) ||
          compareUtf8(a.background ?? "", b.background ?? "") ||
          compareUtf8(a.colorMode ?? "", b.colorMode ?? "") ||
          compareUtf8(a.scale ?? "", b.scale ?? ""),
      );
    }
    bindings.sort((a, b) => compareUtf8(a.family, b.family) || compareUtf8(a.role, b.role) || compareUtf8(a.variant, b.variant));

    const model: BrandModel = Object.freeze({
      schema: BRAND_SCHEMA_ID,
      schemaVersion: BRAND_SCHEMA_VERSION,
      enabledDomains,
      families: Object.freeze(families),
      variants: Object.freeze(variants),
      ...(requirements !== undefined && requirements.length > 0 ? { requirements: Object.freeze(requirements) } : {}),
      bindings: Object.freeze(bindings),
    });

    return ok(model);
  } catch (error) {
    return fromCaught(error, ctx, "SCHEMA_INVALID_SYNTAX", "Failed to validate brand.toml.");
  }
}

export function serializeBrandToml(model: BrandModel): string {
  const lines: string[] = [
    `schema = "${model.schema}"`,
    `schema_version = ${model.schemaVersion}`,
    `enabled_domains = { tokens = ${model.enabledDomains.tokens}, recipes = ${model.enabledDomains.recipes}, qa = ${model.enabledDomains.qa}, consumer_profiles = ${model.enabledDomains.consumerProfiles}, package = ${model.enabledDomains.package}, exports = ${model.enabledDomains.exports} }`,
    "",
  ];

  const sortedFamilies = [...model.families].sort((a, b) => compareUtf8(a.id, b.id));
  for (const family of sortedFamilies) {
    lines.push("[[families]]");
    lines.push(`id = "${family.id}"`);
    lines.push(`name = ${JSON.stringify(family.name)}`);
    const req = [...family.requiredRoles].sort(compareUtf8).map((r) => JSON.stringify(r)).join(", ");
    lines.push(`required_roles = [${req}]`);
    const opt = [...family.optionalRoles].sort(compareUtf8).map((r) => JSON.stringify(r)).join(", ");
    lines.push(`optional_roles = [${opt}]`);
    lines.push("");
  }

  const sortedVariants = [...model.variants].sort((a, b) => compareUtf8(a.family, b.family) || compareUtf8(a.id, b.id));
  for (const variant of sortedVariants) {
    lines.push("[[variants]]");
    lines.push(`family = "${variant.family}"`);
    lines.push(`id = "${variant.id}"`);
    const bg = [...variant.backgrounds].sort(compareUtf8).map((b) => JSON.stringify(b)).join(", ");
    lines.push(`backgrounds = [${bg}]`);
    lines.push(`color_mode = "${variant.colorMode}"`);
    lines.push(`scale = "${variant.scale}"`);
    lines.push(`status = "${variant.status}"`);
    if (variant.minimumWidthPx !== undefined) lines.push(`minimum_width_px = ${variant.minimumWidthPx}`);
    if (variant.minimumHeightPx !== undefined) lines.push(`minimum_height_px = ${variant.minimumHeightPx}`);
    if (variant.displayOrder !== undefined) lines.push(`display_order = ${variant.displayOrder}`);
    lines.push("");
  }

  if (model.requirements !== undefined && model.requirements.length > 0) {
    const sortedRequirements = [...model.requirements].sort(
      (a, b) =>
        compareUtf8(a.family, b.family) ||
        compareUtf8(a.role, b.role) ||
        compareUtf8(a.background ?? "", b.background ?? "") ||
        compareUtf8(a.colorMode ?? "", b.colorMode ?? "") ||
        compareUtf8(a.scale ?? "", b.scale ?? ""),
    );
    for (const req of sortedRequirements) {
      lines.push("[[requirements]]");
      lines.push(`family = "${req.family}"`);
      lines.push(`role = "${req.role}"`);
      if (req.background !== undefined) lines.push(`background = "${req.background}"`);
      if (req.colorMode !== undefined) lines.push(`color_mode = "${req.colorMode}"`);
      if (req.scale !== undefined) lines.push(`scale = "${req.scale}"`);
      lines.push("");
    }
  }

  const sortedBindings = [...model.bindings].sort(
    (a, b) => compareUtf8(a.family, b.family) || compareUtf8(a.role, b.role) || compareUtf8(a.variant, b.variant),
  );
  for (const binding of sortedBindings) {
    lines.push("[[bindings]]");
    lines.push(`family = "${binding.family}"`);
    lines.push(`role = "${binding.role}"`);
    lines.push(`variant = "${binding.variant}"`);
    lines.push(`asset = "${binding.asset}"`);
    lines.push(`authority = "${binding.authority}"`);
    lines.push("");
  }

  return lines.join("\n");
}
