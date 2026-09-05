import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { DiagnosticError, fail } from "../diagnostics.js";
import { computeRawSha256, type Sha256Digest } from "../digests.js";
import { identity, readExactBuffer, readRegularFileSnapshot, sameFileIdentity, type FileIdentity } from "../filesystem.js";
import { loadCanonicalProject, verifyLoadedProjectSnapshot, type LoadedProject } from "../project.js";
import { compareUtf8 } from "../provenance.js";
import { resolveConfinedPath } from "../root.js";
import { serializeProjectToml } from "../toml-writer.js";
import { serializeProjectTomlV2 } from "../schema2-toml.js";
import type { NormalizedProjectV2 } from "../schema2-types.js";
import type { NormalizedProject } from "../types.js";
import { TOOL_VERSION } from "../version.js";
import type { ProjectRelativePath } from "../types.js";
import { findRecoveryResidue } from "../transaction.js";
import { inspectPlanRetention, type PlanRetentionInspection } from "../plan-retention.js";
import {
  computeConsumerProjectDigest,
  createConsumerBrandLock,
  parseConsumerBrandLock,
  type ConsumerBrandLock,
  type ConsumerLockInstalledMapping,
  type ConsumerLockPackage,
  type ConsumerLockSelectedProfile,
} from "./consumer-lock.js";
import {
  computeConsumerProfileDigest,
  isBrandVersionCompatible,
  isProtectedConsumerDestination,
  type ConsumerProfile,
  type ConsumerProfileOutputRule,
} from "./consumer-profile.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import {
  disposeConsumerSources,
  getVerifiedConsumerPackageAuthority,
  getVerifiedConsumerPayload,
  leaseVerifiedConsumerSources,
  revalidateConsumerSources,
  verifyConsumerSources,
  type ConsumerSourceOptions,
  type VerifiedConsumerPackage,
  type VerifiedConsumerPackageAuthority,
  type VerifiedConsumerSources,
} from "./consumer-source.js";

