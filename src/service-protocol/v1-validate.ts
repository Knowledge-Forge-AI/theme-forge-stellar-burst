import { isAbsolute } from "node:path";
import { computeSha256 } from "../digests.js";
import { decodeStrictPng } from "../brand/raster-capability.js";
import { canonicalJson } from "./canonical-json.js";

import type {
  AssetDiffParams, AssetEditPlanParams, AssetGetParams, AssetListParams, AssetValidateParams,
  BuildPlanOutputSummary, CancelRequestParams,
  InitializeParamsV1_1, JsonRpcId, PlanApplyParams, PlanDiscardParams, PreviewPlanParams,
  ProjectBuildPlanParams, ProjectFmtPlanParams, ProjectImportPlanParams, ProjectInstallPlanParams,
  ProjectListParams, ProjectMigratePlanParams, ProjectOpenParams, ProjectReconcilePlanParams,
  ProjectHandle, ReconcileRemoval, ReconcileRename, ReconcileResolution,
  SessionParams, Sha256Digest, SourceAnalyzeParams, SourceHandle, SourceMapAuthority, SourceOpenParamsV1_1,
  BrandConsumerPlanParams, BrandConsumerProfileListParams, BrandConsumerSourcesParams, BrandDerivePlanParams,
  BrandDiffParams, BrandExportPlanParams, BrandPageParams, BrandProjectParams, BrandQaBaselinePlanParams, BrandQaProfileParams,
  BrandVisualEvidenceParams, BrandVisualTarget,
  StudioInboundMessage, StudioPlanMethod, StudioProgressStage, WorkspaceHandle, WorkspaceOpenParams,
  WorkspaceStatusParams,
} from "./v1-types.js";
import {
  QUALIFICATION_ID, SUPPORTED_CLIENT_NOTIFICATION_METHODS, SUPPORTED_REQUEST_METHODS_1_2,
  type SupportedClientNotificationMethod, type SupportedRequestMethod,
} from "./v1-registry.js";

export class ValidationError extends Error {
  constructor(readonly symbolicCode: "INVALID_REQUEST" | "INVALID_PARAMS" | "INVALID_REQUEST_ID", message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

type PlainObject = { [key: string]: unknown };
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_ASSET_SELECTIONS = 128;
const MAX_COMPANION_SELECTIONS = 1_024;
const MAX_COLLECTIONS = 128;
const MAX_DIRECTIVES = 1_024;
const MAX_RELATIVE_BYTES = 1_024;
const MAX_COMPONENT_BYTES = 255;
const PLAN_METHODS: readonly StudioPlanMethod[] = [
  "asset.edit.plan", "project.import.plan", "project.reconcile.plan", "project.migrate.plan",
  "project.fmt.plan", "project.build.plan", "project.install.plan", "preview.plan",
  "brand.derive.plan", "brand.qa.baseline.plan", "brand.consumer.install.plan",
  "brand.consumer.sync.plan", "brand.export.plan",
];
const VISUAL_EVIDENCE_DIGEST_BASIS = "tfsb.studio-visual-evidence-v1";

function object(value: unknown, message: string): PlainObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ValidationError("INVALID_PARAMS", message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ValidationError("INVALID_PARAMS", message);
  return value as PlainObject;
}

function exact(value: PlainObject, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ValidationError("INVALID_PARAMS", "Parameters must use the closed method shape.");
  }
}

function visualTarget(raw: unknown): BrandVisualTarget {
  const value = object(raw, "visual target must be an object.");
  if (value.kind === "asset") { exact(value, ["kind", "assetId"]); return { kind: "asset", assetId: id(value.assetId, "assetId") }; }
  if (value.kind === "binding") { exact(value, ["kind", "family", "role", "variant"]); return { kind: "binding", family: id(value.family, "family"), role: string(value.role, "role", 128), variant: id(value.variant, "variant") }; }
  throw new ValidationError("INVALID_PARAMS", "visual target kind is invalid.");
}

function string(value: unknown, name: string, max = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
    throw new ValidationError("INVALID_PARAMS", `${name} is invalid.`);
  }
  return value;
}

function utf8String(value: unknown, name: string, maxBytes: number, maxCharacters = maxBytes): string {
  const parsed = string(value, name, maxCharacters);
  if (Buffer.byteLength(parsed, "utf8") > maxBytes) throw new ValidationError("INVALID_PARAMS", `${name} is invalid.`);
  return parsed;
}

function id(value: unknown, name: string): string {
  const parsed = string(value, name, 256);
  if (!ID.test(parsed)) throw new ValidationError("INVALID_PARAMS", `${name} is invalid.`);
  return parsed;
}

function handle(value: unknown, name: string, kind: "workspace" | "project" | "source"): string {
  const parsed = string(value, name, 128);
  // Handles are opaque session-local values.  Cross-kind and session binding
  // belongs to HandleRegistry, so malformed-but-bounded values reach the
  // runtime as ROOT_HANDLE_INVALID rather than becoming INVALID_PARAMS here.
  void kind;
  return parsed;
}

function digest(value: unknown, name: string): Sha256Digest {
  const parsed = string(value, name, 71);
  if (!DIGEST.test(parsed)) throw new ValidationError("INVALID_PARAMS", `${name} is invalid.`);
  return parsed as Sha256Digest;
}

function token(value: unknown, name: string): string {
  const parsed = string(value, name, 43);
  if (!TOKEN.test(parsed)) throw new ValidationError("INVALID_PARAMS", `${name} is invalid.`);
  return parsed;
}

function relative(value: unknown, name: string, maxBytes = MAX_RELATIVE_BYTES): string {
  const parsed = string(value, name, maxBytes);
  if (
    parsed !== parsed.normalize("NFC") || parsed.includes("\\") || parsed.startsWith("/") ||
    parsed.startsWith("//") || /^[A-Za-z]:/.test(parsed) || /[\u0000-\u001f\u007f]/u.test(parsed) ||
    Buffer.byteLength(parsed, "utf8") > maxBytes
  ) throw new ValidationError("INVALID_PARAMS", `${name} must be a normalized relative identity.`);
  for (const component of parsed.split("/")) {
    if (
      component === "" || component === "." || component === ".." || /^ |[. ]$/u.test(component) ||
      Buffer.byteLength(component, "utf8") > MAX_COMPONENT_BYTES
    ) throw new ValidationError("INVALID_PARAMS", `${name} must be a normalized relative identity.`);
  }
  return parsed;
}

function pageSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 128) throw new ValidationError("INVALID_PARAMS", "pageSize must be an integer from 1 through 128.");
  return value as number;
}

function nonNegativeInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) throw new ValidationError("INVALID_PARAMS", `${name} must be a bounded non-negative integer.`);
  return value as number;
}

function array(value: unknown, name: string, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new ValidationError("INVALID_PARAMS", `${name} is invalid.`);
  return value;
}

function uniqueStrings(value: unknown, name: string, max: number, parse: (value: unknown, name: string) => string): readonly string[] {
  const values = array(value, name, max).map((item, index) => parse(item, `${name}[${index}]`));
  if (new Set(values).size !== values.length) throw new ValidationError("INVALID_PARAMS", `${name} must not contain duplicates.`);
  return values;
}

function authorityKey(value: unknown, name: string): string {
  const parsed = string(value, name, MAX_RELATIVE_BYTES);
  if (parsed.startsWith("asset:")) return `asset:${id(parsed.slice("asset:".length), `${name}.assetId`)}`;
  if (parsed.startsWith("companion:")) return `companion:${relative(parsed.slice("companion:".length), `${name}.path`)}`;
  return relative(parsed, name);
}

function sourceMapAuthority(raw: unknown): SourceMapAuthority {
  const value = object(raw, "sourceMapAuthority must be an object.");
  if (value.kind === "source-contained") {
    exact(value, ["kind"]);
    return { kind: "source-contained" };
  }
  if (value.kind === "handle") {
    exact(value, ["kind", "sourceMapHandle"]);
    return { kind: "handle", sourceMapHandle: handle(value.sourceMapHandle, "sourceMapHandle", "source") as SourceHandle };
  }
  throw new ValidationError("INVALID_PARAMS", "sourceMapAuthority kind is invalid.");
}

function session(raw: unknown): SessionParams {
  const value = object(raw, "Session parameters must be an object.");
  exact(value, ["sessionNonce"]);
  return { sessionNonce: string(value.sessionNonce, "sessionNonce", 128) };
}

function openParams(raw: unknown, kind: "workspace" | "project" | "source"): WorkspaceOpenParams | ProjectOpenParams | SourceOpenParamsV1_1 {
  const value = object(raw, "Open parameters must be an object.");
  const optional = kind === "project" ? ["mode"] : kind === "source" ? ["purpose"] : [];
  exact(value, ["sessionNonce", "path"], optional);
  const path = string(value.path, "path", 16_384);
  if (!isAbsolute(path)) throw new ValidationError("INVALID_PARAMS", `${kind}.open requires an absolute path.`);
  const nonce = string(value.sessionNonce, "sessionNonce", 128);
  if (kind === "project") {
    if (value.mode !== undefined && value.mode !== "existing" && value.mode !== "import-target") throw new ValidationError("INVALID_PARAMS", "project.open mode is invalid.");
    return { sessionNonce: nonce, path, ...(value.mode === undefined ? {} : { mode: value.mode }) } as ProjectOpenParams;
  }
  if (kind === "source") {
    if (value.purpose !== undefined && value.purpose !== "content" && value.purpose !== "source-map" && value.purpose !== "normalization-map" && value.purpose !== "shard-manifest" && value.purpose !== "brand-bundle" && value.purpose !== "npm-installed-package") throw new ValidationError("INVALID_PARAMS", "source.open purpose is invalid.");
    return { sessionNonce: nonce, path, ...(value.purpose === undefined ? {} : { purpose: value.purpose }) } as SourceOpenParamsV1_1;
  }
  return { sessionNonce: nonce, path };
}

function initialize(raw: unknown): InitializeParamsV1_1 {
  const value = object(raw, "Initialize parameters must be an object.");
  exact(value, ["protocol", "minVersion", "maxVersion", "client", "capabilities"]);
  const client = object(value.client, "client must be an object.");
  exact(client, ["name", "version"]);
  const capabilities = object(value.capabilities, "capabilities must be an object.");
  exact(capabilities, ["progress", "cancellation"]);
  if (value.protocol !== "tfsb.studio" || typeof capabilities.progress !== "boolean" || typeof capabilities.cancellation !== "boolean") throw new ValidationError("INVALID_PARAMS", "Initialize negotiation fields are invalid.");
  const minVersion = string(value.minVersion, "minVersion", 16);
  const maxVersion = string(value.maxVersion, "maxVersion", 16);
  return {
    protocol: "tfsb.studio", minVersion: minVersion as InitializeParamsV1_1["minVersion"], maxVersion: maxVersion as InitializeParamsV1_1["maxVersion"],
    client: { name: string(client.name, "client.name", 128), version: string(client.version, "client.version", 64) },
    capabilities: { progress: capabilities.progress, cancellation: capabilities.cancellation },
  };
}

function parsePlanAssetEdit(raw: unknown): AssetEditPlanParams {
  const value = object(raw, "asset.edit.plan parameters must be an object.");
  exact(value, ["sessionNonce", "projectHandle", "assetId", "proposedToml"]);
  return {
    sessionNonce: string(value.sessionNonce, "sessionNonce", 128),
    projectHandle: handle(value.projectHandle, "projectHandle", "project") as ProjectHandle,
    assetId: id(value.assetId, "assetId"),
    proposedToml: utf8String(value.proposedToml, "proposedToml", 8 * 1024 * 1024),
  };
}

function parseImport(raw: unknown): ProjectImportPlanParams {
  const value = object(raw, "project.import.plan parameters must be an object.");
  exact(value, ["sessionNonce", "projectHandle", "sourceHandle", "schemaVersion"], ["archiveMode", "selections", "companions", "collections", "normalization", "normalizationMapHandle", "sourceMapAuthority", "shardManifestHandle"]);
  if (value.schemaVersion !== 2) throw new ValidationError("INVALID_PARAMS", "schemaVersion must be 2.");
  if (value.archiveMode !== undefined && value.archiveMode !== "ordinary" && value.archiveMode !== "manifest") throw new ValidationError("INVALID_PARAMS", "archiveMode is invalid.");
  if (value.normalization !== undefined && value.normalization !== "none" && value.normalization !== "exact-common") throw new ValidationError("INVALID_PARAMS", "normalization is invalid.");
  const normalizationMapHandle = value.normalizationMapHandle === undefined ? undefined : handle(value.normalizationMapHandle, "normalizationMapHandle", "source") as SourceHandle;
  if (normalizationMapHandle !== undefined && value.normalization !== "exact-common") throw new ValidationError("INVALID_PARAMS", "normalizationMapHandle requires exact-common normalization.");
  if (value.shardManifestHandle !== undefined && value.selections !== undefined && Array.isArray(value.selections) && value.selections.length > 0) {
    throw new ValidationError("INVALID_PARAMS", "shardManifestHandle is mutually exclusive with asset selections.");
  }
  return {
    sessionNonce: string(value.sessionNonce, "sessionNonce", 128),
    projectHandle: handle(value.projectHandle, "projectHandle", "project") as ProjectHandle,
    sourceHandle: handle(value.sourceHandle, "sourceHandle", "source") as SourceHandle,
    schemaVersion: 2,
    ...(value.archiveMode === undefined ? {} : { archiveMode: value.archiveMode }),
    ...(value.selections === undefined ? {} : { selections: uniqueStrings(value.selections, "selections", MAX_ASSET_SELECTIONS, relative) }),
    ...(value.companions === undefined ? {} : { companions: uniqueStrings(value.companions, "companions", MAX_COMPANION_SELECTIONS, relative) }),
    ...(value.collections === undefined ? {} : { collections: uniqueStrings(value.collections, "collections", MAX_COLLECTIONS, id) }),
    ...(value.normalization === undefined ? {} : { normalization: value.normalization }),
    ...(normalizationMapHandle === undefined ? {} : { normalizationMapHandle }),
    ...(value.sourceMapAuthority === undefined ? {} : { sourceMapAuthority: sourceMapAuthority(value.sourceMapAuthority) }),
    ...(value.shardManifestHandle === undefined ? {} : { shardManifestHandle: handle(value.shardManifestHandle, "shardManifestHandle", "source") as SourceHandle }),
  } as ProjectImportPlanParams;
}

