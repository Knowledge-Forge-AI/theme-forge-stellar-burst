import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { DiagnosticError, fail } from "../diagnostics.js";
import { computeRawSha256, type Sha256Digest } from "../digests.js";
import { identity, readExactBuffer, sameFileIdentity, type FileIdentity } from "../filesystem.js";
import { compareUtf8 } from "../provenance.js";
import { serializeSvgV2 } from "../schema2-svg.js";
import {
  disposeBrandImportPlan,
  getRetainedBrandImportDiffSnapshot,
  getRetainedBrandImportVisualAsset,
  readRetainedBrandArchiveCompanion,
  retainVerifiedBrandArchive,
  revalidateRetainedBrandArchive,
  type BrandImportPlan,
} from "./brand-import.js";
import type { BrandDiffSnapshot } from "./brand-diff.js";
import type { BrandBundleManifest } from "./brand-bundle-manifest.js";
import type { BrandPackageModel } from "./brand-package.js";
import { parseDuplicateFreeJson, type ConsumerLockSource } from "./consumer-lock.js";
import type { ConsumerProfilesModel } from "./consumer-profile.js";

export const CONSUMER_SOURCE_MAX_PACKAGES = 8;
export const CONSUMER_SOURCE_MAX_PAYLOAD_BYTES = 8 * 1_048_576;
export const CONSUMER_SOURCE_MAX_AGGREGATE_BYTES = 32 * 1_048_576;
const PACKAGE_JSON_MAX_BYTES = 64 * 1024;

export interface ConsumerSourceOptions {
  readonly root?: string;
  readonly sourceBundles?: readonly string[];
  readonly sourcePackages?: readonly string[];
}

export interface VerifiedConsumerPackage {
  readonly packageId: string;
  readonly brandVersion: string;
  readonly source: ConsumerLockSource;
  readonly brandSystemDigest: Sha256Digest;
  readonly brandPackageDigest: Sha256Digest;
  readonly consumerProfilesDigest: Sha256Digest;
  readonly consumerProfiles?: ConsumerProfilesModel;
  readonly assetIds: readonly string[];
  readonly companionIds: readonly string[];
}

export interface VerifiedConsumerSources {
  readonly packages: readonly VerifiedConsumerPackage[];
}

export type ConsumerSourceCarrier =
  | { readonly kind: "brand-bundle"; readonly path: string }
  | { readonly kind: "npm-installed-package"; readonly path: string };

interface NpmAuthority {
  readonly rootPath: string;
  readonly rootHandle: FileHandle;
  readonly rootIdentity: FileIdentity;
  readonly packageJsonPath: string;
  readonly packageJsonHandle: FileHandle;
  readonly packageJsonIdentity: FileIdentity;
  readonly packageJsonDigest: string;
  readonly brandDirectoryPath: string;
  readonly brandDirectoryHandle: FileHandle;
  readonly brandDirectoryIdentity: FileIdentity;
}
interface PackageAuthority {
  readonly plan: BrandImportPlan;
  readonly packageModel: BrandPackageModel;
  readonly brandManifest: BrandBundleManifest;
  readonly assets: ReadonlyMap<string, Uint8Array>;
  readonly companions: ReadonlyMap<string, Uint8Array>;
  readonly selectedBytes: number;
  readonly npm?: NpmAuthority;
}
interface SharedSourceAuthority {
  references: number;
  disposed: boolean;
  readonly packages: ReadonlyMap<string, PackageAuthority>;
}
interface SourceAuthority {
  released: boolean;
  readonly shared: readonly SharedSourceAuthority[];
  readonly packages: ReadonlyMap<string, PackageAuthority>;
}
const authorities = new WeakMap<VerifiedConsumerSources, SourceAuthority>();

function requireAuthority(sources: VerifiedConsumerSources): SourceAuthority {
  const authority = authorities.get(sources);
  if (authority === undefined || authority.released || authority.shared.some((entry) => entry.disposed)) {
    fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", "Consumer source authority is not authentic or was disposed.");
  }
  return authority;
}