export type ConsumerOperation = "install" | "sync" | "adopt";
export interface ConsumerSelectionOptions extends ConsumerSourceOptions {
  readonly profiles?: readonly string[];
  readonly parameters?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
export interface ConsumerPlanOptions extends ConsumerSelectionOptions { readonly dryRun?: boolean; }

export interface ConsumerPlanOutputSummary {
  readonly kind: "asset" | "companion";
  readonly packageId: string;
  readonly sourceId: string;
  readonly destination: string;
  readonly byteDigest: Sha256Digest;
}
export interface ConsumerPlanSummary {
  readonly operation: ConsumerOperation;
  readonly packages: readonly string[];
  readonly profiles: readonly string[];
  readonly outputs: readonly ConsumerPlanOutputSummary[];
  readonly omittedOptional: readonly string[];
  readonly lockDigest: Sha256Digest;
}
export type ConsumerInstallPlan = ConsumerPlanSummary;
export type ConsumerSyncPlan = ConsumerPlanSummary;
export type ConsumerAdoptionPlan = ConsumerPlanSummary;

export interface ConsumerDestinationSnapshot {
  readonly kind: "absent" | "file";
  readonly identity?: FileIdentity;
  readonly digest?: Sha256Digest;
  readonly bytes?: Uint8Array;
}
export interface ConsumerPlannedOutput {
  readonly mapping: ConsumerLockInstalledMapping;
  readonly packageId: string;
  readonly destination: string;
  readonly absoluteDestination: string;
  readonly bytes: Uint8Array;
  readonly snapshot: ConsumerDestinationSnapshot;
  readonly handle?: FileHandle;
  readonly parentAuthority: ConsumerParentAuthority;
}
export interface ConsumerParentAuthority {
  readonly nearestPath: string;
  readonly nearestIdentity: FileIdentity;
  readonly nearestHandle: FileHandle;
  readonly missingDirectories: readonly string[];
}
export interface ConsumerPlanInternals {
  readonly operation: ConsumerOperation;
  readonly project: LoadedProject;
  readonly sources: VerifiedConsumerSources;
  readonly oldLock?: ConsumerBrandLock;
  readonly nextLock: ConsumerBrandLock;
  readonly outputs: readonly ConsumerPlannedOutput[];
  readonly lockParentAuthority: ConsumerParentAuthority;
  readonly adoptionProjectBytes?: Uint8Array;
  disposed: boolean;
  executed: boolean;
}

const planInternals = new WeakMap<ConsumerPlanSummary, ConsumerPlanInternals>();
const MAX_SELECTED_PROFILES = 8, MAX_OUTPUTS = 512, MAX_COMPANIONS = 64, MAX_ASSETS = 128, MAX_STAGED_BYTES = 256 * 1_048_576;

function unwrapLock(bytes: Uint8Array | undefined): ConsumerBrandLock | undefined {
  if (bytes === undefined) return undefined;
  const parsed = parseConsumerBrandLock(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!parsed.ok) throw new DiagnosticError(parsed.diagnostics[0]!);
  return parsed.value;
}
function sha(bytes: Uint8Array): Sha256Digest { return `sha256:${computeRawSha256(bytes)}`; }
function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = resolve(left), normalizedRight = resolve(right);
  const fromLeft = relative(normalizedLeft, normalizedRight), fromRight = relative(normalizedRight, normalizedLeft);
  const contained = (value: string): boolean => value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
  return contained(fromLeft) || contained(fromRight);
}
function destinationsOverlap(left: string, right: string): boolean {
  const a = left.toLowerCase(), b = right.toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function packageFor(sources: VerifiedConsumerSources, id: string): VerifiedConsumerPackage { const value = sources.packages.find((entry) => entry.packageId === id); if (value === undefined) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_UNAVAILABLE", `No verified source was supplied for package '${id}'.`); return value; }
function outputName(authority: VerifiedConsumerPackageAuthority, assetId: string): string {
  const item = authority.brandManifest.inventory.find((entry) => entry.assetId === assetId);
  if (item === undefined) throw new Error("Verified asset inventory disappeared.");
  return basename(item.bundlePath);
}
function companionName(authority: VerifiedConsumerPackageAuthority, id: string): string {
  const item = authority.packageModel.companions.find((entry) => entry.id === id);
  if (item === undefined) throw new Error("Verified companion inventory disappeared.");
  return item.canonicalCompanionFile;
}

interface ProfileAuthority { readonly profile: ConsumerProfile; readonly package: VerifiedConsumerPackage; readonly privatePackage: VerifiedConsumerPackageAuthority; }
function inventory(project: LoadedProject, sources: VerifiedConsumerSources): Map<string, ProfileAuthority> {
  const result = new Map<string, ProfileAuthority>();
  for (const pkg of sources.packages) for (const profile of pkg.consumerProfiles?.profiles ?? []) {
    const privatePackage = getVerifiedConsumerPackageAuthority(sources, pkg.packageId);
    if (privatePackage === undefined) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", "Verified source authority was lost.");
    if (profile.compatiblePackage !== pkg.packageId) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_PACKAGE_MISMATCH", "Producer profile package identity is inconsistent.");
    if (result.has(profile.qualifiedId)) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_DUPLICATE_IDENTITY", `Duplicate profile '${profile.qualifiedId}'.`);
    result.set(profile.qualifiedId, { profile, package: pkg, privatePackage });
  }
  for (const profile of project.localConsumerProfiles?.profiles ?? []) {
    const pkg = sources.packages.find((entry) => entry.packageId === profile.compatiblePackage);
    if (pkg === undefined) continue;
    const privatePackage = getVerifiedConsumerPackageAuthority(sources, pkg.packageId);
    if (privatePackage === undefined) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", "Verified source authority was lost.");
    if (result.has(profile.qualifiedId)) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_DUPLICATE_IDENTITY", `Local profile conflicts with producer profile '${profile.qualifiedId}'.`);
    result.set(profile.qualifiedId, { profile, package: pkg, privatePackage });
  }
  return result;
}

function resolveProfiles(roots: readonly string[], available: Map<string, ProfileAuthority>): readonly ProfileAuthority[] {
  const selected = new Map<string, ProfileAuthority>(), active = new Set<string>();
  function visit(id: string, depth: number): void {
    if (depth > 4) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_DEPTH_EXCEEDED", "Profile composition depth exceeds four.");
    if (active.has(id)) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_CYCLE", `Profile composition cycle includes '${id}'.`);
    if (selected.has(id)) return;
    const authority = available.get(id); if (authority === undefined) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_NOT_FOUND", `Profile '${id}' was not supplied by verified or local authority.`);
    active.add(id); for (const child of authority.profile.composes) visit(child, depth + 1); active.delete(id);
    selected.set(id, authority); if (selected.size > MAX_SELECTED_PROFILES) fail({ operation: "validate", domain: "brand" }, "RESOURCE_LIMIT_EXCEEDED", "A consumer plan may select at most eight profiles.");
  }
  for (const id of [...new Set(roots)].sort(compareUtf8)) visit(id, 1);
  return Object.freeze([...selected.values()].sort((a, b) => compareUtf8(a.profile.qualifiedId, b.profile.qualifiedId)));
}

function selectedParameters(profile: ConsumerProfile, options: ConsumerSelectionOptions): Readonly<Record<string, string>> {
  const supplied = options.parameters?.[profile.qualifiedId] ?? {};
  const declared = new Map(profile.parameters.map((entry) => [entry.id, entry.values]));
  for (const key of Object.keys(supplied)) if (!declared.has(key)) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_UNKNOWN_PARAMETER", `Unknown parameter '${key}' for '${profile.qualifiedId}'.`);
  const selected: Record<string, string> = {};
  for (const parameter of profile.parameters) {
    const value = supplied[parameter.id]; if (value === undefined) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_MISSING_PARAMETER", `Missing parameter '${parameter.id}' for '${profile.qualifiedId}'.`);
    if (!parameter.values.includes(value)) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_DISALLOWED_PARAMETER", `Parameter '${parameter.id}' value is not allowed.`);
    selected[parameter.id] = value;
  }
  return Object.freeze(selected);
}

interface ResolvedRule { readonly authority: ProfileAuthority; readonly rule: ConsumerProfileOutputRule; readonly mapping: ConsumerLockInstalledMapping; readonly bytes: Uint8Array; }
function resolveRule(authority: ProfileAuthority, rule: ConsumerProfileOutputRule): ResolvedRule | undefined {
  const pkg = authority.package;
  const privatePackage = authority.privatePackage;
  if (!isBrandVersionCompatible(authority.profile, pkg.brandVersion)) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_INCOMPATIBLE", `Profile '${authority.profile.qualifiedId}' is incompatible with brand version '${pkg.brandVersion}'.`);
  let assetId: string | undefined, binding: { family: string; role: string; variant: string } | undefined;
  if (rule.asset !== undefined) assetId = rule.asset;
  else if (rule.family !== undefined) {
    const matches = privatePackage.packageModel.inventory.filter((entry) => entry.family === rule.family && entry.role === rule.role && entry.variant === rule.variant);
    if (matches.length !== 1) { if (rule.requirement === "optional" && matches.length === 0) return undefined; fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_SELECTOR_UNRESOLVED", "Binding selector must resolve exactly once."); }
    assetId = matches[0]!.asset; binding = { family: rule.family, role: rule.role!, variant: rule.variant! };
  }
  if (assetId !== undefined) {
    const matches = privatePackage.packageModel.inventory.filter((entry) => entry.asset === assetId);
    if (matches.length === 0) { if (rule.requirement === "optional") return undefined; fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_SELECTOR_UNRESOLVED", `Required asset '${assetId}' is absent.`); }
    const item = matches[0]!;
    if (matches.some((entry) => entry.canonicalAssetDigest !== item.canonicalAssetDigest || entry.svgDigest !== item.svgDigest)) {
      fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_SELECTOR_UNRESOLVED", `Asset '${assetId}' has ambiguous or inconsistent bindings in package inventory.`);
    }
    const destination = rule.destination ?? `${rule.destinationDirectory}/${rule.filenamePolicy === "asset-id.svg" ? `${assetId}.svg` : outputName(privatePackage, assetId)}`;
    return { authority, rule, bytes: new Uint8Array(), mapping: { kind: "asset", assetId, ...(binding === undefined ? {} : binding), destination, canonicalAssetDigest: item.canonicalAssetDigest, svgDigest: item.svgDigest, installedDigest: item.svgDigest } };
  }
  const companion = privatePackage.packageModel.companions.find((entry) => entry.id === rule.companion);
  if (companion === undefined) { if (rule.requirement === "optional") return undefined; fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_SELECTOR_UNRESOLVED", `Required companion '${rule.companion}' is absent.`); }
  const destination = rule.destination ?? `${rule.destinationDirectory}/${companionName(privatePackage, companion.id)}`;
  return { authority, rule, bytes: new Uint8Array(), mapping: { kind: "companion", companionId: companion.id, purpose: companion.purpose, destination, sourceDigest: companion.digest, installedDigest: companion.digest } };
}

async function snapshotDestination(path: string): Promise<{ snapshot: ConsumerDestinationSnapshot; handle?: FileHandle }> {
  const stat = await lstat(path).catch(() => undefined); if (stat === undefined) return { snapshot: { kind: "absent" } };
  if (stat.isSymbolicLink() || !stat.isFile()) fail({ operation: "validate", domain: "filesystem" }, "CONSUMER_COLLISION", "Consumer destination is not an owned regular file.");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const opened = await handle.stat(); if (!sameFileIdentity(identity(stat), identity(opened))) fail({ operation: "validate", domain: "filesystem" }, "CONSUMER_DESTINATION_CHANGED", "Destination changed during open."); const bytes = await readExactBuffer(handle, opened.size, 0, { operation: "validate", domain: "filesystem" }, 8 * 1_048_576); return { snapshot: { kind: "file", identity: identity(opened), digest: sha(bytes), bytes }, handle }; }
  catch (error) { await handle.close().catch(() => undefined); throw error; }
}

async function snapshotParentAuthority(root: string, destination: string): Promise<ConsumerParentAuthority> {
  const missing: string[] = [];
  let cursor = dirname(destination);
  while (cursor !== root) {
    const stat = await lstat(cursor).catch(() => undefined);
    if (stat !== undefined) break;
    missing.unshift(cursor);
    cursor = dirname(cursor);
  }
  const stat = await lstat(cursor).catch(() => undefined);
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) fail({ operation: "validate", domain: "filesystem" }, "CONSUMER_PARENT_UNSAFE", "Nearest consumer destination ancestor is unsafe.");
  const handle = await open(cursor, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameFileIdentity(identity(stat), identity(opened))) fail({ operation: "validate", domain: "filesystem" }, "CONSUMER_PARENT_CHANGED", "Nearest consumer destination ancestor changed during open.");
    return { nearestPath: cursor, nearestIdentity: identity(opened), nearestHandle: handle, missingDirectories: Object.freeze(missing) };
  } catch (error) { await handle.close().catch(() => undefined); throw error; }
}

function lockProfile(authority: ProfileAuthority, parameters: Readonly<Record<string, string>>): ConsumerLockSelectedProfile { return { id: authority.profile.qualifiedId, version: authority.profile.version, digest: computeConsumerProfileDigest(authority.profile), parameters }; }

function explicitOwnedBytes(project: LoadedProject, mapping: ConsumerLockInstalledMapping): Uint8Array | undefined {
  if (mapping.kind === "asset") {
    const install = project.project.installs.find((entry) => entry.destinations.includes(mapping.destination as ProjectRelativePath));
    const asset = install === undefined ? undefined : project.assets.find((entry) => entry.id === install.asset);
    return asset === undefined ? undefined : project.outputs.get(asset.filename);
  }
  const companion = project.project.companions.find((entry) => entry.destinations.includes(mapping.destination as ProjectRelativePath));
  return companion === undefined ? undefined : project.companions.get(companion.file);
}

async function plan(operation: ConsumerOperation, options: ConsumerPlanOptions, verifiedSources?: VerifiedConsumerSources): Promise<ConsumerPlanSummary> {
  const project = await loadCanonicalProject(options.root ?? process.cwd(), "install");
  const residue = await findRecoveryResidue(project.root);
  if (residue.length > 0) fail({ operation: "install", domain: "transaction" }, "TFSB_RECOVERY_REQUIRED", `Recovery residue requires manual inspection: ${residue.join(", ")}.`, residue[0]);
  const sources = verifiedSources === undefined
    ? await verifyConsumerSources({ root: project.root, ...(options.sourceBundles === undefined ? {} : { sourceBundles: options.sourceBundles }), ...(options.sourcePackages === undefined ? {} : { sourcePackages: options.sourcePackages }) })
    : leaseVerifiedConsumerSources(verifiedSources);
  const opened: FileHandle[] = [];
  try {
    const oldLock = unwrapLock(project.consumerLockBytes);
    let rootProfiles = options.profiles ?? [];
    let parameters = options.parameters;
    if (operation === "sync" && rootProfiles.length === 0) {
      rootProfiles = oldLock?.packages.filter((pkg) => sources.packages.some((source) => source.packageId === pkg.packageId)).flatMap((pkg) => pkg.profiles.map((profile) => profile.id)) ?? [];
      parameters = Object.fromEntries(oldLock?.packages.flatMap((pkg) => pkg.profiles.map((profile) => [profile.id, profile.parameters])) ?? []);
    }
    if (rootProfiles.length === 0) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_REQUIRED", "Consumer operation requires at least one qualified profile.");
    const effectiveOptions = { ...options, ...(parameters === undefined ? {} : { parameters }) };
    const selected = resolveProfiles(rootProfiles, inventory(project, sources));
    const selectedIds = new Set(selected.map((entry) => entry.profile.qualifiedId));
    for (const configured of Object.keys(effectiveOptions.parameters ?? {})) if (!selectedIds.has(configured)) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_UNKNOWN_PARAMETER", `Parameters were supplied for unselected profile '${configured}'.`);
    if (operation === "sync" && sources.packages.some((source) => !oldLock?.packages.some((pkg) => pkg.packageId === source.packageId))) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PACKAGE_NOT_INSTALLED", "Every supplied sync source must map to an installed lock package.");
    const selectedWithParams = selected.map((authority) => ({ authority, parameters: selectedParameters(authority.profile, effectiveOptions) }));
    const resolved: ResolvedRule[] = [], omitted: string[] = [];
    for (const { authority, parameters: values } of selectedWithParams) for (const rule of authority.profile.outputs) {
      if (!rule.when.every((condition) => values[condition.parameter] === condition.equals)) continue;
      const item = resolveRule(authority, rule); if (item === undefined) { omitted.push(`${authority.profile.qualifiedId}:${rule.companion ?? rule.asset ?? `${rule.family}/${rule.role}/${rule.variant}`}`); continue; }
      const kind = item.mapping.kind, sourceId = kind === "asset" ? item.mapping.assetId : item.mapping.companionId;
      const bytes = getVerifiedConsumerPayload(sources, authority.package.packageId, kind, sourceId);
      if (bytes === undefined) { if (rule.requirement === "optional") { omitted.push(`${authority.profile.qualifiedId}:${sourceId}`); continue; } fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_SELECTOR_UNRESOLVED", `Required source '${sourceId}' is unavailable.`); }
      resolved.push({ ...item, bytes, mapping: { ...item.mapping, installedDigest: sha(bytes) } });
    }
    if (resolved.length > MAX_OUTPUTS || resolved.filter((entry) => entry.mapping.kind === "companion").length > MAX_COMPANIONS || new Set(resolved.filter((entry) => entry.mapping.kind === "asset").map((entry) => `${entry.authority.package.packageId}/${entry.mapping.kind === "asset" ? entry.mapping.assetId : ""}`)).size > MAX_ASSETS || resolved.reduce((sum, entry) => sum + entry.bytes.byteLength, 0) > MAX_STAGED_BYTES) fail({ operation: "validate", domain: "brand" }, "RESOURCE_LIMIT_EXCEEDED", "Resolved consumer output limits exceeded.");
    resolved.sort((a, b) => compareUtf8(a.mapping.destination, b.mapping.destination));
    for (let i = 0; i < resolved.length; i++) {
      const destination = resolved[i]!.mapping.destination;
      if (isProtectedConsumerDestination(destination) || resolved.some((entry, j) => j !== i && destinationsOverlap(entry.mapping.destination, destination))) fail({ operation: "validate", domain: "filesystem" }, "CONSUMER_COLLISION", `Consumer destination '${destination}' conflicts or overlaps.`);
      const explicit = [...project.project.installs.flatMap((entry) => entry.destinations), ...project.project.companions.flatMap((entry) => entry.destinations)];
      if (operation !== "adopt" && explicit.some((entry) => destinationsOverlap(entry, destination))) fail({ operation: "validate", domain: "filesystem" }, "CONSUMER_COLLISION", `Consumer destination '${destination}' is explicitly owned.`);
      const resolvedPackageId = resolved[i]!.authority.package.packageId;
      const conflictingLocked = oldLock?.packages.some((pkg) => (operation !== "sync" || pkg.packageId !== resolvedPackageId) && pkg.installed.some((mapping) => destinationsOverlap(mapping.destination, destination))) ?? false;
      if (conflictingLocked) fail({ operation: "validate", domain: "filesystem" }, "CONSUMER_COLLISION", `Consumer destination '${destination}' conflicts with existing lock ownership.`);
    }
    const plannedOutputs: ConsumerPlannedOutput[] = [];
    for (const entry of resolved) {
      const absoluteDestination = await resolveConfinedPath(project.root, entry.mapping.destination as ProjectRelativePath, "install", { allowFinalSymlink: true });
      const sourceAuthority = entry.authority.privatePackage;
      if (pathsOverlap(absoluteDestination, project.buildDirectory) || pathsOverlap(absoluteDestination, sourceAuthority.archivePath) || (sourceAuthority.npmRootPath !== undefined && pathsOverlap(absoluteDestination, sourceAuthority.npmRootPath))) {
        fail({ operation: "validate", domain: "filesystem" }, "CONSUMER_DESTINATION_PROTECTED", `Consumer destination '${entry.mapping.destination}' overlaps protected build or source authority.`);
      }
      const oldMapping = oldLock?.packages.find((pkg) => pkg.packageId === entry.authority.package.packageId)?.installed.find((mapping) => mapping.destination === entry.mapping.destination);
      if (operation === "sync" && oldMapping === undefined && entry.rule.requirement === "optional") { omitted.push(`${entry.authority.profile.qualifiedId}:${entry.mapping.destination}`); continue; }
      const { snapshot, handle } = await snapshotDestination(absoluteDestination); if (handle !== undefined) opened.push(handle);
      const parentAuthority = await snapshotParentAuthority(project.root, absoluteDestination); opened.push(parentAuthority.nearestHandle);
      if (operation === "install" && snapshot.kind !== "absent") fail({ operation: "validate", domain: "filesystem" }, "CONSUMER_COLLISION", `Install destination '${entry.mapping.destination}' already exists.`);
      if (operation === "sync" && oldMapping !== undefined && (snapshot.kind !== "file" || snapshot.digest !== oldMapping.installedDigest)) fail({ operation: "validate", domain: "filesystem" }, "CONSUMER_DRIFT", `Locked destination '${entry.mapping.destination}' drifted.`);
      if (operation === "sync" && oldMapping === undefined && snapshot.kind !== "absent") fail({ operation: "validate", domain: "filesystem" }, "CONSUMER_COLLISION", `New sync destination '${entry.mapping.destination}' already exists without lock ownership.`);
      if (operation === "adopt") {
        const explicit = [...project.project.installs.flatMap((install) => install.destinations), ...project.project.companions.flatMap((companion) => companion.destinations)];
        const explicitBytes = explicitOwnedBytes(project, entry.mapping);
        if (!explicit.includes(entry.mapping.destination as ProjectRelativePath) || explicitBytes === undefined || sha(explicitBytes) !== sha(entry.bytes) || snapshot.kind !== "file" || snapshot.digest !== sha(entry.bytes)) fail({ operation: "validate", domain: "filesystem" }, "CONSUMER_ADOPTION_MISMATCH", `Adoption destination '${entry.mapping.destination}' is not exact explicit ownership.`);
      }
      plannedOutputs.push({ mapping: entry.mapping, packageId: entry.authority.package.packageId, destination: entry.mapping.destination, absoluteDestination, bytes: Buffer.from(entry.bytes), snapshot, parentAuthority, ...(handle === undefined ? {} : { handle }) });
    }
    if (operation === "adopt" && plannedOutputs.length !== resolved.length) fail({ operation: "validate", domain: "brand" }, "CONSUMER_ADOPTION_INCOMPLETE", "Adoption requires every resolved output with no omission.");
    const updatedPackages = new Map(oldLock?.packages.map((pkg) => [pkg.packageId, pkg]) ?? []);
    for (const pkg of sources.packages) {
      const packageProfiles = selectedWithParams.filter((entry) => entry.authority.package.packageId === pkg.packageId).map((entry) => lockProfile(entry.authority, entry.parameters)).sort((a, b) => compareUtf8(a.id, b.id));
      if (packageProfiles.length === 0) continue;
      if ((operation === "install" || operation === "adopt") && updatedPackages.has(pkg.packageId)) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PACKAGE_ALREADY_INSTALLED", `Package '${pkg.packageId}' is already installed.`);
      if (operation === "sync" && !updatedPackages.has(pkg.packageId)) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PACKAGE_NOT_INSTALLED", `Package '${pkg.packageId}' is not installed.`);
      const oldPackage = updatedPackages.get(pkg.packageId), mappings = plannedOutputs.filter((entry) => entry.packageId === pkg.packageId).map((entry) => entry.mapping);
      if (operation === "sync" && oldPackage !== undefined) {
        const newDestinations = new Set(mappings.map((entry) => entry.destination));
        if (oldPackage.installed.some((entry) => !newDestinations.has(entry.destination))) fail({ operation: "validate", domain: "brand" }, "CONSUMER_REMOVAL_REQUIRES_UNINSTALL", "Sync would remove an installed destination.");
      }
      const privatePackage = getVerifiedConsumerPackageAuthority(sources, pkg.packageId);
      if (privatePackage === undefined) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", "Verified source authority was lost.");
      const domain = privatePackage.brandManifest.domainDigests;
      const record: ConsumerLockPackage = { packageId: pkg.packageId, brandVersion: pkg.brandVersion, source: pkg.source, genericManifestByteDigest: pkg.source.genericManifestByteDigest, brandManifestDigest: pkg.source.brandManifestDigest, brandSystemDigest: pkg.brandSystemDigest, tokenDigest: domain.tokens ?? null, recipeDigest: domain.recipes ?? null, qaDigest: domain.qa ?? null, consumerProfileDigest: domain.consumer_profiles ?? null, exportDigest: domain.exports ?? null, brandPackageDigest: pkg.brandPackageDigest, profiles: Object.freeze(packageProfiles), installed: Object.freeze(mappings) };
      updatedPackages.set(pkg.packageId, Object.freeze(record));
    }
    const adoptedDestinations = new Set(plannedOutputs.map((entry) => entry.destination));
    const adoptionProject = operation === "adopt" ? {
      ...project.project,
      installs: project.project.installs.map((entry) => ({ ...entry, destinations: entry.destinations.filter((destination) => !adoptedDestinations.has(destination)) })).filter((entry) => entry.destinations.length > 0),
      companions: project.project.companions.map((entry) => ({ ...entry, destinations: entry.destinations.filter((destination) => !adoptedDestinations.has(destination)) })).filter((entry) => entry.destinations.length > 0),
    } : undefined;
    const consumerProjectDigest = computeConsumerProjectDigest(adoptionProject ?? project.project, project.localConsumerProfiles ?? null);
    const nextLock = createConsumerBrandLock({ schema: "tfsb.brand-lock", schemaVersion: 1, consumerProjectDigest, packages: Object.freeze([...updatedPackages.values()].sort((a, b) => compareUtf8(a.packageId, b.packageId))), toolVersion: TOOL_VERSION });
    await revalidateConsumerSources(sources); await verifyLoadedProjectSnapshot(project, "install");
    const lockParentAuthority = await snapshotParentAuthority(project.root, join(project.root, ".tfsb", "brand.lock.json")); opened.push(lockParentAuthority.nearestHandle);
    const summary = Object.freeze({ operation, packages: Object.freeze(sources.packages.map((entry) => entry.packageId).sort(compareUtf8)), profiles: Object.freeze(selected.map((entry) => entry.profile.qualifiedId)), outputs: Object.freeze(plannedOutputs.map((entry) => Object.freeze({ kind: entry.mapping.kind, packageId: entry.packageId, sourceId: entry.mapping.kind === "asset" ? entry.mapping.assetId : entry.mapping.companionId, destination: entry.destination, byteDigest: sha(entry.bytes) }))), omittedOptional: Object.freeze(omitted.sort(compareUtf8)), lockDigest: nextLock.lockDigest });
    let adoptionProjectBytes: Uint8Array | undefined;
    if (adoptionProject !== undefined) {
      const text = adoptionProject.schemaVersion === 1 ? serializeProjectToml(adoptionProject as NormalizedProject) : serializeProjectTomlV2(adoptionProject as NormalizedProjectV2);
      adoptionProjectBytes = Buffer.from(text, "utf8");
    }
    planInternals.set(summary, { operation, project, sources, ...(oldLock === undefined ? {} : { oldLock }), nextLock, outputs: Object.freeze(plannedOutputs), lockParentAuthority, ...(adoptionProjectBytes === undefined ? {} : { adoptionProjectBytes }), disposed: false, executed: false });
    return summary;
  } catch (error) { for (const handle of opened) await handle.close().catch(() => undefined); await disposeConsumerSources(sources); throw error; }
}

export function getConsumerPlanInternals(plan: ConsumerPlanSummary): ConsumerPlanInternals | undefined { return planInternals.get(plan); }
export async function planConsumerInstall(options: ConsumerPlanOptions): Promise<ConsumerInstallPlan> { return plan("install", options); }
export async function planConsumerSync(options: ConsumerPlanOptions): Promise<ConsumerSyncPlan> { return plan("sync", options); }
export async function planConsumerAdoption(options: ConsumerPlanOptions): Promise<ConsumerAdoptionPlan> { return plan("adopt", options); }
/** Internal Studio seam: authority comes from retained source-handle leases, never paths. */
export async function planConsumerInstallWithVerifiedSources(options: Omit<ConsumerPlanOptions, "sourceBundles" | "sourcePackages">, sources: VerifiedConsumerSources): Promise<ConsumerInstallPlan> { return plan("install", options, sources); }
/** Internal Studio seam: authority comes from retained source-handle leases, never paths. */
export async function planConsumerSyncWithVerifiedSources(options: Omit<ConsumerPlanOptions, "sourceBundles" | "sourcePackages">, sources: VerifiedConsumerSources): Promise<ConsumerSyncPlan> { return plan("sync", options, sources); }
export async function disposeConsumerPlan(plan: ConsumerPlanSummary): Promise<void> { const internals = planInternals.get(plan); if (internals === undefined || internals.disposed) return; internals.disposed = true; for (const output of internals.outputs) { await output.handle?.close().catch(() => undefined); await output.parentAuthority.nearestHandle.close().catch(() => undefined); } await internals.lockParentAuthority.nearestHandle.close().catch(() => undefined); await disposeConsumerSources(internals.sources); }
/** Internal Studio retention seam; not re-exported from the package root. */
export function inspectConsumerPlanRetention(plan: ConsumerPlanSummary): PlanRetentionInspection { const internals = planInternals.get(plan); if (internals === undefined) throw new Error("Consumer plan was not produced by this planner instance."); return inspectPlanRetention([plan, internals]); }

export type ConsumerStateStatus = "ok" | "source-unavailable" | "stale" | "drift" | "collision" | "invalid";
export interface ConsumerStateMapping {
  readonly packageId: string;
  readonly kind: "asset" | "companion";
  readonly sourceId: string;
  readonly destination: string;
  readonly expectedDigest: Sha256Digest;
  readonly current: "exact" | "missing" | "different" | "unsafe";
}
export interface ConsumerStateInspection {
  readonly status: ConsumerStateStatus;
  readonly exitCode: 0 | 1 | 2;
  readonly lockDigest?: Sha256Digest;
  readonly consumerProjectDigest?: Sha256Digest;
  readonly packages: readonly { readonly packageId: string; readonly brandVersion: string; readonly sourceKind: "local-bundle" | "npm-installed"; readonly profiles: readonly ConsumerLockSelectedProfile[] }[];
  readonly mappings: readonly ConsumerStateMapping[];
  readonly localProfiles: readonly string[];
}

function state(status: ConsumerStateStatus, partial: Omit<ConsumerStateInspection, "status" | "exitCode">): ConsumerStateInspection {
  return Object.freeze({ status, exitCode: status === "ok" || status === "source-unavailable" ? 0 : status === "invalid" ? 1 : 2, ...partial });
}

function validateLockedResolution(project: LoadedProject, lock: ConsumerBrandLock, sources: VerifiedConsumerSources): ConsumerStateStatus | undefined {
  for (const source of sources.packages) {
    const pkg = lock.packages.find((entry) => entry.packageId === source.packageId);
    if (pkg === undefined || pkg.brandVersion !== source.brandVersion || pkg.brandManifestDigest !== source.source.brandManifestDigest || pkg.genericManifestByteDigest !== source.source.genericManifestByteDigest) return "stale";
  }
  if (lock.packages.some((pkg) => !sources.packages.some((source) => source.packageId === pkg.packageId))) return "source-unavailable";

  let available: Map<string, ProfileAuthority>;
  try { available = inventory(project, sources); }
  catch { return "invalid"; }
  const lockedProfiles = new Map(lock.packages.flatMap((pkg) => pkg.profiles.map((profile) => [profile.id, { packageId: pkg.packageId, profile }] as const)));
  if (lockedProfiles.size !== lock.packages.reduce((count, pkg) => count + pkg.profiles.length, 0)) return "invalid";
  for (const [id, locked] of lockedProfiles) {
    const authority = available.get(id);
    if (authority === undefined || authority.package.packageId !== locked.packageId || authority.profile.version !== locked.profile.version || computeConsumerProfileDigest(authority.profile) !== locked.profile.digest || !isBrandVersionCompatible(authority.profile, authority.package.brandVersion)) return "stale";
    try { selectedParameters(authority.profile, { parameters: { [id]: locked.profile.parameters } }); }
    catch { return "invalid"; }
  }

  let selected: readonly ProfileAuthority[];
  try { selected = resolveProfiles([...lockedProfiles.keys()], available); }
  catch { return "invalid"; }
  if (selected.length !== lockedProfiles.size || selected.some((entry) => !lockedProfiles.has(entry.profile.qualifiedId))) return "invalid";

  const expected: { readonly packageId: string; readonly required: boolean; readonly mapping: ConsumerLockInstalledMapping }[] = [];
  try {
    for (const authority of selected) {
      const locked = lockedProfiles.get(authority.profile.qualifiedId)!;
      const parameters = selectedParameters(authority.profile, { parameters: { [authority.profile.qualifiedId]: locked.profile.parameters } });
      for (const rule of authority.profile.outputs) {
        if (!rule.when.every((condition) => parameters[condition.parameter] === condition.equals)) continue;
        const resolved = resolveRule(authority, rule);
        if (resolved === undefined) continue;
        const sourceId = resolved.mapping.kind === "asset" ? resolved.mapping.assetId : resolved.mapping.companionId;
        const bytes = getVerifiedConsumerPayload(sources, authority.package.packageId, resolved.mapping.kind, sourceId);
        if (bytes === undefined) { if (rule.requirement === "required") return "invalid"; continue; }
        expected.push({ packageId: authority.package.packageId, required: rule.requirement === "required", mapping: { ...resolved.mapping, installedDigest: sha(bytes) } });
      }
    }
  } catch { return "invalid"; }
  for (let index = 0; index < expected.length; index++) {
    if (expected.some((entry, other) => other !== index && destinationsOverlap(entry.mapping.destination, expected[index]!.mapping.destination))) return "collision";
  }
  const expectedKeys = new Map(expected.map((entry) => [`${entry.packageId}\0${encodeCanonicalJson(entry.mapping)}`, entry]));
  const actualKeys = new Set(lock.packages.flatMap((pkg) => pkg.installed.map((mapping) => `${pkg.packageId}\0${encodeCanonicalJson(mapping)}`)));
  if (lock.packages.some((pkg) => pkg.installed.some((mapping) => !expectedKeys.has(`${pkg.packageId}\0${encodeCanonicalJson(mapping)}`)))) return "invalid";
  if (expected.some((entry) => entry.required && !actualKeys.has(`${entry.packageId}\0${encodeCanonicalJson(entry.mapping)}`))) return "invalid";
  return undefined;
}

async function inspectState(options: ConsumerSourceOptions, verifiedSources?: VerifiedConsumerSources): Promise<ConsumerStateInspection> {
  let project: LoadedProject;
  try { project = await loadCanonicalProject(options.root ?? process.cwd(), "check"); }
  catch { return state("invalid", { packages: Object.freeze([]), mappings: Object.freeze([]), localProfiles: Object.freeze([]) }); }
  const localProfiles = Object.freeze((project.localConsumerProfiles?.profiles ?? []).map((entry) => entry.qualifiedId).sort(compareUtf8));
  if (project.consumerLockBytes === undefined) return state("ok", { packages: Object.freeze([]), mappings: Object.freeze([]), localProfiles });
  let lock: ConsumerBrandLock;
  try { const parsed = unwrapLock(project.consumerLockBytes); if (parsed === undefined) return state("invalid", { packages: Object.freeze([]), mappings: Object.freeze([]), localProfiles }); lock = parsed; }
  catch { return state("invalid", { packages: Object.freeze([]), mappings: Object.freeze([]), localProfiles }); }
  const packages = Object.freeze(lock.packages.map((pkg) => Object.freeze({ packageId: pkg.packageId, brandVersion: pkg.brandVersion, sourceKind: pkg.source.kind, profiles: pkg.profiles })).sort((a, b) => compareUtf8(a.packageId, b.packageId)));
  const mappings: ConsumerStateMapping[] = [];
  let drift = false, collision = false;
  for (const pkg of lock.packages) for (const mapping of pkg.installed) {
    const absolute = join(project.root, ...mapping.destination.split("/"));
    const entry = await lstat(absolute).catch(() => undefined);
    let current: ConsumerStateMapping["current"];
    if (entry === undefined) { current = "missing"; drift = true; }
    else if (entry.isSymbolicLink() || !entry.isFile()) { current = "unsafe"; collision = true; }
    else {
      try { const opened = await readRegularFileSnapshot(absolute, { operation: "check", domain: "filesystem" }, "CONSUMER_DESTINATION_CHANGED", "Consumer destination changed during inspection.", 8 * 1_048_576); current = sha(opened.bytes) === mapping.installedDigest ? "exact" : "different"; if (current === "different") drift = true; }
      catch { current = "unsafe"; collision = true; }
    }
    const explicit = [...project.project.installs.flatMap((install) => install.destinations), ...project.project.companions.flatMap((companion) => companion.destinations)];
    if (explicit.some((destination) => destinationsOverlap(destination, mapping.destination))) collision = true;
    mappings.push(Object.freeze({ packageId: pkg.packageId, kind: mapping.kind, sourceId: mapping.kind === "asset" ? mapping.assetId : mapping.companionId, destination: mapping.destination, expectedDigest: mapping.installedDigest, current }));
  }
  mappings.sort((a, b) => compareUtf8(a.destination, b.destination));
  const partial = { lockDigest: lock.lockDigest, consumerProjectDigest: lock.consumerProjectDigest, packages, mappings: Object.freeze(mappings), localProfiles };
  if (collision) return state("collision", partial);
  if (drift) return state("drift", partial);
  if (computeConsumerProjectDigest(project.project, project.localConsumerProfiles ?? null) !== lock.consumerProjectDigest) return state("stale", partial);
  const hasSources = verifiedSources !== undefined || (options.sourceBundles?.length ?? 0) + (options.sourcePackages?.length ?? 0) > 0;
  if (!hasSources) return state("source-unavailable", partial);
  let sources: VerifiedConsumerSources | undefined;
  try {
    sources = verifiedSources === undefined
      ? await verifyConsumerSources({ root: project.root, ...(options.sourceBundles === undefined ? {} : { sourceBundles: options.sourceBundles }), ...(options.sourcePackages === undefined ? {} : { sourcePackages: options.sourcePackages }) })
      : leaseVerifiedConsumerSources(verifiedSources);
    const sourceStatus = validateLockedResolution(project, lock, sources);
    if (sourceStatus !== undefined) return state(sourceStatus, partial);
    return state("ok", partial);
  } catch { return state("invalid", partial); }
  finally { if (sources !== undefined) await disposeConsumerSources(sources); }
}

export async function inspectConsumerState(options: ConsumerSourceOptions = {}): Promise<ConsumerStateInspection> {
  return inspectState(options);
}

/** Internal Studio seam for authentic retained source-handle authority. */
export async function inspectConsumerStateWithVerifiedSources(root: string, sources: VerifiedConsumerSources): Promise<ConsumerStateInspection> {
  return inspectState({ root }, sources);
}
