import { parse as parseToml, TomlError } from "smol-toml";

import { fail, fromCaught, ok, type DiagnosticContext } from "./diagnostics.js";
import { parseAssetTomlV2, parseProjectTomlV2, serializeAssetTomlV2, serializeProjectTomlV2 } from "./schema2-toml.js";
import type { NormalizedAssetV2, NormalizedProjectV2 } from "./schema2-types.js";
import { parseAssetToml, parseProjectToml } from "./toml.js";
import { serializeAssetToml, serializeProjectToml } from "./toml-writer.js";
import type { NormalizedAsset, NormalizedProject, Result } from "./types.js";

export type SupportedSchemaVersion = 1 | 2;
export type AnyNormalizedProject = NormalizedProject | NormalizedProjectV2;
export type AnyNormalizedAsset = NormalizedAsset | NormalizedAssetV2;

function context(domain: "project-toml" | "asset-toml", source?: string): DiagnosticContext {
  return { operation: "parse", domain, ...(source === undefined ? {} : { source }) };
}

export function readDeclaredSchemaVersion(text: string, domain: "project-toml" | "asset-toml", source?: string): Result<SupportedSchemaVersion> {
  const ctx = context(domain, source);
  try {
    const root = parseToml(text.replace(/^\uFEFF/, ""));
    if (typeof root !== "object" || root === null || Array.isArray(root) || !("schema_version" in root)) {
      fail(ctx, "SCHEMA_MISSING_KEY", "Missing required key 'schema_version'.", "schema_version");
    }
    const version = (root as Record<string, unknown>).schema_version;
    if (version !== 1 && version !== 2) {
      fail(ctx, "SCHEMA_UNSUPPORTED_VERSION", "Supported schema versions are integer 1 and 2.", "schema_version");
    }
    return ok(version);
  } catch (error) {
    return fromCaught(error, ctx, "TOML_SYNTAX", "Invalid TOML syntax.", (caught) => caught instanceof TomlError);
  }
}

export function parseProjectTomlVersioned(text: string, source?: string): Result<AnyNormalizedProject> {
  const version = readDeclaredSchemaVersion(text, "project-toml", source);
  if (!version.ok) return version;
  return version.value === 1 ? parseProjectToml(text, source) : parseProjectTomlV2(text, source);
}

export function parseAssetTomlVersioned(text: string, expectedVersion: SupportedSchemaVersion, source?: string): Result<AnyNormalizedAsset> {
  const version = readDeclaredSchemaVersion(text, "asset-toml", source);
  if (!version.ok) return version;
  if (version.value !== expectedVersion) {
    const ctx = context("asset-toml", source);
    try { fail(ctx, "SCHEMA_PROJECT_VERSION_MISMATCH", `Project schema ${expectedVersion} cannot contain schema ${version.value} assets.`, "schema_version"); }
    catch (error) { return fromCaught(error, ctx, "SCHEMA_PROJECT_VERSION_MISMATCH", "Project and asset schema versions differ."); }
  }
  return expectedVersion === 1 ? parseAssetToml(text, source) : parseAssetTomlV2(text, source);
}

export function serializeProjectTomlVersioned(project: AnyNormalizedProject): string {
  return project.schemaVersion === 1 ? serializeProjectToml(project) : serializeProjectTomlV2(project);
}

export function serializeAssetTomlVersioned(asset: AnyNormalizedAsset): string {
  return asset.schemaVersion === 1 ? serializeAssetToml(asset) : serializeAssetTomlV2(asset);
}