function retainShared(shared: readonly SharedSourceAuthority[]): void {
  for (const entry of shared) {
    if (entry.disposed) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", "Consumer source authority is not authentic or was disposed.");
    entry.references += 1;
  }
}

async function releaseShared(shared: SharedSourceAuthority): Promise<void> {
  if (shared.references > 0) shared.references -= 1;
  if (shared.references !== 0 || shared.disposed) return;
  shared.disposed = true;
  for (const item of shared.packages.values()) {
    await disposeBrandImportPlan(item.plan).catch(() => undefined);
    if (item.npm !== undefined) {
      await item.npm.brandDirectoryHandle.close().catch(() => undefined);
      await item.npm.packageJsonHandle.close().catch(() => undefined);
      await item.npm.rootHandle.close().catch(() => undefined);
    }
  }
}

function digest(bytes: Uint8Array): Sha256Digest { return `sha256:${computeRawSha256(bytes)}`; }
function unwrapSvg(result: ReturnType<typeof serializeSvgV2>): Uint8Array {
  if (!result.ok) throw new DiagnosticError(result.diagnostics[0]!);
  return Buffer.from(result.value, "utf8");
}

async function openNpmAuthority(input: string): Promise<{ readonly authority: NpmAuthority; readonly name: string; readonly version: string; readonly bundle: string }> {
  const inputPath = resolve(input), inputStat = await lstat(inputPath).catch(() => undefined);
  if (inputStat === undefined || inputStat.isSymbolicLink() || !inputStat.isDirectory()) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", "Installed package root must be a real non-symlink directory.");
  const rootPath = await realpath(inputPath), rootHandle = await open(rootPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const rootIdentity = identity(await rootHandle.stat());
    if (!sameFileIdentity(identity(inputStat), rootIdentity)) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_CHANGED", "Installed package root changed during open.");
    const packageJsonPath = join(rootPath, "package.json"), packageJsonStat = await lstat(packageJsonPath).catch(() => undefined);
    if (packageJsonStat === undefined || packageJsonStat.isSymbolicLink() || !packageJsonStat.isFile() || packageJsonStat.size > PACKAGE_JSON_MAX_BYTES) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", "Installed package package.json must be a bounded regular non-symlink file.");
    const packageJsonHandle = await open(packageJsonPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let brandDirectoryHandle: FileHandle | undefined;
    try {
      const opened = await packageJsonHandle.stat();
      if (!sameFileIdentity(identity(packageJsonStat), identity(opened))) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_CHANGED", "package.json changed during open.");
      const bytes = await readExactBuffer(packageJsonHandle, opened.size, 0, { operation: "validate", domain: "brand" }, PACKAGE_JSON_MAX_BYTES);
      let parsed: unknown; try { parsed = parseDuplicateFreeJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { operation: "validate", domain: "brand" }); } catch { fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", "package.json must be valid bounded duplicate-free UTF-8 JSON."); }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", "package.json must be an object.");
      const name = (parsed as Record<string, unknown>).name, version = (parsed as Record<string, unknown>).version;
      if (typeof name !== "string" || typeof version !== "string") fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", "package.json must contain exact name and version strings.");
      const brandDirectoryPath = join(rootPath, "brand"), brandDirectoryStat = await lstat(brandDirectoryPath).catch(() => undefined);
      if (brandDirectoryStat === undefined || brandDirectoryStat.isSymbolicLink() || !brandDirectoryStat.isDirectory()) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", "Installed package brand carrier must be a real non-symlink directory.");
      brandDirectoryHandle = await open(brandDirectoryPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const brandDirectoryOpened = await brandDirectoryHandle.stat();
      if (!sameFileIdentity(identity(brandDirectoryStat), identity(brandDirectoryOpened))) { await brandDirectoryHandle.close(); fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_CHANGED", "Installed package brand carrier changed during open."); }
      const bundle = join(brandDirectoryPath, "tfsb-brand-bundle.zip"), bundleStat = await lstat(bundle).catch(() => undefined);
      if (bundleStat === undefined || bundleStat.isSymbolicLink() || !bundleStat.isFile()) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", "Installed package lacks fixed brand/tfsb-brand-bundle.zip carrier.");
      return { authority: { rootPath, rootHandle, rootIdentity, packageJsonPath, packageJsonHandle, packageJsonIdentity: identity(opened), packageJsonDigest: computeRawSha256(bytes), brandDirectoryPath, brandDirectoryHandle, brandDirectoryIdentity: identity(brandDirectoryOpened) }, name, version, bundle };
    } catch (error) { await brandDirectoryHandle?.close().catch(() => undefined); await packageJsonHandle.close().catch(() => undefined); throw error; }
  } catch (error) { await rootHandle.close().catch(() => undefined); throw error; }
}

async function createPackage(plan: BrandImportPlan, kind: "local-bundle" | "npm-installed", npm?: { authority: NpmAuthority; name: string; version: string }): Promise<{ summary: VerifiedConsumerPackage; authority: PackageAuthority }> {
  const { packageModel, brandManifest } = plan;
  if (packageModel.consumerProfileDigest === undefined || plan.brandManifest.profiles.length === 0) fail({ operation: "validate", domain: "brand" }, "CONSUMER_PROFILE_SOURCE_UNAVAILABLE", "Verified package has no available consumer profile authority.");
  if (kind === "npm-installed") {
    if (npm === undefined || packageModel.npmPackage === undefined || packageModel.npmPackage.name !== npm.name || packageModel.npmPackage.version !== npm.version) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_NPM_MISMATCH", "Installed package name/version does not match brand package authority.");
  }
  const assets = new Map<string, Uint8Array>();
  let aggregate = 0;
  for (const asset of plan.assets) {
    const bytes = unwrapSvg(serializeSvgV2(asset.svg, `.tfsb/assets/${asset.id}.toml`));
    if (bytes.byteLength > CONSUMER_SOURCE_MAX_PAYLOAD_BYTES) fail({ operation: "validate", domain: "brand" }, "RESOURCE_LIMIT_EXCEEDED", "Selected source payload exceeds 8 MiB.");
    aggregate += bytes.byteLength; assets.set(asset.id, bytes);
  }
  const companions = new Map<string, Uint8Array>();
  for (const record of packageModel.companions) {
    const bytes = readRetainedBrandArchiveCompanion(plan, record.id);
    if (bytes === undefined) { if (record.required) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", `Required companion '${record.id}' is absent.`); continue; }
    if (bytes.byteLength > CONSUMER_SOURCE_MAX_PAYLOAD_BYTES) fail({ operation: "validate", domain: "brand" }, "RESOURCE_LIMIT_EXCEEDED", "Selected source payload exceeds 8 MiB.");
    aggregate += bytes.byteLength; companions.set(record.id, bytes);
  }
  if (aggregate > CONSUMER_SOURCE_MAX_AGGREGATE_BYTES) fail({ operation: "validate", domain: "brand" }, "RESOURCE_LIMIT_EXCEEDED", "Aggregate distinct selected source payload exceeds 32 MiB.");
  const source: ConsumerLockSource = kind === "local-bundle"
    ? { kind, packageId: packageModel.packageId, brandVersion: packageModel.brandVersion, genericManifestByteDigest: brandManifest.genericManifestByteDigest, brandManifestDigest: brandManifest.brandManifestDigest }
    : { kind, packageId: packageModel.packageId, brandVersion: packageModel.brandVersion, genericManifestByteDigest: brandManifest.genericManifestByteDigest, brandManifestDigest: brandManifest.brandManifestDigest, npmName: npm!.name, npmVersion: npm!.version };
  const consumerProfiles = plan.consumerProfilesModel;
  const summary = Object.freeze({ packageId: packageModel.packageId, brandVersion: packageModel.brandVersion, source: Object.freeze(source), brandSystemDigest: brandManifest.brandSystemDigest, brandPackageDigest: brandManifest.brandPackageDigest, consumerProfilesDigest: packageModel.consumerProfileDigest, ...(consumerProfiles === undefined ? {} : { consumerProfiles }), assetIds: Object.freeze([...assets.keys()].sort(compareUtf8)), companionIds: Object.freeze([...companions.keys()].sort(compareUtf8)) });
  return { summary, authority: { plan, packageModel, brandManifest, assets, companions, selectedBytes: aggregate, ...(npm === undefined ? {} : { npm: npm.authority }) } };
}

export async function verifyConsumerSources(options: ConsumerSourceOptions): Promise<VerifiedConsumerSources> {
  const root = await realpath(options.root ?? process.cwd());
  const candidates: { summary: VerifiedConsumerPackage; authority: PackageAuthority }[] = [];
  try {
    for (const archive of options.sourceBundles ?? []) candidates.push(await createPackage(await retainVerifiedBrandArchive({ archive, root }), "local-bundle"));
    for (const directory of options.sourcePackages ?? []) {
      const npm = await openNpmAuthority(directory);
      try { candidates.push(await createPackage(await retainVerifiedBrandArchive({ archive: npm.bundle, root }), "npm-installed", npm)); }
      catch (error) { await npm.authority.brandDirectoryHandle.close().catch(() => undefined); await npm.authority.packageJsonHandle.close().catch(() => undefined); await npm.authority.rootHandle.close().catch(() => undefined); throw error; }
    }
    const byPackage = new Map<string, { summary: VerifiedConsumerPackage; authority: PackageAuthority }>();
    for (const candidate of candidates) {
      const previous = byPackage.get(candidate.summary.packageId);
      if (previous !== undefined) {
        if (JSON.stringify(previous.summary.source) !== JSON.stringify(candidate.summary.source)) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_CONFLICT", `Competing source identities for package '${candidate.summary.packageId}'.`);
        await disposeBrandImportPlan(candidate.authority.plan);
        if (candidate.authority.npm !== undefined) { await candidate.authority.npm.brandDirectoryHandle.close(); await candidate.authority.npm.packageJsonHandle.close(); await candidate.authority.npm.rootHandle.close(); }
      } else byPackage.set(candidate.summary.packageId, candidate);
    }
    if (byPackage.size < 1 || byPackage.size > CONSUMER_SOURCE_MAX_PACKAGES) fail({ operation: "validate", domain: "brand" }, "RESOURCE_LIMIT_EXCEEDED", "Consumer operations require 1..8 verified source packages.");
    if ([...byPackage.values()].reduce((sum, entry) => sum + entry.authority.selectedBytes, 0) > CONSUMER_SOURCE_MAX_AGGREGATE_BYTES) fail({ operation: "validate", domain: "brand" }, "RESOURCE_LIMIT_EXCEEDED", "Aggregate distinct selected source payload exceeds 32 MiB.");
    const packages = [...byPackage.values()].map((entry) => entry.summary).sort((a, b) => compareUtf8(a.packageId, b.packageId));
    const result = Object.freeze({ packages: Object.freeze(packages) });
    const packageAuthorities = new Map([...byPackage].map(([id, entry]) => [id, entry.authority]));
    const shared: SharedSourceAuthority = { references: 1, disposed: false, packages: packageAuthorities };
    authorities.set(result, { released: false, shared: Object.freeze([shared]), packages: packageAuthorities });
    return result;
  } catch (error) {
    for (const candidate of candidates) { await disposeBrandImportPlan(candidate.authority.plan).catch(() => undefined); if (candidate.authority.npm !== undefined) { await candidate.authority.npm.brandDirectoryHandle.close().catch(() => undefined); await candidate.authority.npm.packageJsonHandle.close().catch(() => undefined); await candidate.authority.npm.rootHandle.close().catch(() => undefined); } }
    throw error;
  }
}

/** Internal Studio carrier seam: verifies exactly one typed carrier without a client-supplied consumer root. */
export async function verifyConsumerSourceCarrier(carrier: ConsumerSourceCarrier): Promise<VerifiedConsumerSources> {
  const path = resolve(carrier.path);
  return carrier.kind === "brand-bundle"
    ? verifyConsumerSources({ root: dirname(path), sourceBundles: [path] })
    : verifyConsumerSources({ root: path, sourcePackages: [path] });
}

export async function revalidateConsumerSources(sources: VerifiedConsumerSources): Promise<void> {
  const authority = requireAuthority(sources);
  for (const item of authority.packages.values()) {
    await revalidateRetainedBrandArchive(item.plan);
    if (item.npm !== undefined) {
      const root = await lstat(item.npm.rootPath).catch(() => undefined), rootOpened = await item.npm.rootHandle.stat();
      if (root === undefined || root.isSymbolicLink() || !root.isDirectory() || !sameFileIdentity(identity(root), item.npm.rootIdentity) || !sameFileIdentity(identity(rootOpened), item.npm.rootIdentity)) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_CHANGED", "Installed package root changed.");
      const file = await lstat(item.npm.packageJsonPath).catch(() => undefined), opened = await item.npm.packageJsonHandle.stat();
      if (file === undefined || file.isSymbolicLink() || !file.isFile() || !sameFileIdentity(identity(file), item.npm.packageJsonIdentity) || !sameFileIdentity(identity(opened), item.npm.packageJsonIdentity)) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_CHANGED", "Installed package package.json changed.");
      const bytes = await readExactBuffer(item.npm.packageJsonHandle, opened.size, 0, { operation: "validate", domain: "brand" }, PACKAGE_JSON_MAX_BYTES);
      if (computeRawSha256(bytes) !== item.npm.packageJsonDigest) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_CHANGED", "Installed package package.json bytes changed.");
      const brandDirectory = await lstat(item.npm.brandDirectoryPath).catch(() => undefined), brandDirectoryOpened = await item.npm.brandDirectoryHandle.stat();
      if (brandDirectory === undefined || brandDirectory.isSymbolicLink() || !brandDirectory.isDirectory() || !sameFileIdentity(identity(brandDirectory), item.npm.brandDirectoryIdentity) || !sameFileIdentity(identity(brandDirectoryOpened), item.npm.brandDirectoryIdentity)) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_CHANGED", "Installed package brand carrier changed.");
    }
  }
}

export function getVerifiedConsumerPayload(sources: VerifiedConsumerSources, packageId: string, kind: "asset" | "companion", id: string): Uint8Array | undefined {
  const authority = authorities.get(sources); if (authority === undefined || authority.released || authority.shared.some((entry) => entry.disposed)) return undefined;
  const bytes = kind === "asset" ? authority.packages.get(packageId)?.assets.get(id) : authority.packages.get(packageId)?.companions.get(id);
  return bytes === undefined ? undefined : Buffer.from(bytes);
}

export interface VerifiedConsumerPackageAuthority {
  readonly packageModel: BrandPackageModel;
  readonly brandManifest: BrandBundleManifest;
  readonly archivePath: string;
  readonly npmRootPath?: string;
}

export function getVerifiedConsumerPackageAuthority(
  sources: VerifiedConsumerSources,
  packageId: string,
): VerifiedConsumerPackageAuthority | undefined {
  const authority = authorities.get(sources);
  const item = authority === undefined || authority.released || authority.shared.some((entry) => entry.disposed) ? undefined : authority.packages.get(packageId);
  return item === undefined ? undefined : { packageModel: item.packageModel, brandManifest: item.brandManifest, archivePath: item.plan.archive, ...(item.npm === undefined ? {} : { npmRootPath: item.npm.rootPath }) };
}

/** Internal independently disposable lease over authentic verified sources. */
export function leaseVerifiedConsumerSources(sources: VerifiedConsumerSources): VerifiedConsumerSources {
  const authority = requireAuthority(sources);
  retainShared(authority.shared);
  const result = Object.freeze({ packages: sources.packages });
  authorities.set(result, { released: false, shared: authority.shared, packages: authority.packages });
  return result;
}

/** Internal conflict-checked combination without path or public-DTO reconstruction. */
export function combineVerifiedConsumerSources(inputs: readonly VerifiedConsumerSources[]): VerifiedConsumerSources {
  if (inputs.length < 1 || inputs.length > CONSUMER_SOURCE_MAX_PACKAGES) fail({ operation: "validate", domain: "brand" }, "RESOURCE_LIMIT_EXCEEDED", "Consumer operations require 1..8 verified source packages.");
  const shared = new Set<SharedSourceAuthority>();
  const packageAuthorities = new Map<string, PackageAuthority>();
  const summaries = new Map<string, VerifiedConsumerPackage>();
  for (const input of inputs) {
    const authority = requireAuthority(input);
    for (const item of authority.shared) shared.add(item);
    for (const summary of input.packages) {
      const previous = summaries.get(summary.packageId);
      if (previous !== undefined) {
        fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_CONFLICT", `Duplicate or competing source identity for package '${summary.packageId}'.`);
      }
      const privatePackage = authority.packages.get(summary.packageId);
      if (privatePackage === undefined) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", "Verified source authority was lost.");
      summaries.set(summary.packageId, summary);
      packageAuthorities.set(summary.packageId, privatePackage);
    }
  }
  if (summaries.size < 1 || summaries.size > CONSUMER_SOURCE_MAX_PACKAGES) fail({ operation: "validate", domain: "brand" }, "RESOURCE_LIMIT_EXCEEDED", "Consumer operations require 1..8 unique verified source packages.");
  const retained = Object.freeze([...shared]);
  retainShared(retained);
  const result = Object.freeze({ packages: Object.freeze([...summaries.values()].sort((a, b) => compareUtf8(a.packageId, b.packageId))) });
  authorities.set(result, { released: false, shared: retained, packages: packageAuthorities });
  return result;
}

/** Internal exact retained semantic source snapshot for Studio diff. */
export function getVerifiedConsumerBrandDiffSnapshot(sources: VerifiedConsumerSources, packageId: string): BrandDiffSnapshot {
  const item = requireAuthority(sources).packages.get(packageId);
  if (item === undefined) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", "Verified package authority is unavailable.");
  return getRetainedBrandImportDiffSnapshot(item.plan);
}

export function getVerifiedConsumerBrandVisualAsset(sources: VerifiedConsumerSources, packageId: string, assetId: string): ReturnType<typeof getRetainedBrandImportVisualAsset> {
  const item = requireAuthority(sources).packages.get(packageId);
  if (item === undefined) fail({ operation: "validate", domain: "brand" }, "CONSUMER_SOURCE_INVALID", "Verified package authority is unavailable.");
  return getRetainedBrandImportVisualAsset(item.plan, assetId);
}

/** Internal conservative in-memory payload charge for the shared ledger. */
export function inspectVerifiedConsumerSourcesRetainedBytes(sources: VerifiedConsumerSources): number {
  return [...requireAuthority(sources).packages.values()].reduce((sum, item) => sum + item.selectedBytes, 0);
}

export async function disposeConsumerSources(sources: VerifiedConsumerSources): Promise<void> {
  const authority = authorities.get(sources);
  if (authority === undefined || authority.released) return;
  authority.released = true;
  for (const shared of authority.shared) await releaseShared(shared);
}