function parseResolution(raw: unknown, name: string): ReconcileResolution {
  const value = object(raw, `${name} must be an object.`);
  exact(value, ["key", "choice"]);
  if (value.choice !== "archive" && value.choice !== "canonical" && value.choice !== "source") throw new ValidationError("INVALID_PARAMS", `${name}.choice is invalid.`);
  return { key: authorityKey(value.key, `${name}.key`), choice: value.choice };
}

function parseRename(raw: unknown, name: string): ReconcileRename {
  const value = object(raw, `${name} must be an object.`);
  exact(value, ["from", "to"]);
  return { from: authorityKey(value.from, `${name}.from`), to: relative(value.to, `${name}.to`) };
}

function parseRemoval(raw: unknown, name: string): ReconcileRemoval {
  const value = object(raw, `${name} must be an object.`);
  exact(value, ["key"]);
  return { key: authorityKey(value.key, `${name}.key`) };
}

function parseDirectives<T>(value: unknown, name: string, parser: (value: unknown, name: string) => T): readonly T[] {
  return array(value, name, MAX_DIRECTIVES).map((item, index) => parser(item, `${name}[${index}]`));
}

function parseReconcile(raw: unknown): ProjectReconcilePlanParams {
  const value = object(raw, "project.reconcile.plan parameters must be an object.");
  exact(value, ["sessionNonce", "projectHandle", "sourceHandle"], ["selections", "companions", "collections", "resolutions", "renames", "companionRenames", "removals", "companionRemovals", "normalization", "normalizationMapHandle", "sourceMapAuthority", "shardManifestHandle", "acceptedSourceMapDigest", "acceptedSourceKindChange", "acceptedNormalizationPolicyDigest"]);
  if (value.normalization !== undefined && value.normalization !== "none" && value.normalization !== "exact-common") throw new ValidationError("INVALID_PARAMS", "normalization is invalid.");
  if (value.acceptedSourceKindChange !== undefined && value.acceptedSourceKindChange !== "archive-to-directory") throw new ValidationError("INVALID_PARAMS", "acceptedSourceKindChange is invalid.");
  const normalizationMapHandle = value.normalizationMapHandle === undefined ? undefined : handle(value.normalizationMapHandle, "normalizationMapHandle", "source") as SourceHandle;
  if (normalizationMapHandle !== undefined && value.normalization !== "exact-common") throw new ValidationError("INVALID_PARAMS", "normalizationMapHandle requires exact-common normalization.");
  return {
    sessionNonce: string(value.sessionNonce, "sessionNonce", 128),
    projectHandle: handle(value.projectHandle, "projectHandle", "project") as ProjectHandle,
    sourceHandle: handle(value.sourceHandle, "sourceHandle", "source") as SourceHandle,
    ...(value.selections === undefined ? {} : { selections: uniqueStrings(value.selections, "selections", MAX_ASSET_SELECTIONS, relative) }),
    ...(value.companions === undefined ? {} : { companions: uniqueStrings(value.companions, "companions", MAX_COMPANION_SELECTIONS, relative) }),
    ...(value.collections === undefined ? {} : { collections: uniqueStrings(value.collections, "collections", MAX_COLLECTIONS, id) }),
    ...(value.resolutions === undefined ? {} : { resolutions: parseDirectives(value.resolutions, "resolutions", parseResolution) }),
    ...(value.renames === undefined ? {} : { renames: parseDirectives(value.renames, "renames", parseRename) }),
    ...(value.companionRenames === undefined ? {} : { companionRenames: parseDirectives(value.companionRenames, "companionRenames", parseRename) }),
    ...(value.removals === undefined ? {} : { removals: parseDirectives(value.removals, "removals", parseRemoval) }),
    ...(value.companionRemovals === undefined ? {} : { companionRemovals: parseDirectives(value.companionRemovals, "companionRemovals", parseRemoval) }),
    ...(value.normalization === undefined ? {} : { normalization: value.normalization }),
    ...(normalizationMapHandle === undefined ? {} : { normalizationMapHandle }),
    ...(value.sourceMapAuthority === undefined ? {} : { sourceMapAuthority: sourceMapAuthority(value.sourceMapAuthority) }),
    ...(value.shardManifestHandle === undefined ? {} : { shardManifestHandle: handle(value.shardManifestHandle, "shardManifestHandle", "source") as SourceHandle }),
    ...(value.acceptedSourceMapDigest === undefined ? {} : { acceptedSourceMapDigest: digest(value.acceptedSourceMapDigest, "acceptedSourceMapDigest") }),
    ...(value.acceptedSourceKindChange === undefined ? {} : { acceptedSourceKindChange: value.acceptedSourceKindChange }),
    ...(value.acceptedNormalizationPolicyDigest === undefined ? {} : { acceptedNormalizationPolicyDigest: digest(value.acceptedNormalizationPolicyDigest, "acceptedNormalizationPolicyDigest") }),
  } as ProjectReconcilePlanParams;
}

function parseProjectOnly(raw: unknown, method: string): { sessionNonce: string; projectHandle: ProjectHandle } {
  const value = object(raw, `${method} parameters must be an object.`);
  exact(value, ["sessionNonce", "projectHandle"]);
  return { sessionNonce: string(value.sessionNonce, "sessionNonce", 128), projectHandle: handle(value.projectHandle, "projectHandle", "project") as ProjectHandle };
}

function sourceHandles(value: unknown, name: string, required: boolean): readonly SourceHandle[] {
  if (value === undefined && !required) return [];
  const parsed = uniqueStrings(value, name, 8, (item, itemName) => handle(item, itemName, "source"));
  if (required && parsed.length < 1) throw new ValidationError("INVALID_PARAMS", `${name} requires at least one source handle.`);
  return parsed as readonly SourceHandle[];
}

function parseBrandConsumerPlan(raw: unknown, method: "brand.consumer.install.plan" | "brand.consumer.sync.plan"): BrandConsumerPlanParams {
  const value = object(raw, `${method} parameters must be an object.`);
  exact(value, ["sessionNonce", "projectHandle", "sourceHandles"], ["profiles", "parameters"]);
  const profiles = value.profiles === undefined ? undefined : uniqueStrings(value.profiles, "profiles", 8, (item, name) => string(item, name, 512));
  if (method === "brand.consumer.install.plan" && (profiles?.length ?? 0) < 1) throw new ValidationError("INVALID_PARAMS", "Consumer install requires at least one profile.");
  let parameters: BrandConsumerPlanParams["parameters"];
  if (value.parameters !== undefined) parameters = array(value.parameters, "parameters", 8).map((item, index) => {
    const entry = object(item, `parameters[${index}] must be an object.`); exact(entry, ["profileId", "values"]);
    const values = array(entry.values, `parameters[${index}].values`, 16).map((selection, selectionIndex) => {
      const selected = object(selection, `parameters[${index}].values[${selectionIndex}] must be an object.`); exact(selected, ["parameter", "value"]);
      return { parameter: id(selected.parameter, "parameter"), value: string(selected.value, "value", 256) };
    });
    if (new Set(values.map((selected) => selected.parameter)).size !== values.length) throw new ValidationError("INVALID_PARAMS", "Consumer parameters must be unique.");
    return { profileId: string(entry.profileId, "profileId", 512), values };
  });
  if (parameters !== undefined && new Set(parameters.map((entry) => entry.profileId)).size !== parameters.length) throw new ValidationError("INVALID_PARAMS", "Consumer parameter profile IDs must be unique.");
  return { ...parseProjectOnly({ sessionNonce: value.sessionNonce, projectHandle: value.projectHandle }, method), sourceHandles: sourceHandles(value.sourceHandles, "sourceHandles", true), ...(profiles === undefined ? {} : { profiles }), ...(parameters === undefined ? {} : { parameters }) };
}

export function validateJsonRpcId(value: unknown): JsonRpcId {
  if (typeof value === "string" && value.length > 0 && value.length <= 256) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return value;
  throw new ValidationError("INVALID_REQUEST_ID", "Request IDs must be non-empty strings or safe integers.");
}

export function validateParams(method: SupportedRequestMethod | SupportedClientNotificationMethod, raw: unknown): unknown {
  if (method === "initialize") return initialize(raw);
  if (method === "initialized" || method === "shutdown") return session(raw);
  if (method === "exit") { const value = object(raw, "exit parameters must be an object."); exact(value, []); return {}; }
  if (method === "workspace.open") return openParams(raw, "workspace") as WorkspaceOpenParams;
  if (method === "project.open") return openParams(raw, "project") as ProjectOpenParams;
  if (method === "source.open") return openParams(raw, "source") as SourceOpenParamsV1_1;
  if (method === "workspace.status") {
    const value = object(raw, "workspace.status parameters must be an object."); exact(value, ["sessionNonce", "workspaceHandle", "mode"]);
    if (value.mode !== "discovery" && value.mode !== "check") throw new ValidationError("INVALID_PARAMS", "workspace.status mode is invalid.");
    return { sessionNonce: string(value.sessionNonce, "sessionNonce", 128), workspaceHandle: handle(value.workspaceHandle, "workspaceHandle", "workspace") as WorkspaceHandle, mode: value.mode } as WorkspaceStatusParams;
  }
  if (method === "project.list" || method === "preview.status") return parseProjectOnly(raw, method) as ProjectListParams | { readonly sessionNonce: string; readonly projectHandle: ProjectHandle };
  if (method === "asset.list") {
    const value = object(raw, "asset.list parameters must be an object."); exact(value, ["sessionNonce", "scope", "pageSize"], ["cursor"]);
    const scope = object(value.scope, "asset.list scope must be an object.");
    let parsedScope: AssetListParams["scope"];
    if (scope.kind === "project") { exact(scope, ["kind", "projectHandle"]); parsedScope = { kind: "project", projectHandle: handle(scope.projectHandle, "projectHandle", "project") as ProjectHandle }; }
    else if (scope.kind === "workspace") { exact(scope, ["kind", "workspaceHandle"]); parsedScope = { kind: "workspace", workspaceHandle: handle(scope.workspaceHandle, "workspaceHandle", "workspace") as WorkspaceHandle }; }
    else throw new ValidationError("INVALID_PARAMS", "asset.list scope kind is invalid.");
    return { sessionNonce: string(value.sessionNonce, "sessionNonce", 128), scope: parsedScope, pageSize: pageSize(value.pageSize), ...(value.cursor === undefined ? {} : { cursor: string(value.cursor, "cursor", 16_384) }) } as AssetListParams;
  }
  if (method === "asset.get") {
    const value = object(raw, "asset.get parameters must be an object."); exact(value, ["sessionNonce", "scope"]);
    const scope = object(value.scope, "asset.get scope must be an object."); let parsedScope: AssetGetParams["scope"];
    if (scope.kind === "project") { exact(scope, ["kind", "projectHandle", "assetId"]); parsedScope = { kind: "project", projectHandle: handle(scope.projectHandle, "projectHandle", "project") as ProjectHandle, assetId: id(scope.assetId, "assetId") }; }
    else if (scope.kind === "workspace") { exact(scope, ["kind", "workspaceHandle", "projectId", "assetId"]); parsedScope = { kind: "workspace", workspaceHandle: handle(scope.workspaceHandle, "workspaceHandle", "workspace") as WorkspaceHandle, projectId: id(scope.projectId, "projectId"), assetId: id(scope.assetId, "assetId") }; }
    else throw new ValidationError("INVALID_PARAMS", "asset.get scope kind is invalid.");
    return { sessionNonce: string(value.sessionNonce, "sessionNonce", 128), scope: parsedScope } as AssetGetParams;
  }
  if (method === "asset.validate" || method === "asset.diff") {
    const value = object(raw, `${method} parameters must be an object.`); exact(value, ["sessionNonce", "projectHandle", "assetId", "toml"]);
    return { sessionNonce: string(value.sessionNonce, "sessionNonce", 128), projectHandle: handle(value.projectHandle, "projectHandle", "project"), assetId: id(value.assetId, "assetId"), toml: utf8String(value.toml, "toml", 8 * 1024 * 1024) } as AssetValidateParams | AssetDiffParams;
  }
  if (method === "source.analyze") {
    const value = object(raw, "source.analyze parameters must be an object."); exact(value, ["sessionNonce", "sourceHandle", "includeDetails", "pageSize"], ["cursor"]);
    if (typeof value.includeDetails !== "boolean") throw new ValidationError("INVALID_PARAMS", "includeDetails must be boolean.");
    return { sessionNonce: string(value.sessionNonce, "sessionNonce", 128), sourceHandle: handle(value.sourceHandle, "sourceHandle", "source") as SourceHandle, includeDetails: value.includeDetails, pageSize: pageSize(value.pageSize), ...(value.cursor === undefined ? {} : { cursor: string(value.cursor, "cursor", 16_384) }) } as SourceAnalyzeParams;
  }
  if (method === "brand.status" || method === "brand.recipe.graph" || method === "brand.export.capability") return parseProjectOnly(raw, method) as BrandProjectParams;
  if (method === "brand.family.list" || method === "brand.token.list" || method === "brand.export.status" || method === "brand.qa.profile.list") {
    const value = object(raw, `${method} parameters must be an object.`); exact(value, ["sessionNonce", "projectHandle", "pageSize"], ["cursor"]);
    return { ...parseProjectOnly({ sessionNonce: value.sessionNonce, projectHandle: value.projectHandle }, method), pageSize: pageSize(value.pageSize), ...(value.cursor === undefined ? {} : { cursor: string(value.cursor, "cursor", 16_384) }) } as BrandPageParams;
  }
  if (method === "brand.qa.profile.get" || method === "brand.qa.result.get") {
    const value = object(raw, `${method} parameters must be an object.`); exact(value, ["sessionNonce", "projectHandle", "profileId"]);
    return { ...parseProjectOnly({ sessionNonce: value.sessionNonce, projectHandle: value.projectHandle }, method), profileId: id(value.profileId, "profileId") } as BrandQaProfileParams;
  }
  if (method === "brand.diff") {
    const value = object(raw, "brand.diff parameters must be an object."); exact(value, ["sessionNonce", "projectHandle", "sourceHandle"]);
    return { ...parseProjectOnly({ sessionNonce: value.sessionNonce, projectHandle: value.projectHandle }, method), sourceHandle: handle(value.sourceHandle, "sourceHandle", "source") as SourceHandle } as BrandDiffParams;
  }
  if (method === "brand.visual.evidence.get") {
    const value = object(raw, "brand.visual.evidence.get parameters must be an object.");
    if (value.kind === "qa-baseline") {
      exact(value, ["kind", "sessionNonce", "projectHandle", "profileId", "caseId"]);
      return { ...parseProjectOnly({ sessionNonce: value.sessionNonce, projectHandle: value.projectHandle }, method), kind: "qa-baseline", profileId: id(value.profileId, "profileId"), caseId: id(value.caseId, "caseId") } as BrandVisualEvidenceParams;
    }
    if (value.kind !== "project-render" && value.kind !== "brand-diff") throw new ValidationError("INVALID_PARAMS", "visual evidence kind is invalid.");
    exact(value, value.kind === "brand-diff" ? ["kind", "sessionNonce", "projectHandle", "sourceHandle", "target", "width", "height", "background"] : ["kind", "sessionNonce", "projectHandle", "target", "width", "height", "background"]);
    const width = nonNegativeInteger(value.width, "width", 1_024), height = nonNegativeInteger(value.height, "height", 1_024);
    if (width < 16 || height < 16 || width * height > 1_048_576) throw new ValidationError("INVALID_PARAMS", "visual evidence dimensions are invalid.");
    const background = string(value.background, "background", 256);
    if (background !== "transparent" && !/^#[0-9A-F]{8}$/u.test(background) && !/^token:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(background)) throw new ValidationError("INVALID_PARAMS", "visual evidence background is invalid.");
    const common = { ...parseProjectOnly({ sessionNonce: value.sessionNonce, projectHandle: value.projectHandle }, method), kind: value.kind, target: visualTarget(value.target), width, height, background };
    return value.kind === "brand-diff" ? { ...common, sourceHandle: handle(value.sourceHandle, "sourceHandle", "source") as SourceHandle } as BrandVisualEvidenceParams : common as BrandVisualEvidenceParams;
  }
  if (method === "brand.consumer.profile.list") {
    const value = object(raw, "brand.consumer.profile.list parameters must be an object."); exact(value, ["sessionNonce", "projectHandle", "pageSize"], ["sourceHandles", "cursor"]);
    return { ...parseProjectOnly({ sessionNonce: value.sessionNonce, projectHandle: value.projectHandle }, method), sourceHandles: sourceHandles(value.sourceHandles, "sourceHandles", false), pageSize: pageSize(value.pageSize), ...(value.cursor === undefined ? {} : { cursor: string(value.cursor, "cursor", 16_384) }) } as BrandConsumerProfileListParams;
  }
  if (method === "brand.consumer.lock.status") {
    const value = object(raw, "brand.consumer.lock.status parameters must be an object."); exact(value, ["sessionNonce", "projectHandle"], ["sourceHandles"]);
    return { ...parseProjectOnly({ sessionNonce: value.sessionNonce, projectHandle: value.projectHandle }, method), sourceHandles: sourceHandles(value.sourceHandles, "sourceHandles", false) } as BrandConsumerSourcesParams;
  }
  if (method === "brand.derive.plan") {
    const value = object(raw, "brand.derive.plan parameters must be an object."); exact(value, ["sessionNonce", "projectHandle", "selection"]);
    const selection = object(value.selection, "selection must be an object.");
    let parsed: BrandDerivePlanParams["selection"];
    if (selection.kind === "all") { exact(selection, ["kind"]); parsed = { kind: "all" }; }
    else if (selection.kind === "recipes") { exact(selection, ["kind", "recipeIds"]); const recipeIds = uniqueStrings(selection.recipeIds, "recipeIds", 128, id); if (recipeIds.length < 1) throw new ValidationError("INVALID_PARAMS", "recipeIds must not be empty."); parsed = { kind: "recipes", recipeIds }; }
    else throw new ValidationError("INVALID_PARAMS", "selection kind is invalid.");
    return { ...parseProjectOnly({ sessionNonce: value.sessionNonce, projectHandle: value.projectHandle }, method), selection: parsed } as BrandDerivePlanParams;
  }
  if (method === "brand.qa.baseline.plan") {
    const value = object(raw, "brand.qa.baseline.plan parameters must be an object."); exact(value, ["sessionNonce", "projectHandle", "profileId", "caseId"]);
    return { ...parseProjectOnly({ sessionNonce: value.sessionNonce, projectHandle: value.projectHandle }, method), profileId: id(value.profileId, "profileId"), caseId: id(value.caseId, "caseId") } as BrandQaBaselinePlanParams;
  }
  if (method === "brand.consumer.install.plan" || method === "brand.consumer.sync.plan") return parseBrandConsumerPlan(raw, method);
  if (method === "brand.export.plan") {
    const value = object(raw, "brand.export.plan parameters must be an object."); exact(value, ["sessionNonce", "projectHandle", "profileId"], ["outputIds"]);
    const outputIds = value.outputIds === undefined ? undefined : uniqueStrings(value.outputIds, "outputIds", 128, id);
    if (outputIds !== undefined && outputIds.length < 1) throw new ValidationError("INVALID_PARAMS", "outputIds must not be empty.");
    return { ...parseProjectOnly({ sessionNonce: value.sessionNonce, projectHandle: value.projectHandle }, method), profileId: id(value.profileId, "profileId"), ...(outputIds === undefined ? {} : { outputIds }) } as BrandExportPlanParams;
  }
  if (method === "$/cancelRequest") {
    const value = object(raw, "Cancellation parameters must be an object."); exact(value, ["sessionNonce", "id"]);
    return { sessionNonce: string(value.sessionNonce, "sessionNonce", 128), id: validateJsonRpcId(value.id) } as CancelRequestParams;
  }
  if (method === "asset.edit.plan") return parsePlanAssetEdit(raw);
  if (method === "project.import.plan") return parseImport(raw);
  if (method === "project.reconcile.plan") return parseReconcile(raw);
  if (method === "project.migrate.plan") {
    const value = object(raw, "project.migrate.plan parameters must be an object."); exact(value, ["sessionNonce", "projectHandle", "targetSchemaVersion"]);
    if (value.targetSchemaVersion !== 2) throw new ValidationError("INVALID_PARAMS", "targetSchemaVersion must be 2.");
    return { ...parseProjectOnly({ sessionNonce: value.sessionNonce, projectHandle: value.projectHandle }, method), targetSchemaVersion: 2 } as ProjectMigratePlanParams;
  }
  if (method === "project.fmt.plan") return parseProjectOnly(raw, method) as ProjectFmtPlanParams;
  if (method === "project.build.plan") return parseProjectOnly(raw, method) as ProjectBuildPlanParams;
  if (method === "project.install.plan") return parseProjectOnly(raw, method) as ProjectInstallPlanParams;
  if (method === "preview.plan") {
    const value = object(raw, "preview.plan parameters must be an object."); exact(value, ["sessionNonce", "projectHandle"], ["outputDirectory"]);
    return { ...parseProjectOnly({ sessionNonce: value.sessionNonce, projectHandle: value.projectHandle }, method), ...(value.outputDirectory === undefined ? {} : { outputDirectory: relative(value.outputDirectory, "outputDirectory") }) } as PreviewPlanParams;
  }
  if (method === "plan.discard") {
    const value = object(raw, "plan.discard parameters must be an object."); exact(value, ["sessionNonce", "planToken"]);
    return { sessionNonce: string(value.sessionNonce, "sessionNonce", 128), planToken: token(value.planToken, "planToken") } as PlanDiscardParams;
  }
  if (method === "plan.apply") {
    const value = object(raw, "plan.apply parameters must be an object."); exact(value, ["sessionNonce", "planToken", "expectedPlanDigest"]);
    return { sessionNonce: string(value.sessionNonce, "sessionNonce", 128), planToken: token(value.planToken, "planToken"), expectedPlanDigest: digest(value.expectedPlanDigest, "expectedPlanDigest") } as PlanApplyParams;
  }
  throw new ValidationError("INVALID_PARAMS", "No validator exists for this method.");
}

export function validateInboundMessage(raw: unknown): StudioInboundMessage {
  const value = object(raw, "A JSON-RPC message must be an object.");
  if (value.jsonrpc !== "2.0" || typeof value.method !== "string") throw new ValidationError("INVALID_REQUEST", "The JSON-RPC envelope is invalid.");
  const isRequest = Object.hasOwn(value, "id");
  exact(value, isRequest ? ["jsonrpc", "id", "method", "params"] : ["jsonrpc", "method", "params"]);
  if (isRequest) {
    const idValue = validateJsonRpcId(value.id);
    if (!(SUPPORTED_REQUEST_METHODS_1_2 as readonly string[]).includes(value.method)) throw new ValidationError("INVALID_REQUEST", "The request method is not in the supported validator inventory.");
    const method = value.method as SupportedRequestMethod;
    return { jsonrpc: "2.0", id: idValue, method, params: validateParams(method, value.params) } as StudioInboundMessage;
  }
  if (!(SUPPORTED_CLIENT_NOTIFICATION_METHODS as readonly string[]).includes(value.method)) throw new ValidationError("INVALID_REQUEST", "The notification method is not in the supported validator inventory.");
  const method = value.method as SupportedClientNotificationMethod;
  return { jsonrpc: "2.0", method, params: validateParams(method, value.params) } as StudioInboundMessage;
}

function boundedJson(value: unknown, state = { nodes: 0 }, depth = 0): void {
  state.nodes += 1;
  if (state.nodes > 100_000 || depth > 64) throw new ValidationError("INVALID_PARAMS", "Result structure exceeds protocol bounds.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 100_000) throw new ValidationError("INVALID_PARAMS", "Result array exceeds protocol bounds.");
    for (const item of value) boundedJson(item, state, depth + 1);
    return;
  }
  const record = object(value, "Result value must be plain JSON.");
  if (Object.keys(record).length > 10_000) throw new ValidationError("INVALID_PARAMS", "Result object exceeds protocol bounds.");
  for (const child of Object.values(record)) boundedJson(child, state, depth + 1);
}

function nullableDigest(value: unknown, name: string): void {
  if (value !== null) resultDigest(value, name);
}

function validateRasterStatus(raw: unknown, name: string): void {
  const value = object(raw, `${name} is invalid.`);
  exact(value, ["available"]);
  if (typeof value.available !== "boolean") throw new ValidationError("INVALID_PARAMS", `${name}.available is invalid.`);
}

function validateBrandPage(raw: PlainObject, method: string, itemValidator: (item: unknown, name: string) => void): void {
  exact(raw, ["page", "viewDigest"]);
  const page = object(raw.page, `${method} page is invalid.`);
  exact(page, ["size", "count", "items", "nextCursor"]);
  const size = nonNegativeInteger(page.size, `${method}.page.size`, 128);
  if (size < 1) throw new ValidationError("INVALID_PARAMS", `${method}.page.size is invalid.`);
  const items = array(page.items, `${method}.page.items`, 128);
  if (page.count !== items.length || items.length > size) throw new ValidationError("INVALID_PARAMS", `${method}.page count is invalid.`);
  if (page.nextCursor !== null) string(page.nextCursor, `${method}.page.nextCursor`, 16_384);
  for (const [index, item] of items.entries()) itemValidator(item, `${method}.page.items[${index}]`);
  resultDigest(raw.viewDigest, `${method}.viewDigest`);
}

function validateBrandFamilyItem(raw: unknown, name: string): void {
  const value = object(raw, `${name} is invalid.`);
  exact(value, ["id", "name", "requiredRoles", "optionalRoles", "variants", "bindings", "requirements", "complete"]);
  id(value.id, `${name}.id`); string(value.name, `${name}.name`, 256);
  uniqueStrings(value.requiredRoles, `${name}.requiredRoles`, 64, string);
  uniqueStrings(value.optionalRoles, `${name}.optionalRoles`, 64, string);
  if (typeof value.complete !== "boolean") throw new ValidationError("INVALID_PARAMS", `${name}.complete is invalid.`);
  for (const [index, rawVariant] of array(value.variants, `${name}.variants`, 256).entries()) {
    const variant = object(rawVariant, `${name}.variants[${index}]`);
    exact(variant, ["family", "id", "backgrounds", "colorMode", "scale", "status"], ["minimumWidthPx", "minimumHeightPx", "displayOrder"]);
    id(variant.family, `${name}.variants[${index}].family`); id(variant.id, `${name}.variants[${index}].id`);
    uniqueStrings(variant.backgrounds, `${name}.variants[${index}].backgrounds`, 4, string);
    if (!["full-color", "monochrome", "reversed"].includes(String(variant.colorMode)) || !["standard", "simplified"].includes(String(variant.scale)) || !["primary", "secondary"].includes(String(variant.status))) throw new ValidationError("INVALID_PARAMS", `${name}.variants[${index}] is invalid.`);
    for (const key of ["minimumWidthPx", "minimumHeightPx", "displayOrder"] as const) if (variant[key] !== undefined) nonNegativeInteger(variant[key], `${name}.variants[${index}].${key}`, 65_535);
  }
  for (const [index, rawBinding] of array(value.bindings, `${name}.bindings`, 1_024).entries()) {
    const binding = object(rawBinding, `${name}.bindings[${index}]`); exact(binding, ["family", "role", "variant", "asset", "authority"], ["derivedState"]);
    for (const key of ["family", "role", "variant", "asset"] as const) string(binding[key], `${name}.bindings[${index}].${key}`, 256);
    if (binding.authority !== "source" && binding.authority !== "derived") throw new ValidationError("INVALID_PARAMS", `${name}.bindings[${index}].authority is invalid.`);
    if (binding.derivedState !== undefined) string(binding.derivedState, `${name}.bindings[${index}].derivedState`, 128);
  }
  for (const [index, rawRequirement] of array(value.requirements, `${name}.requirements`, 256).entries()) {
    const requirement = object(rawRequirement, `${name}.requirements[${index}]`); exact(requirement, ["family", "role"], ["background", "colorMode", "scale"]);
    string(requirement.family, `${name}.requirements[${index}].family`, 256); string(requirement.role, `${name}.requirements[${index}].role`, 256);
    for (const key of ["background", "colorMode", "scale"] as const) if (requirement[key] !== undefined) string(requirement[key], `${name}.requirements[${index}].${key}`, 64);
  }
}

function validateBrandTokenItem(raw: unknown, name: string): void {
  const value = object(raw, `${name} is invalid.`);
  const common = ["id", "type", "referenceCount", "recipeUseCount", "unused"];
  if (value.type === "gradient") exact(value, [...common, "kind", "units", "x1", "y1", "x2", "y2", "stops"]);
  else if (value.type === "dimension") exact(value, [...common, "unit", "value"]);
  else if (value.type === "color" || value.type === "opacity") exact(value, [...common, "value"]);
  else throw new ValidationError("INVALID_PARAMS", `${name}.type is invalid.`);
  id(value.id, `${name}.id`); nonNegativeInteger(value.referenceCount, `${name}.referenceCount`, 1_024); nonNegativeInteger(value.recipeUseCount, `${name}.recipeUseCount`, 1_024);
  if (typeof value.unused !== "boolean") throw new ValidationError("INVALID_PARAMS", `${name}.unused is invalid.`);
  if (value.type === "gradient") {
    if (value.kind !== "linear" || typeof value.units !== "string") throw new ValidationError("INVALID_PARAMS", `${name} gradient is invalid.`);
    for (const key of ["x1", "y1", "x2", "y2"] as const) if (typeof value[key] !== "number" || !Number.isFinite(value[key])) throw new ValidationError("INVALID_PARAMS", `${name}.${key} is invalid.`);
    for (const [index, rawStop] of array(value.stops, `${name}.stops`, 16).entries()) { const stop = object(rawStop, `${name}.stops[${index}]`); exact(stop, ["offset"], ["colorToken", "color"]); if (typeof stop.offset !== "number" || !Number.isFinite(stop.offset) || (stop.colorToken === undefined) === (stop.color === undefined)) throw new ValidationError("INVALID_PARAMS", `${name}.stops[${index}] is invalid.`); if (stop.colorToken !== undefined) id(stop.colorToken, `${name}.stops[${index}].colorToken`); if (stop.color !== undefined) string(stop.color, `${name}.stops[${index}].color`, 9); }
  } else if (typeof value.value !== (value.type === "color" ? "string" : "number")) throw new ValidationError("INVALID_PARAMS", `${name}.value is invalid.`);
}

function validateBrandExportStatusItem(raw: unknown, name: string): void {
  const value = object(raw, `${name} is invalid.`);
  exact(value, ["profileId", "outputId", "assetId", "binding", "destination", "state", "width", "height", "purpose", "background", "alpha", "canonicalAssetDigest", "svgDigest", "profileDigest", "outputConfigDigest", "pngDigest", "decodedPixelDigest", "receiptDigest", "capabilityAvailable"]);
  id(value.profileId, `${name}.profileId`); id(value.outputId, `${name}.outputId`); relative(value.destination, `${name}.destination`, 4_096); string(value.state, `${name}.state`, 128);
  if (value.assetId !== null) id(value.assetId, `${name}.assetId`);
  if (value.binding !== null) { const binding = object(value.binding, `${name}.binding`); exact(binding, ["family", "role", "variant"]); for (const key of ["family", "role", "variant"] as const) string(binding[key], `${name}.binding.${key}`, 256); }
  for (const key of ["width", "height"] as const) if (value[key] !== null) nonNegativeInteger(value[key], `${name}.${key}`, 16_384);
  for (const key of ["purpose", "background", "alpha"] as const) if (value[key] !== null) string(value[key], `${name}.${key}`, 128);
  for (const key of ["canonicalAssetDigest", "svgDigest", "profileDigest", "outputConfigDigest", "pngDigest", "decodedPixelDigest", "receiptDigest"] as const) nullableDigest(value[key], `${name}.${key}`);
  if (typeof value.capabilityAvailable !== "boolean") throw new ValidationError("INVALID_PARAMS", `${name}.capabilityAvailable is invalid.`);
}

function resultDigest(value: unknown, name: string): void { digest(value, name); }

function validateSemanticChange(raw: unknown, name: string): void {
  const value = object(raw, `${name} is invalid.`);
  exact(value, ["key", "category", "location", "changeType"], ["before", "after", "pathText", "diagnosticCode"]);
  string(value.key, `${name}.key`, 1_024);
  const categories = new Set(["canvas", "accessibility", "metadata", "gradient", "gradient_stop", "definition", "artwork_element", "presentation", "transform", "path_geometry", "companion", "asset_identity", "asset_addition_removal"]);
  if (typeof value.category !== "string" || !categories.has(value.category)) throw new ValidationError("INVALID_PARAMS", `${name}.category is invalid.`);
  string(value.location, `${name}.location`, 1_024);
  if (value.changeType !== "added" && value.changeType !== "removed" && value.changeType !== "changed") throw new ValidationError("INVALID_PARAMS", `${name}.changeType is invalid.`);
  if (value.before !== undefined) boundedJson(value.before);
  if (value.after !== undefined) boundedJson(value.after);
  if (value.diagnosticCode !== undefined) string(value.diagnosticCode, `${name}.diagnosticCode`, 128);
  if (value.pathText !== undefined) {
    const pathText = object(value.pathText, `${name}.pathText is invalid.`);
    exact(pathText, [], ["basis", "beforeSha256", "afterSha256", "beforeLength", "afterLength", "beforePrefix", "beforeSuffix", "afterPrefix", "afterSuffix"]);
    if (pathText.basis !== undefined && pathText.basis !== "tfsb-path-text-v1") throw new ValidationError("INVALID_PARAMS", `${name}.pathText.basis is invalid.`);
    for (const key of ["beforeSha256", "afterSha256"] as const) if (pathText[key] !== undefined) resultDigest(pathText[key], `${name}.pathText.${key}`);
    for (const key of ["beforeLength", "afterLength"] as const) if (pathText[key] !== undefined) nonNegativeInteger(pathText[key], `${name}.pathText.${key}`, 8 * 1024 * 1024);
    for (const key of ["beforePrefix", "beforeSuffix", "afterPrefix", "afterSuffix"] as const) if (pathText[key] !== undefined) string(pathText[key], `${name}.pathText.${key}`, 256);
  }
}

function validateAssetEditSummary(raw: unknown): void {
  const value = object(raw, "asset.edit.plan summary is invalid.");
  exact(value, ["assetId", "affectedCanonicalPath", "oldDigest", "newDigest", "changed", "changes"]);
  id(value.assetId, "summary.assetId"); relative(value.affectedCanonicalPath, "summary.affectedCanonicalPath");
  resultDigest(value.oldDigest, "summary.oldDigest"); resultDigest(value.newDigest, "summary.newDigest");
  if (typeof value.changed !== "boolean") throw new ValidationError("INVALID_PARAMS", "summary.changed is invalid.");
  for (const [index, change] of array(value.changes, "summary.changes", 100_000).entries()) validateSemanticChange(change, `summary.changes[${index}]`);
}

function validateImportSummary(raw: unknown): void {
  const value = object(raw, "project.import.plan summary is invalid.");
  exact(value, ["sourceKind", "schemaVersion", "assetCount", "companionCount", "canonicalFileCount", "willInitialize"], ["normalizationPolicyDigest", "sourceMapDigest", "snapshotDigest"]);
  if (value.sourceKind !== "archive" && value.sourceKind !== "directory") throw new ValidationError("INVALID_PARAMS", "summary.sourceKind is invalid.");
  if (value.schemaVersion !== 2 || value.willInitialize !== true) throw new ValidationError("INVALID_PARAMS", "project.import.plan summary versions are invalid.");
  nonNegativeInteger(value.assetCount, "summary.assetCount", 128); nonNegativeInteger(value.companionCount, "summary.companionCount", 1_024); nonNegativeInteger(value.canonicalFileCount, "summary.canonicalFileCount", 100_000);
  for (const key of ["normalizationPolicyDigest", "sourceMapDigest", "snapshotDigest"] as const) if (value[key] !== undefined) resultDigest(value[key], `summary.${key}`);
}

function validateReconcileSummary(raw: unknown): void {
  const value = object(raw, "project.reconcile.plan summary is invalid.");
  exact(value, ["sourceKind", "changed", "pending", "blocked", "records"], ["sourceMapDigest", "snapshotDigest"]);
  if (value.sourceKind !== "archive" && value.sourceKind !== "directory") throw new ValidationError("INVALID_PARAMS", "summary.sourceKind is invalid.");
  for (const key of ["changed", "pending", "blocked"] as const) if (typeof value[key] !== "boolean") throw new ValidationError("INVALID_PARAMS", `summary.${key} is invalid.`);
  for (const key of ["sourceMapDigest", "snapshotDigest"] as const) if (value[key] !== undefined) resultDigest(value[key], `summary.${key}`);
  const classifications = new Set(["UNCHANGED", "UNCHANGED_ACCEPTED_DIVERGENCE", "ARCHIVE_CHANGED", "CANONICAL_EDITED", "CONVERGED", "CONFLICT", "ARCHIVE_OMISSION", "ARCHIVE_OMISSION_CANONICAL_EDITED", "UNCHANGED_ACCEPTED_ABSENCE", "CONVERGED_ABSENCE", "CANONICAL_MISSING", "UNTRACKED_MATCH", "UNTRACKED_CONFLICT", "NEW_ASSET", "COMPANION_CHANGED", "NEW_COMPANION", "RENAMED", "COMPANION_RENAMED", "REMOVED", "COMPANION_REMOVED", "POLICY_AUTHORITY_REQUIRED", "SOURCE_CHANGED", "SOURCE_FORMATTING_ONLY", "CANONICAL_CHANGED", "BOTH_CHANGED", "SOURCE_OMISSION", "NEW_SOURCE", "ACCEPTED_CANONICAL_DIVERGENCE", "ACCEPTED_SOURCE_ABSENCE", "RENAME_REQUIRED", "REMOVE_REQUIRED", "SOURCE_MAP_AUTHORITY_REQUIRED", "SOURCE_KIND_AUTHORITY_REQUIRED"]);
  const actions = new Set(["none", "replace_canonical", "update_provenance", "add_canonical", "retain", "resolve", "rename", "remove", "blocked_collision"]);
  const authorities = new Set(["none", "resolve", "rename", "remove", "source-map", "source-kind", "policy"]);
  for (const [index, item] of array(value.records, "summary.records", 100_000).entries()) {
    const record = object(item, `summary.records[${index}]`);
    exact(record, ["key", "kind", "classification", "plannedAction", "requiredAuthority", "blocker"]);
    authorityKey(record.key, `summary.records[${index}].key`);
    if (record.kind !== "asset" && record.kind !== "companion") throw new ValidationError("INVALID_PARAMS", `summary.records[${index}].kind is invalid.`);
    if (typeof record.classification !== "string" || !classifications.has(record.classification)) throw new ValidationError("INVALID_PARAMS", `summary.records[${index}].classification is invalid.`);
    if (typeof record.plannedAction !== "string" || !actions.has(record.plannedAction)) throw new ValidationError("INVALID_PARAMS", `summary.records[${index}].plannedAction is invalid.`);
    if (typeof record.requiredAuthority !== "string" || !authorities.has(record.requiredAuthority)) throw new ValidationError("INVALID_PARAMS", `summary.records[${index}].requiredAuthority is invalid.`);
    if (typeof record.blocker !== "boolean") throw new ValidationError("INVALID_PARAMS", `summary.records[${index}].blocker is invalid.`);
  }
}

function validateMigrateSummary(raw: unknown): void {
  const value = object(raw, "project.migrate.plan summary is invalid.");
  exact(value, ["fromSchemaVersion", "toSchemaVersion", "migrationNeeded", "assetCount", "companionCount", "svgEquivalentCount", "canonicalPaths"]);
  if (value.fromSchemaVersion !== 1 && value.fromSchemaVersion !== 2 || value.toSchemaVersion !== 2 || typeof value.migrationNeeded !== "boolean") throw new ValidationError("INVALID_PARAMS", "Migration summary is invalid.");
  nonNegativeInteger(value.assetCount, "summary.assetCount", 128); nonNegativeInteger(value.companionCount, "summary.companionCount", 1_024); nonNegativeInteger(value.svgEquivalentCount, "summary.svgEquivalentCount", 128);
  uniqueStrings(value.canonicalPaths, "summary.canonicalPaths", 100_000, (item, name) => relative(item, name));
}

function validateFmtSummary(raw: unknown): void {
  const value = object(raw, "project.fmt.plan summary is invalid."); exact(value, ["changed", "fileCount", "canonicalPaths"]);
  if (typeof value.changed !== "boolean") throw new ValidationError("INVALID_PARAMS", "summary.changed is invalid.");
  nonNegativeInteger(value.fileCount, "summary.fileCount", 100_000); uniqueStrings(value.canonicalPaths, "summary.canonicalPaths", 100_000, relative);
}

function validateBuildOutput(raw: unknown, name: string): BuildPlanOutputSummary {
  const value = object(raw, `${name} is invalid.`); exact(value, ["filename", "size", "sha256"]);
  return { filename: relative(value.filename, `${name}.filename`), size: nonNegativeInteger(value.size, `${name}.size`, 8 * 1024 * 1024), sha256: digest(value.sha256, `${name}.sha256`) };
}

function validateBuildSummary(raw: unknown): void {
  const value = object(raw, "project.build.plan summary is invalid."); exact(value, ["buildDirectory", "outputCount", "outputs", "replacingExisting", "receiptDigest"]);
  relative(value.buildDirectory, "summary.buildDirectory"); nonNegativeInteger(value.outputCount, "summary.outputCount", 128);
  if (typeof value.replacingExisting !== "boolean") throw new ValidationError("INVALID_PARAMS", "summary.replacingExisting is invalid.");
  digest(value.receiptDigest, "summary.receiptDigest");
  const outputs = array(value.outputs, "summary.outputs", 128);
  if (outputs.length !== value.outputCount) throw new ValidationError("INVALID_PARAMS", "summary.outputCount does not match outputs.");
  for (const [index, output] of outputs.entries()) validateBuildOutput(output, `summary.outputs[${index}]`);
}

function validateInstallSummary(raw: unknown): void {
  const value = object(raw, "project.install.plan summary is invalid."); exact(value, ["itemCount", "items"]);
  nonNegativeInteger(value.itemCount, "summary.itemCount", 2_048);
  const items = array(value.items, "summary.items", 2_048);
  if (items.length !== value.itemCount) throw new ValidationError("INVALID_PARAMS", "summary.itemCount does not match items.");
  for (const [index, item] of items.entries()) {
    const record = object(item, `summary.items[${index}]`); exact(record, ["assetId", "source", "configuredDestination"]);
    authorityKey(record.assetId, `summary.items[${index}].assetId`); relative(record.source, `summary.items[${index}].source`); relative(record.configuredDestination, `summary.items[${index}].configuredDestination`);
  }
}

function validatePreviewSummary(raw: unknown): void {
  const value = object(raw, "preview.plan summary is invalid."); exact(value, ["outputDirectory", "replaced", "assetCount", "companionCount", "fileCount", "buildExtraCount"]);
  relative(value.outputDirectory, "summary.outputDirectory");
  if (typeof value.replaced !== "boolean") throw new ValidationError("INVALID_PARAMS", "summary.replaced is invalid.");
  nonNegativeInteger(value.assetCount, "summary.assetCount", 128); nonNegativeInteger(value.companionCount, "summary.companionCount", 1_024); nonNegativeInteger(value.fileCount, "summary.fileCount", 100_000); nonNegativeInteger(value.buildExtraCount, "summary.buildExtraCount", 100_000);
}

function validateBrandDeriveSummary(raw: unknown): void {
  const value = object(raw, "brand.derive.plan summary is invalid.");
  exact(value, ["selectedRecipes", "transitiveRecipes", "affectedTargets", "createdCount", "updatedCount", "unchangedCount", "operationSummaries", "targetStates", "tokenDigest", "recipeDigest", "brandSystemDigest", "warnings", "dryRun"]);
  for (const key of ["selectedRecipes", "transitiveRecipes", "affectedTargets"] as const) uniqueStrings(value[key], `summary.${key}`, 128, id);
  for (const key of ["createdCount", "updatedCount", "unchangedCount"] as const) nonNegativeInteger(value[key], `summary.${key}`, 128);
  for (const [index, rawOperation] of array(value.operationSummaries, "summary.operationSummaries", 128).entries()) { const operation = object(rawOperation, `summary.operationSummaries[${index}]`); exact(operation, ["recipeId", "targetAssetId", "operations"]); id(operation.recipeId, `summary.operationSummaries[${index}].recipeId`); id(operation.targetAssetId, `summary.operationSummaries[${index}].targetAssetId`); array(operation.operations, `summary.operationSummaries[${index}].operations`, 128).forEach((item, itemIndex) => string(item, `summary.operationSummaries[${index}].operations[${itemIndex}]`, 128)); }
  for (const [index, rawTarget] of array(value.targetStates, "summary.targetStates", 128).entries()) { const target = object(rawTarget, `summary.targetStates[${index}]`); exact(target, ["targetAssetId", "recipeId", "state", "newDigest", "newSvgDigest"], ["oldDigest"]); id(target.targetAssetId, `summary.targetStates[${index}].targetAssetId`); id(target.recipeId, `summary.targetStates[${index}].recipeId`); if (!["create", "update", "unchanged"].includes(String(target.state))) throw new ValidationError("INVALID_PARAMS", `summary.targetStates[${index}].state is invalid.`); for (const key of ["oldDigest", "newDigest", "newSvgDigest"] as const) if (target[key] !== undefined) resultDigest(target[key], `summary.targetStates[${index}].${key}`); }
  resultDigest(value.tokenDigest, "summary.tokenDigest"); resultDigest(value.recipeDigest, "summary.recipeDigest"); resultDigest(value.brandSystemDigest, "summary.brandSystemDigest"); array(value.warnings, "summary.warnings", 128).forEach((item, index) => string(item, `summary.warnings[${index}]`, 1_024)); if (typeof value.dryRun !== "boolean") throw new ValidationError("INVALID_PARAMS", "summary.dryRun is invalid.");
}

function validateBrandBaselineSummary(raw: unknown): void {
  const value = object(raw, "brand.qa.baseline.plan summary is invalid."); exact(value, ["profileId", "caseId", "baselinePath", "state", "oldBaselineDigest", "newBaselineDigest", "oldQaDigest", "newQaDigest", "renderer", "assetDigests", "svgDigests", "brandSystemDigests", "rasterDifference"]);
  id(value.profileId, "summary.profileId"); id(value.caseId, "summary.caseId"); relative(value.baselinePath, "summary.baselinePath", 4_096); if (!["create", "update", "rebaseline"].includes(String(value.state))) throw new ValidationError("INVALID_PARAMS", "summary.state is invalid."); nullableDigest(value.oldBaselineDigest, "summary.oldBaselineDigest"); for (const key of ["newBaselineDigest", "oldQaDigest", "newQaDigest"] as const) resultDigest(value[key], `summary.${key}`);
  const renderer = object(value.renderer, "summary.renderer"); exact(renderer, ["id", "version", "qualificationId", "platformClaim", "rendererBuildDigest"]); for (const key of ["id", "version", "qualificationId", "platformClaim"] as const) string(renderer[key], `summary.renderer.${key}`, 256); resultDigest(renderer.rendererBuildDigest, "summary.renderer.rendererBuildDigest");
  for (const key of ["assetDigests", "svgDigests", "brandSystemDigests"] as const) { const pair = object(value[key], `summary.${key}`); exact(pair, ["old", "next"]); resultDigest(pair.old, `summary.${key}.old`); resultDigest(pair.next, `summary.${key}.next`); }
  const difference = object(value.rasterDifference, "summary.rasterDifference"); exact(difference, ["changedPixels", "maximumChannelDelta", "changedBounds", "beforeDecodedPixelDigest", "afterDecodedPixelDigest"]); for (const key of ["changedPixels", "maximumChannelDelta"] as const) if (difference[key] !== null) nonNegativeInteger(difference[key], `summary.rasterDifference.${key}`); if (difference.changedBounds !== null) { const bounds = object(difference.changedBounds, "summary.rasterDifference.changedBounds"); exact(bounds, ["left", "top", "right", "bottom"]); for (const [key, coordinate] of Object.entries(bounds)) nonNegativeInteger(coordinate, `summary.rasterDifference.changedBounds.${key}`); } nullableDigest(difference.beforeDecodedPixelDigest, "summary.rasterDifference.beforeDecodedPixelDigest"); resultDigest(difference.afterDecodedPixelDigest, "summary.rasterDifference.afterDecodedPixelDigest");
}

function validateBrandConsumerSummary(raw: unknown, method: "brand.consumer.install.plan" | "brand.consumer.sync.plan"): void {
  const value = object(raw, `${method} summary is invalid.`); exact(value, ["operation", "packages", "profiles", "outputs", "omittedOptional", "lockDigest"]); if (value.operation !== (method === "brand.consumer.install.plan" ? "install" : "sync")) throw new ValidationError("INVALID_PARAMS", `${method} operation is invalid.`); uniqueStrings(value.packages, "summary.packages", 8, string); uniqueStrings(value.profiles, "summary.profiles", 8, string); uniqueStrings(value.omittedOptional, "summary.omittedOptional", 512, string); resultDigest(value.lockDigest, "summary.lockDigest"); for (const [index, rawOutput] of array(value.outputs, "summary.outputs", 512).entries()) { const output = object(rawOutput, `summary.outputs[${index}]`); exact(output, ["kind", "packageId", "sourceId", "destination", "byteDigest"]); if (output.kind !== "asset" && output.kind !== "companion") throw new ValidationError("INVALID_PARAMS", `summary.outputs[${index}].kind is invalid.`); string(output.packageId, `summary.outputs[${index}].packageId`, 256); string(output.sourceId, `summary.outputs[${index}].sourceId`, 256); relative(output.destination, `summary.outputs[${index}].destination`, 4_096); resultDigest(output.byteDigest, `summary.outputs[${index}].byteDigest`); }
}

function validateBrandExportSummary(raw: unknown): void {
  const value = object(raw, "brand.export.plan summary is invalid."); exact(value, ["profileId", "adapter", "outputs", "counts", "warnings"]); id(value.profileId, "summary.profileId"); const adapter = object(value.adapter, "summary.adapter"); exact(adapter, ["adapterId", "companionPackage", "companionVersion", "backend", "rendererPackage", "rendererVersion", "rendererBuildDigest", "nodeMajor", "platformClaim", "qualificationId"]); if (adapter.adapterId !== "resvg-png-v1" || adapter.companionPackage !== "@knowledge-forge-ai/tfsb-raster-resvg" || adapter.backend !== "wasm" && adapter.backend !== "native") throw new ValidationError("INVALID_PARAMS", "summary.adapter is invalid."); for (const key of ["companionVersion", "rendererPackage", "rendererVersion", "platformClaim", "qualificationId"] as const) string(adapter[key], `summary.adapter.${key}`, 256); resultDigest(adapter.rendererBuildDigest, "summary.adapter.rendererBuildDigest"); nonNegativeInteger(adapter.nodeMajor, "summary.adapter.nodeMajor", 1_024); array(value.outputs, "summary.outputs", 128).forEach((item) => boundedJson(item)); const counts = object(value.counts, "summary.counts"); exact(counts, ["create", "update", "unchanged"]); for (const [key, count] of Object.entries(counts)) nonNegativeInteger(count, `summary.counts.${key}`, 128); array(value.warnings, "summary.warnings", 128).forEach((item, index) => string(item, `summary.warnings[${index}]`, 1_024));
}

function validatePlanResult(method: StudioPlanMethod, raw: unknown): void {
  const value = object(raw, `${method} result must be an object.`);
  exact(value, ["planToken", "planDigest", "expiresInMs", "method", "summary"]);
  token(value.planToken, "planToken"); digest(value.planDigest, "planDigest");
  if (value.expiresInMs !== 600_000 || value.method !== method) throw new ValidationError("INVALID_PARAMS", `${method} result wrapper is invalid.`);
  if (method === "asset.edit.plan") validateAssetEditSummary(value.summary);
  else if (method === "project.import.plan") validateImportSummary(value.summary);
  else if (method === "project.reconcile.plan") validateReconcileSummary(value.summary);
  else if (method === "project.migrate.plan") validateMigrateSummary(value.summary);
  else if (method === "project.fmt.plan") validateFmtSummary(value.summary);
  else if (method === "project.build.plan") validateBuildSummary(value.summary);
  else if (method === "project.install.plan") validateInstallSummary(value.summary);
  else if (method === "preview.plan") validatePreviewSummary(value.summary);
  else if (method === "brand.derive.plan") validateBrandDeriveSummary(value.summary);
  else if (method === "brand.qa.baseline.plan") validateBrandBaselineSummary(value.summary);
  else if (method === "brand.consumer.install.plan" || method === "brand.consumer.sync.plan") validateBrandConsumerSummary(value.summary, method);
  else if (method === "brand.export.plan") validateBrandExportSummary(value.summary);
}

export function validateProgressParams(raw: unknown): void {
  const value = object(raw, "Progress parameters must be an object.");
  exact(value, ["requestId", "stage", "completed"], ["total"]);
  validateJsonRpcId(value.requestId);
  const stages: readonly StudioProgressStage[] = ["started", "scanning", "complete", "validate", "snapshot", "analyze", "plan", "ready", "revalidate", "waiting-lock", "staging", "promoting", "cleanup"];
  if (typeof value.stage !== "string" || !stages.includes(value.stage as StudioProgressStage)) throw new ValidationError("INVALID_PARAMS", "Progress stage is invalid.");
  nonNegativeInteger(value.completed, "completed");
  if (value.total !== undefined) nonNegativeInteger(value.total, "total");
  if (value.total !== undefined && (value.completed as number) > (value.total as number)) throw new ValidationError("INVALID_PARAMS", "completed cannot exceed total.");
}

export function validateVisualEvidenceResult(raw: unknown): void {
  const value = object(raw, "visual evidence result must be an object.");
  exact(value, ["schema", "schemaVersion", "kind", "projectDigest", "brandSystemDigest", "target", "configuration", "renderer", "artifacts", "evidenceDigest"], ["sourceDigest", "qaDigest", "difference"]);
  if (value.schema !== "tfsb.studio-visual-evidence" || value.schemaVersion !== 1 || !["project-render", "qa-baseline", "brand-diff"].includes(String(value.kind))) throw new ValidationError("INVALID_PARAMS", "visual evidence identity is invalid.");
  resultDigest(value.projectDigest, "projectDigest"); resultDigest(value.brandSystemDigest, "brandSystemDigest");
  if (value.sourceDigest !== undefined) resultDigest(value.sourceDigest, "sourceDigest"); if (value.qaDigest !== undefined) resultDigest(value.qaDigest, "qaDigest");
  if (value.kind === "project-render" && (value.sourceDigest !== undefined || value.qaDigest !== undefined || value.difference !== undefined) || value.kind === "qa-baseline" && (value.qaDigest === undefined || value.sourceDigest !== undefined || value.difference === undefined) || value.kind === "brand-diff" && (value.sourceDigest === undefined || value.qaDigest !== undefined || value.difference === undefined)) throw new ValidationError("INVALID_PARAMS", "visual evidence optional fields are inconsistent.");
  const target = object(value.target, "visual evidence target is invalid."); exact(target, ["assetId", "canonicalAssetDigest", "svgDigest"], ["binding"]); id(target.assetId, "target.assetId"); resultDigest(target.canonicalAssetDigest, "target.canonicalAssetDigest"); resultDigest(target.svgDigest, "target.svgDigest");
  if (target.binding !== undefined) { const binding = object(target.binding, "target.binding is invalid."); exact(binding, ["family", "role", "variant"]); id(binding.family, "target.binding.family"); id(binding.role, "target.binding.role"); id(binding.variant, "target.binding.variant"); }
  const configuration = object(value.configuration, "visual evidence configuration is invalid."); exact(configuration, ["width", "height", "background"]); const width = nonNegativeInteger(configuration.width, "configuration.width", 1_024), height = nonNegativeInteger(configuration.height, "configuration.height", 1_024); if (width < 16 || height < 16 || width * height > 1_048_576) throw new ValidationError("INVALID_PARAMS", "visual evidence dimensions are invalid."); const background = string(configuration.background, "configuration.background", 256); if (background !== "transparent" && !/^#[0-9A-F]{8}$/u.test(background) && !/^token:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(background)) throw new ValidationError("INVALID_PARAMS", "visual evidence background is invalid.");
  const renderer = object(value.renderer, "visual evidence renderer is invalid."); exact(renderer, ["id", "version", "qualificationId", "platformClaim"]); if (renderer.id !== "resvg-png-v1" || renderer.version !== "2.6.2" || renderer.qualificationId !== QUALIFICATION_ID || renderer.platformClaim !== "darwin-arm64") throw new ValidationError("INVALID_PARAMS", "visual evidence renderer is invalid.");
  const artifacts = array(value.artifacts, "artifacts", 2); if (artifacts.length < 1) throw new ValidationError("INVALID_PARAMS", "visual evidence requires an artifact.");
  const expectedRoles = value.kind === "project-render" ? ["current"] : value.kind === "qa-baseline" ? ["baseline", "current"] : ["before", "after"];
  let aggregate = 0;
  for (const [index, rawArtifact] of artifacts.entries()) {
    const item = object(rawArtifact, `artifacts[${index}] is invalid.`); exact(item, ["role", "mediaType", "encoding", "width", "height", "byteLength", "pngDigest", "decodedPixelDigest", "bytesBase64"]);
    if (item.role !== expectedRoles[index] || item.mediaType !== "image/png" || item.encoding !== "base64" || item.width !== width || item.height !== height) throw new ValidationError("INVALID_PARAMS", `artifacts[${index}] identity is invalid.`);
    const byteLength = nonNegativeInteger(item.byteLength, `artifacts[${index}].byteLength`, 6_291_456); aggregate += byteLength; resultDigest(item.pngDigest, `artifacts[${index}].pngDigest`); resultDigest(item.decodedPixelDigest, `artifacts[${index}].decodedPixelDigest`);
    const encoded = string(item.bytesBase64, `artifacts[${index}].bytesBase64`, 8_388_608); if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new ValidationError("INVALID_PARAMS", "visual evidence base64 is invalid.");
    const bytes = Buffer.from(encoded, "base64"); if (bytes.toString("base64") !== encoded || bytes.byteLength !== byteLength || computeSha256(bytes) !== item.pngDigest) throw new ValidationError("INVALID_PARAMS", "visual evidence PNG identity is invalid.");
    let decoded; try { decoded = decodeStrictPng(bytes, width, height); } catch { throw new ValidationError("INVALID_PARAMS", "visual evidence PNG is invalid."); }
    if (decoded.decodedPixelDigest !== item.decodedPixelDigest) throw new ValidationError("INVALID_PARAMS", "visual evidence decoded pixel digest is invalid.");
  }
  if (artifacts.length !== expectedRoles.length || aggregate > 8_388_608) throw new ValidationError("INVALID_PARAMS", "visual evidence artifact set is invalid.");
  if (value.difference !== undefined) { const diff = object(value.difference, "visual evidence difference is invalid."); exact(diff, ["changedPixels", "maximumChannelDelta", "changedBounds", "claim"]); const changedPixels = nonNegativeInteger(diff.changedPixels, "difference.changedPixels", width * height); const maximumChannelDelta = nonNegativeInteger(diff.maximumChannelDelta, "difference.maximumChannelDelta", 255); if (diff.claim !== "pixel-equal-for-this-renderer-and-case-only" && diff.claim !== "pixel-different-for-this-renderer-and-case-only") throw new ValidationError("INVALID_PARAMS", "visual evidence difference claim is invalid."); const equal = changedPixels === 0; if (equal !== (diff.claim === "pixel-equal-for-this-renderer-and-case-only") || equal && (maximumChannelDelta !== 0 || diff.changedBounds !== null) || !equal && (maximumChannelDelta === 0 || diff.changedBounds === null)) throw new ValidationError("INVALID_PARAMS", "visual evidence difference claim is inconsistent."); if (diff.changedBounds !== null) { const bounds = object(diff.changedBounds, "difference.changedBounds is invalid."); exact(bounds, ["left", "top", "right", "bottom"]); const left = nonNegativeInteger(bounds.left, "difference.changedBounds.left", width - 1), right = nonNegativeInteger(bounds.right, "difference.changedBounds.right", width - 1), top = nonNegativeInteger(bounds.top, "difference.changedBounds.top", height - 1), bottom = nonNegativeInteger(bounds.bottom, "difference.changedBounds.bottom", height - 1); if (left > right || top > bottom) throw new ValidationError("INVALID_PARAMS", "visual evidence changed bounds are invalid."); } }
  resultDigest(value.evidenceDigest, "evidenceDigest");
  const { evidenceDigest: _evidenceDigest, ...withoutDigest } = value;
  const projection = { ...withoutDigest, artifacts: artifacts.map((rawArtifact) => { const { bytesBase64: _bytesBase64, ...entry } = rawArtifact as PlainObject; return entry; }) };
  const computedEvidenceDigest = computeSha256(Buffer.from(`${VISUAL_EVIDENCE_DIGEST_BASIS}\n${canonicalJson(projection)}`, "utf8"));
  if (computedEvidenceDigest !== value.evidenceDigest) throw new ValidationError("INVALID_PARAMS", "visual evidence digest is invalid.");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 12_582_912) throw new ValidationError("INVALID_PARAMS", "visual evidence result is oversized.");
}

export function validateResult(method: SupportedRequestMethod, raw: unknown): void {
  if (method === "shutdown") { if (raw !== null) throw new ValidationError("INVALID_PARAMS", "shutdown result must be null."); return; }
  if (method === "plan.apply") {
    if (raw === null) return;
    const value = object(raw, "plan.apply result must be an object."); exact(value, ["applied", "method"]);
    if (value.applied !== true || typeof value.method !== "string" || !PLAN_METHODS.includes(value.method as StudioPlanMethod)) throw new ValidationError("INVALID_PARAMS", "plan.apply result is invalid.");
    return;
  }
  if (method === "plan.discard") { const value = object(raw, "plan.discard result must be an object."); exact(value, ["discarded"]); if (value.discarded !== true) throw new ValidationError("INVALID_PARAMS", "plan.discard result is invalid."); return; }
  if (PLAN_METHODS.includes(method as StudioPlanMethod)) { validatePlanResult(method as StudioPlanMethod, raw); return; }
  const value = object(raw, `${method} result must be an object.`);
  if (method === "initialize") {
    exact(value, ["protocol", "selectedVersion", "server", "sessionNonce", "capabilities"]);
    if (value.protocol !== "tfsb.studio" || value.selectedVersion !== "1.0" && value.selectedVersion !== "1.1" && value.selectedVersion !== "1.2") throw new ValidationError("INVALID_PARAMS", "initialize result negotiation is invalid.");
    const server = object(value.server, "initialize server result is invalid."); exact(server, ["name", "version"]); if (server.name !== "tfsb-studio-service") throw new ValidationError("INVALID_PARAMS", "initialize server name is invalid."); string(server.version, "server.version", 64);
    const nonce = string(value.sessionNonce, "sessionNonce", 43); if (!TOKEN.test(nonce)) throw new ValidationError("INVALID_PARAMS", "sessionNonce is invalid.");
    const capabilities = object(value.capabilities, "initialize capabilities are invalid."); exact(capabilities, value.selectedVersion === "1.0" ? ["methods", "limits"] : ["methods", "limits", "brand"]);
    const methods = object(capabilities.methods, "initialize methods are invalid."); exact(methods, ["workspaceOpen", "projectOpen", "sourceOpen", "workspaceStatus", "projectList", "assetList", "assetGet", "assetValidate", "assetDiff", "sourceAnalyze", "previewStatus", "progress", "cancellation", "mutationPlans", "planApply"]);
    for (const key of Object.keys(methods)) if (methods[key] !== true) throw new ValidationError("INVALID_PARAMS", `initialize methods.${key} must be true.`);
    const limits = object(capabilities.limits, "initialize limits are invalid."); exact(limits, ["maxFrameBytes", "maxConcurrentReads", "maxQueuedReads", "assetPageSizeMin", "assetPageSizeDefault", "assetPageSizeMax", "sourceDetailPageSizeMin", "sourceDetailPageSizeDefault", "sourceDetailPageSizeMax", "maxActivePlans", "maxRetainedPlanBytes", "maxRetainedNativeSnapshotPlans", "planTtlMs", "maxConcurrentApplies"]);
    const expected = { maxFrameBytes: 16_777_216, maxConcurrentReads: 4, maxQueuedReads: 4, assetPageSizeMin: 1, assetPageSizeDefault: 64, assetPageSizeMax: 128, sourceDetailPageSizeMin: 1, sourceDetailPageSizeDefault: 64, sourceDetailPageSizeMax: 128, maxActivePlans: 4, maxRetainedPlanBytes: 201_326_592, maxRetainedNativeSnapshotPlans: 1, planTtlMs: 600_000, maxConcurrentApplies: 1 } as const;
    for (const [key, expectedValue] of Object.entries(expected)) if (limits[key] !== expectedValue) throw new ValidationError("INVALID_PARAMS", `initialize limits.${key} is invalid.`);
    if (value.selectedVersion !== "1.0") {
      const brand = object(capabilities.brand, "initialize brand capability is invalid."); exact(brand, value.selectedVersion === "1.2" ? ["schemaVersion", "methods", "sourcePurposes", "raster", "limits", "visualEvidence"] : ["schemaVersion", "methods", "sourcePurposes", "raster", "limits"]); if (brand.schemaVersion !== 1) throw new ValidationError("INVALID_PARAMS", "brand schemaVersion is invalid.");
      const brandMethods = object(brand.methods, "brand methods are invalid."); exact(brandMethods, value.selectedVersion === "1.2" ? ["status", "familyList", "tokenList", "recipeGraph", "qaProfileGet", "qaResultGet", "diff", "consumerProfileList", "consumerLockStatus", "exportCapability", "exportStatus", "derivePlan", "qaBaselinePlan", "consumerInstallPlan", "consumerSyncPlan", "exportPlan", "qaProfileList", "visualEvidenceGet"] : ["status", "familyList", "tokenList", "recipeGraph", "qaProfileGet", "qaResultGet", "diff", "consumerProfileList", "consumerLockStatus", "exportCapability", "exportStatus", "derivePlan", "qaBaselinePlan", "consumerInstallPlan", "consumerSyncPlan", "exportPlan"]);
      for (const [key, enabled] of Object.entries(brandMethods)) if (typeof enabled !== "boolean" || key !== "qaBaselinePlan" && key !== "exportPlan" && key !== "visualEvidenceGet" && enabled !== true || key === "qaProfileList" && enabled !== true) throw new ValidationError("INVALID_PARAMS", `brand.methods.${key} is invalid.`);
      const purposes = object(brand.sourcePurposes, "brand source purposes are invalid."); exact(purposes, ["brandBundle", "npmInstalledPackage"]); if (purposes.brandBundle !== true || purposes.npmInstalledPackage !== true) throw new ValidationError("INVALID_PARAMS", "brand source purposes are invalid.");
      const raster = object(brand.raster, "brand raster capability is invalid."); if (raster.available === false) exact(raster, ["available"]); else { exact(raster, ["available", "adapterId", "rendererVersion", "qualificationId", "platformClaim"]); if (raster.available !== true || raster.adapterId !== "resvg-png-v1" || raster.platformClaim !== "darwin-arm64") throw new ValidationError("INVALID_PARAMS", "brand raster descriptor is invalid."); }
      const brandLimits = object(brand.limits, "brand limits are invalid."); exact(brandLimits, ["pageSizeMin", "pageSizeDefault", "pageSizeMax", "maxSourcePackages", "maxSelectedProfiles", "maxQaResultBytes", "maxDiffResultBytes", "maxExportOutputs"]);
      const expectedBrandLimits = { pageSizeMin: 1, pageSizeDefault: 64, pageSizeMax: 128, maxSourcePackages: 8, maxSelectedProfiles: 8, maxQaResultBytes: 16_777_216, maxDiffResultBytes: 16_777_216, maxExportOutputs: 128 };
      for (const [key, expectedValue] of Object.entries(expectedBrandLimits)) if (brandLimits[key] !== expectedValue) throw new ValidationError("INVALID_PARAMS", `brand.limits.${key} is invalid.`);
      if (value.selectedVersion === "1.2") {
        const visual = object(brand.visualEvidence, "visual evidence capability is invalid.");
        if (visual.available === false) exact(visual, ["available"]);
        else { exact(visual, ["available", "mediaTypes", "encoding", "maxDimension", "maxPixels", "maxArtifactBytes", "maxAggregateArtifactBytes", "maxResultBytes", "maxArtifacts"]); if (visual.available !== true || JSON.stringify(visual.mediaTypes) !== '["image/png"]' || visual.encoding !== "base64" || visual.maxDimension !== 1_024 || visual.maxPixels !== 1_048_576 || visual.maxArtifactBytes !== 6_291_456 || visual.maxAggregateArtifactBytes !== 8_388_608 || visual.maxResultBytes !== 12_582_912 || visual.maxArtifacts !== 2) throw new ValidationError("INVALID_PARAMS", "visual evidence capability bounds are invalid."); }
        if (brandMethods.visualEvidenceGet !== visual.available) throw new ValidationError("INVALID_PARAMS", "visual evidence method/capability state is inconsistent.");
      }
    }
    boundedJson(value); return;
  }
  if (method === "workspace.open") { exact(value, ["workspaceHandle", "rootKind", "workspaceId", "name", "manifestDigest", "childCount", "diagnostics"]); handle(value.workspaceHandle, "workspaceHandle", "workspace"); if (value.rootKind !== "workspace") throw new ValidationError("INVALID_PARAMS", "workspace.open rootKind is invalid."); resultDigest(value.manifestDigest, "manifestDigest"); nonNegativeInteger(value.childCount, "childCount", 1_024); array(value.diagnostics, "diagnostics", 128); boundedJson(value); return; }
  if (method === "project.open") {
    if (Object.hasOwn(value, "state")) { exact(value, ["projectHandle", "rootKind", "state"]); handle(value.projectHandle, "projectHandle", "project"); if (value.rootKind !== "project" || value.state !== "uninitialized") throw new ValidationError("INVALID_PARAMS", "project.open uninitialized result is invalid."); return; }
    exact(value, ["projectHandle", "rootKind", "schemaVersion", "name", "canonicalDigest", "assetCount", "companionCount"]); handle(value.projectHandle, "projectHandle", "project"); if (value.rootKind !== "project" || value.schemaVersion !== 1 && value.schemaVersion !== 2) throw new ValidationError("INVALID_PARAMS", "project.open result is invalid."); string(value.name, "name", 256); resultDigest(value.canonicalDigest, "canonicalDigest"); nonNegativeInteger(value.assetCount, "assetCount", 128); nonNegativeInteger(value.companionCount, "companionCount", 1_024); boundedJson(value); return;
  }
  if (method === "source.open") {
    if (value.authorityKind === "brand-bundle" || value.authorityKind === "npm-installed-package") {
      const optional = value.authorityKind === "npm-installed-package" ? ["npmName", "npmVersion"] : [];
      exact(value, ["sourceHandle", "rootKind", "authorityKind", "packageId", "brandVersion", "brandSystemDigest", "brandManifestDigest", "consumerProfilesDigest", "profileCount", "assetCount", "companionCount", "capabilities"], optional);
      handle(value.sourceHandle, "sourceHandle", "source"); if (value.rootKind !== "source") throw new ValidationError("INVALID_PARAMS", "source.open brand root kind is invalid.");
      string(value.packageId, "packageId", 256); string(value.brandVersion, "brandVersion", 128); resultDigest(value.brandSystemDigest, "brandSystemDigest"); resultDigest(value.brandManifestDigest, "brandManifestDigest"); resultDigest(value.consumerProfilesDigest, "consumerProfilesDigest");
      nonNegativeInteger(value.profileCount, "profileCount", 32); nonNegativeInteger(value.assetCount, "assetCount", 128); nonNegativeInteger(value.companionCount, "companionCount", 64);
      const capabilities = object(value.capabilities, "source capabilities are invalid."); exact(capabilities, ["analyze", "brandDiff", "consumerSource"]); if (capabilities.analyze !== false || capabilities.brandDiff !== true || capabilities.consumerSource !== true) throw new ValidationError("INVALID_PARAMS", "source brand capabilities are invalid."); boundedJson(value); return;
    }
    if (Object.hasOwn(value, "authorityKind")) { exact(value, ["sourceHandle", "rootKind", "authorityKind", "byteDigest", "semanticDigest", "byteLength", "capabilities"]); handle(value.sourceHandle, "sourceHandle", "source"); if (value.rootKind !== "source" || value.authorityKind !== "source-map" && value.authorityKind !== "normalization-map" && value.authorityKind !== "shard-manifest") throw new ValidationError("INVALID_PARAMS", "source.open auxiliary result is invalid."); resultDigest(value.byteDigest, "byteDigest"); resultDigest(value.semanticDigest, "semanticDigest"); nonNegativeInteger(value.byteLength, "byteLength", 1_048_576); const capabilities = object(value.capabilities, "source capabilities are invalid."); exact(capabilities, ["analyze", "mutationAuthority"]); if (capabilities.analyze !== false || capabilities.mutationAuthority !== true) throw new ValidationError("INVALID_PARAMS", "source auxiliary capabilities are invalid."); return; }
    exact(value, ["sourceHandle", "rootKind", "sourceKind", "digest", "candidateCount", "capabilities"]); handle(value.sourceHandle, "sourceHandle", "source"); if (value.rootKind !== "source" || value.sourceKind !== "directory" && value.sourceKind !== "archive") throw new ValidationError("INVALID_PARAMS", "source.open result is invalid."); resultDigest(value.digest, "digest"); nonNegativeInteger(value.candidateCount, "candidateCount", 100_000); const capabilities = object(value.capabilities, "source capabilities are invalid."); exact(capabilities, ["analyze", "mutation"]); if (capabilities.analyze !== true || capabilities.mutation !== false) throw new ValidationError("INVALID_PARAMS", "source capabilities are invalid."); boundedJson(value); return;
  }
  if (method === "workspace.status") {
    if (Object.hasOwn(value, "workspaceId")) { exact(value, ["workspaceId", "name", "digest", "totalProjects", "loadable", "failed", "diagnostics"]); resultDigest(value.digest, "digest"); nonNegativeInteger(value.totalProjects, "totalProjects", 1_024); nonNegativeInteger(value.loadable, "loadable", 1_024); nonNegativeInteger(value.failed, "failed", 1_024); array(value.diagnostics, "diagnostics", 128); }
    else exact(value, ["status", "workspace", "projects", "drift", "children", "diagnostics"]);
    boundedJson(value); return;
  }
  if (method === "project.list") { exact(value, ["assets", "companions"]); for (const item of array(value.assets, "assets", 128)) exact(object(item, "asset summary is invalid."), ["id", "filename", "buildPath", "destinations"]); for (const item of array(value.companions, "companions", 1_024)) exact(object(item, "companion summary is invalid."), ["file", "canonicalPath", "destinations"]); boundedJson(value); return; }
  if (method === "asset.list") { exact(value, ["scope", "page", "viewDigest"]); const scope = object(value.scope, "asset.list scope result is invalid."); if (scope.kind === "workspace") exact(scope, ["kind", "workspaceId"]); else exact(scope, ["kind"]); const page = object(value.page, "asset.list page is invalid."); exact(page, ["size", "count", "items", "nextCursor"]); array(page.items, "items", 128); resultDigest(value.viewDigest, "viewDigest"); boundedJson(value); return; }
  if (method === "asset.get") { exact(value, ["assetId", "canonicalToml", "model", "canonicalSvg", "digests"]); exact(object(value.digests, "asset digests are invalid."), ["rawToml", "semantic", "svg"]); boundedJson(value); return; }
  if (method === "asset.validate") { if (value.valid === false) { exact(value, ["valid", "diagnostics"]); array(value.diagnostics, "diagnostics", 128); } else { exact(value, ["valid", "model", "canonicalToml", "digests"]); exact(object(value.digests, "validation digests are invalid."), ["rawToml", "semantic"]); } boundedJson(value); return; }
  if (method === "asset.diff") { if (value.valid === false) { exact(value, ["valid", "diagnostics"]); array(value.diagnostics, "diagnostics", 128); } else { exact(value, ["valid", "different", "changes", "proposedDigest"]); if (typeof value.different !== "boolean") throw new ValidationError("INVALID_PARAMS", "asset.diff different is invalid."); array(value.changes, "changes", 100_000); resultDigest(value.proposedDigest, "proposedDigest"); } boundedJson(value); return; }
  if (method === "source.analyze") { exact(value, ["sourceKind", "status", "summary", "details"]); const summary = object(value.summary, "analysis summary is invalid."); exact(summary, ["totals", "profiles", "resourceObservations", "identity"]); const details = object(value.details, "analysis details are invalid."); exact(details, ["count", "items", "nextCursor"]); array(details.items, "details", 128); boundedJson(value); return; }
  if (method === "preview.status") { if (value.status === "owned-clean" || value.status === "owned-drift") exact(value, ["status", "outputIdentity", "markerDigest", "assetCount"]); else exact(value, ["status", "outputIdentity", "markerDigest"]); boundedJson(value); return; }
  if (method === "brand.status") {
    if (value.present === false) { exact(value, ["present", "raster"]); validateRasterStatus(value.raster, "brand.status.raster"); return; }
    exact(value, ["present", "schemaVersion", "brandDigest", "brandSystemDigest", "domains", "counts", "completeness", "derived", "consumerLock", "export", "raster"]);
    if (value.present !== true || value.schemaVersion !== 1) throw new ValidationError("INVALID_PARAMS", "brand.status identity is invalid.");
    resultDigest(value.brandDigest, "brand.status.brandDigest"); nullableDigest(value.brandSystemDigest, "brand.status.brandSystemDigest");
    for (const [index, rawDomain] of array(value.domains, "brand.status.domains", 16).entries()) { const domain = object(rawDomain, `brand.status.domains[${index}]`); exact(domain, ["domain", "state", "digest"]); string(domain.domain, `brand.status.domains[${index}].domain`, 128); string(domain.state, `brand.status.domains[${index}].state`, 128); nullableDigest(domain.digest, `brand.status.domains[${index}].digest`); }
    const counts = object(value.counts, "brand.status.counts"); exact(counts, ["families", "roles", "variants", "bindings", "requirements", "tokens", "recipes", "qaProfiles", "qaCases", "qaBaselines", "consumerProfiles", "exportProfiles"]); for (const [key, count] of Object.entries(counts)) nonNegativeInteger(count, `brand.status.counts.${key}`, 100_000);
    const completeness = object(value.completeness, "brand.status.completeness"); exact(completeness, ["satisfied", "familyCount", "variantCount", "bindingCount", "requirementCount"]); if (typeof completeness.satisfied !== "boolean") throw new ValidationError("INVALID_PARAMS", "brand.status.completeness is invalid."); for (const key of ["familyCount", "variantCount", "bindingCount", "requirementCount"] as const) nonNegativeInteger(completeness[key], `brand.status.completeness.${key}`, 100_000);
    const derived = object(value.derived, "brand.status.derived"); const derivedStates = ["unchanged", "stale-authority", "missing-target", "human-owned", "target-drift", "invalid-receipt", "ownership-conflict"]; exact(derived, derivedStates); for (const key of derivedStates) nonNegativeInteger(derived[key], `brand.status.derived.${key}`, 100_000);
    const lock = object(value.consumerLock, "brand.status.consumerLock"); exact(lock, ["present", "status", "packages", "profiles", "mappings"]); if (typeof lock.present !== "boolean" || !["ok", "source-unavailable", "stale", "drift", "collision", "invalid"].includes(String(lock.status))) throw new ValidationError("INVALID_PARAMS", "brand.status.consumerLock is invalid."); for (const key of ["packages", "profiles", "mappings"] as const) nonNegativeInteger(lock[key], `brand.status.consumerLock.${key}`, 100_000);
    const exportState = object(value.export, "brand.status.export"); exact(exportState, ["outputs", "receipts"]); nonNegativeInteger(exportState.outputs, "brand.status.export.outputs", 100_000); nonNegativeInteger(exportState.receipts, "brand.status.export.receipts", 100_000); validateRasterStatus(value.raster, "brand.status.raster"); return;
  }
  if (method === "brand.family.list") { validateBrandPage(value, method, validateBrandFamilyItem); return; }
  if (method === "brand.token.list") { validateBrandPage(value, method, validateBrandTokenItem); return; }
  if (method === "brand.qa.profile.list") { validateBrandPage(value, method, (item, name) => { const profile = object(item, `${name} is invalid.`); exact(profile, ["id", "renderer", "formats", "caseCount", "semanticCaseCount", "visualCaseCount", "baselineCaseCount", "qaDigest", "brandSystemDigest"]); id(profile.id, `${name}.id`); if (profile.renderer !== "optional" && profile.renderer !== "required") throw new ValidationError("INVALID_PARAMS", `${name}.renderer is invalid.`); uniqueStrings(profile.formats, `${name}.formats`, 8, string); const caseCount = nonNegativeInteger(profile.caseCount, `${name}.caseCount`, 512), semantic = nonNegativeInteger(profile.semanticCaseCount, `${name}.semanticCaseCount`, 512), visual = nonNegativeInteger(profile.visualCaseCount, `${name}.visualCaseCount`, 512), baseline = nonNegativeInteger(profile.baselineCaseCount, `${name}.baselineCaseCount`, 512); if (caseCount !== semantic + visual || baseline > visual) throw new ValidationError("INVALID_PARAMS", `${name} case counts are inconsistent.`); resultDigest(profile.qaDigest, `${name}.qaDigest`); resultDigest(profile.brandSystemDigest, `${name}.brandSystemDigest`); }); return; }
  if (method === "brand.consumer.profile.list") { validateBrandPage(value, method, (item, name) => { const record = object(item, `${name} is invalid.`); exact(record, ["qualifiedProfileId", "authorityKind", "packageId", "profile", "outputRuleCount", "resolvedOutputCount"]); string(record.qualifiedProfileId, `${name}.qualifiedProfileId`, 256); if (!["producer-project", "producer-package", "consumer-local"].includes(String(record.authorityKind))) throw new ValidationError("INVALID_PARAMS", `${name}.authorityKind is invalid.`); string(record.packageId, `${name}.packageId`, 256); nonNegativeInteger(record.outputRuleCount, `${name}.outputRuleCount`, 512); if (record.resolvedOutputCount !== null) nonNegativeInteger(record.resolvedOutputCount, `${name}.resolvedOutputCount`, 2_048); boundedJson(record.profile); }); return; }
  if (method === "brand.export.status") { validateBrandPage(value, method, validateBrandExportStatusItem); return; }
  if (method === "brand.recipe.graph") { exact(value, ["recipeDigest", "graphDigest", "nodes", "affectedTargetCount", "ownershipConflicts"]); for (const [index, rawNode] of array(value.nodes, "brand.recipe.graph.nodes", 128).entries()) { const node = object(rawNode, `brand.recipe.graph.nodes[${index}]`); exact(node, ["recipeId", "sourceAsset", "targetAsset", "dependencies", "dependents", "operations", "operationDigest", "depth", "targetState", "receiptDigest"]); for (const key of ["recipeId", "sourceAsset", "targetAsset"] as const) id(node[key], `brand.recipe.graph.nodes[${index}].${key}`); uniqueStrings(node.dependencies, `brand.recipe.graph.nodes[${index}].dependencies`, 128, id); uniqueStrings(node.dependents, `brand.recipe.graph.nodes[${index}].dependents`, 128, id); uniqueStrings(node.operations, `brand.recipe.graph.nodes[${index}].operations`, 128, string); resultDigest(node.operationDigest, `brand.recipe.graph.nodes[${index}].operationDigest`); nonNegativeInteger(node.depth, `brand.recipe.graph.nodes[${index}].depth`, 128); string(node.targetState, `brand.recipe.graph.nodes[${index}].targetState`, 128); nullableDigest(node.receiptDigest, `brand.recipe.graph.nodes[${index}].receiptDigest`); } resultDigest(value.recipeDigest, "recipeDigest"); resultDigest(value.graphDigest, "graphDigest"); nonNegativeInteger(value.affectedTargetCount, "affectedTargetCount", 128); nonNegativeInteger(value.ownershipConflicts, "ownershipConflicts", 128); return; }
  if (method === "brand.qa.profile.get") { exact(value, ["profile", "cases", "resolvedTargetCount", "evaluationCount", "qaDigest", "brandSystemDigest", "baselines", "raster"]); boundedJson(value); return; }
  if (method === "brand.qa.result.get") { exact(value, ["schema", "schemaVersion", "profileId", "qaDigest", "brandSystemDigest", "status", "exitCode", "counts", "results", "resultDigest"], ["renderer"]); if (value.schema !== "tfsb.brand-qa-result" || value.schemaVersion !== 1 || !["pass", "fail", "skipped", "unavailable", "error"].includes(String(value.status)) || ![0, 1, 2, 3].includes(value.exitCode as number)) throw new ValidationError("INVALID_PARAMS", "brand.qa.result.get identity is invalid."); id(value.profileId, "profileId"); resultDigest(value.qaDigest, "qaDigest"); resultDigest(value.brandSystemDigest, "brandSystemDigest"); const counts = object(value.counts, "counts"); exact(counts, ["pass", "fail", "skipped", "unavailable", "error"]); for (const [key, count] of Object.entries(counts)) nonNegativeInteger(count, `counts.${key}`, 512); array(value.results, "results", 512); resultDigest(value.resultDigest, "resultDigest"); if (value.renderer !== undefined) { const renderer = object(value.renderer, "renderer"); exact(renderer, ["id", "version", "qualificationId", "platformClaim"]); for (const key of ["id", "version", "qualificationId", "platformClaim"] as const) string(renderer[key], `renderer.${key}`, 256); } boundedJson(value.results); return; }
  if (method === "brand.diff") { exact(value, ["diff", "beforeBindingDigest", "afterBindingDigest", "visualDiff"]); resultDigest(value.beforeBindingDigest, "beforeBindingDigest"); resultDigest(value.afterBindingDigest, "afterBindingDigest"); boundedJson(value); return; }
  if (method === "brand.consumer.lock.status") { exact(value, ["status", "exitCode", "packages", "mappings", "localProfiles"], ["lockDigest", "consumerProjectDigest"]); if (!["ok", "source-unavailable", "stale", "drift", "collision", "invalid"].includes(String(value.status)) || ![0, 1, 2].includes(value.exitCode as number)) throw new ValidationError("INVALID_PARAMS", "brand.consumer.lock.status is invalid."); if (value.lockDigest !== undefined) resultDigest(value.lockDigest, "lockDigest"); if (value.consumerProjectDigest !== undefined) resultDigest(value.consumerProjectDigest, "consumerProjectDigest"); for (const [index, rawPackage] of array(value.packages, "packages", 8).entries()) { const pkg = object(rawPackage, `packages[${index}]`); exact(pkg, ["packageId", "brandVersion", "sourceKind", "profiles"]); string(pkg.packageId, `packages[${index}].packageId`, 256); string(pkg.brandVersion, `packages[${index}].brandVersion`, 128); if (pkg.sourceKind !== "local-bundle" && pkg.sourceKind !== "npm-installed") throw new ValidationError("INVALID_PARAMS", `packages[${index}].sourceKind is invalid.`); boundedJson(pkg.profiles); } for (const [index, rawMapping] of array(value.mappings, "mappings", 2_048).entries()) { const mapping = object(rawMapping, `mappings[${index}]`); exact(mapping, ["packageId", "kind", "sourceId", "destination", "expectedDigest", "current"]); string(mapping.packageId, `mappings[${index}].packageId`, 256); if (mapping.kind !== "asset" && mapping.kind !== "companion") throw new ValidationError("INVALID_PARAMS", `mappings[${index}].kind is invalid.`); string(mapping.sourceId, `mappings[${index}].sourceId`, 256); relative(mapping.destination, `mappings[${index}].destination`, 4_096); resultDigest(mapping.expectedDigest, `mappings[${index}].expectedDigest`); if (!["exact", "missing", "different", "unsafe"].includes(String(mapping.current))) throw new ValidationError("INVALID_PARAMS", `mappings[${index}].current is invalid.`); } uniqueStrings(value.localProfiles, "localProfiles", 32, string); return; }
  if (method === "brand.export.capability") { if (value.available === false) exact(value, ["available"]); else exact(value, ["available", "adapterId", "rendererPackage", "rendererVersion", "rendererBuildDigest", "nodeMajor", "platformClaim", "qualificationId"]); boundedJson(value); return; }
  if (method === "brand.visual.evidence.get") { validateVisualEvidenceResult(value); return; }
  throw new ValidationError("INVALID_PARAMS", "No result validator exists for this method.");
}
