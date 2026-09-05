import { createHash, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, isAbsolute, join, parse, resolve, sep } from "node:path";

import { type AnalyzeInputPlan, inspectAnalyzeInput, verifyAnalyzeInputPlan } from "../analyze-source.js";
import { computeSha256 } from "../digests.js";
import { readRegularFileSnapshot, sameFileIdentity, type FileIdentity, type PresentFileSnapshot } from "../filesystem.js";
import { computeNormalizationPolicyDigest } from "../normalization-policy.js";
import { computeWorkspaceChildSeal, openWorkspaceFile, verifyWorkspaceSnapshot, WORKSPACE_FILENAME, type OpenWorkspace } from "../workspace.js";
import { loadCanonicalProject, type LoadedProject } from "../project.js";
import {
  combineVerifiedConsumerSources,
  disposeConsumerSources,
  inspectVerifiedConsumerSourcesRetainedBytes,
  revalidateConsumerSources,
  verifyConsumerSourceCarrier,
  type VerifiedConsumerSources,
} from "../brand/consumer-source.js";
import { parseNormalizationMap as parseNormalizationMapDocument } from "../normalization-map.js";
import { parseShardManifest, serializeShardManifest, SHARD_MANIFEST_MAX_BYTES } from "../shard.js";
import { computeSourceMapDigest, parseSourceMap, SOURCE_MAP_FILENAME } from "../source-map.js";
import { AuthorityLedger } from "./authority-ledger.js";
import { ProtocolError } from "./errors.js";
import type { ProjectHandle, SourceHandle, WorkspaceHandle } from "./v1-types.js";

export type SourcePurpose = "content" | "source-map" | "normalization-map" | "shard-manifest" | "brand-bundle" | "npm-installed-package";
export type AuxiliarySourcePurpose = "source-map" | "normalization-map" | "shard-manifest";
export type BrandSourcePurpose = "brand-bundle" | "npm-installed-package";
export type ProjectState = "existing" | "uninitialized";
export type ProjectOpenMode = "existing" | "import-target";
export type ProjectValidationState = ProjectState | ProjectOpenMode;

export interface HandleRegistryOptions {
  /** An injected session-wide retained-authority ledger. */
  readonly ledger?: AuthorityLedger;
  /** Alias accepted by callers that name the primitive explicitly. */
  readonly authorityLedger?: AuthorityLedger;
  /** Session binding used by handle-binding digests. */
  readonly sessionNonce?: string;
  /** Alias accepted by callers that use the digest terminology. */
  readonly sessionBinding?: string;
}

export interface RootIdentity { readonly dev: number; readonly ino: number }
export interface WorkspaceRecord { readonly kind: "workspace"; readonly opened: OpenWorkspace }
export interface ProjectRecord {
  readonly kind: "project";
  readonly root: string;
  readonly identity: RootIdentity;
  readonly state: ProjectState;
}
export interface ContentSourceRecord {
  readonly kind: "source";
  readonly purpose: "content";
  readonly plan: AnalyzeInputPlan;
  readonly digest: string;
}
export interface AuxiliarySourceRecord {
  readonly kind: "source";
  readonly purpose: AuxiliarySourcePurpose;
  /** Private absolute path supplied only to an authentic domain planner. */
  readonly path: string;
  /** The stable read's identity object; this aliases `snapshot`. */
  readonly identity: FileIdentity;
  /** Stable byte snapshot retained for the lifetime of this handle. */
  readonly snapshot: PresentFileSnapshot;
  /** Alias of `snapshot.bytes`; no second byte-array instance is retained. */
  readonly bytes: Uint8Array;
  readonly byteDigest: `sha256:${string}`;
  readonly semanticDigest: `sha256:${string}`;
  readonly byteLength: number;
}
export type SourceRecord = ContentSourceRecord;
type RetainedAuxiliarySourceRecord = AuxiliarySourceRecord & {
  readonly ledgerRelease: () => void;
  ledgerReleased: boolean;
};
export interface BrandSourceRecord {
  readonly kind: "source";
  readonly purpose: BrandSourcePurpose;
  readonly sources: VerifiedConsumerSources;
  readonly digest: `sha256:${string}`;
  readonly retainedBytes: number;
}
type RetainedBrandSourceRecord = BrandSourceRecord & {
  readonly ledgerRelease: () => void;
  ledgerReleased: boolean;
};
type AnySourceRecord = ContentSourceRecord | RetainedAuxiliarySourceRecord | RetainedBrandSourceRecord;
type HandleRecord = WorkspaceRecord | ProjectRecord | AnySourceRecord;

export interface OpenSourceOptions {
  readonly checkCancelled?: () => void;
  readonly purpose?: SourcePurpose;
}

export interface OpenProjectOptions { readonly mode?: ProjectOpenMode }

const HANDLE_BINDING_BASIS = "tfsb-studio-handle-binding-v1" as const;
const AUXILIARY_MAX_BYTES = 1024 * 1024;

function opaque(kind: HandleRecord["kind"]): string {
  return `${kind}_${randomBytes(32).toString("base64url")}`;
}

async function validateAbsoluteComponents(input: string, finalKind: "file" | "directory" | "either"): Promise<string> {
  if (!isAbsolute(input)) throw new ProtocolError("ROOT_INVALID");
  const absolute = resolve(input);
  const root = parse(absolute).root;
  let cursor = root;
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new ProtocolError("ROOT_INVALID");
    for (const piece of absolute.slice(root.length).split(sep).filter(Boolean)) {
      cursor = resolve(cursor, piece);
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new ProtocolError("ROOT_INVALID");
    }
    const final = await lstat(absolute);
    if (finalKind === "file" && !final.isFile() || finalKind === "directory" && !final.isDirectory() || finalKind === "either" && !final.isFile() && !final.isDirectory()) {
      throw new ProtocolError("ROOT_INVALID");
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("ROOT_INVALID");
  }
  return absolute;
}

function sourceDigest(plan: AnalyzeInputPlan): string {
  const hash = createHash("sha256");
  hash.update("tfsb-studio-source-handle-v1\n");
  hash.update(plan.kind);
  if (plan.kind === "directory") {
    for (const item of plan.directoryEntries ?? []) hash.update(`\n${item.path}\0${item.kind}\0${JSON.stringify(item.identity)}`);
  } else {
    hash.update(`\n${JSON.stringify(plan.archiveIdentity)}`);
  }
  return `sha256:${hash.digest("hex")}`;
}

function ledgerBusy(error: unknown): boolean {
  if (error instanceof ProtocolError) return error.symbolicCode === "REQUEST_BUSY";
  if (typeof error !== "object" || error === null) return false;
  const value = error as { readonly symbolicCode?: unknown; readonly code?: unknown };
  return value.symbolicCode === "REQUEST_BUSY" || value.code === "REQUEST_BUSY";
}

function rootIdentity(value: { readonly dev: number; readonly ino: number }): RootIdentity {
  return { dev: value.dev, ino: value.ino };
}

function sameRootIdentity(left: RootIdentity, right: RootIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function requireCanonicalAbsent(root: string): Promise<void> {
  try {
    await lstat(join(root, ".tfsb"));
    throw new ProtocolError("ROOT_INVALID");
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new ProtocolError("ROOT_INVALID");
  }
}

function auxiliaryContext(purpose: AuxiliarySourcePurpose): { readonly operation: "import"; readonly domain: "source-map" | "project" | "manifest" } {
  if (purpose === "source-map") return { operation: "import", domain: "source-map" };
  if (purpose === "shard-manifest") return { operation: "import", domain: "manifest" };
  return { operation: "import", domain: "project" };
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolError("ROOT_INVALID");
  }
}

function semanticAuxiliaryDigest(purpose: AuxiliarySourcePurpose, text: string, source: string): `sha256:${string}` {
  if (purpose === "source-map") {
    const parsed = parseSourceMap(text, source);
    if (!parsed.ok) throw new ProtocolError("ROOT_INVALID");
    return computeSourceMapDigest(parsed.value);
  }
  if (purpose === "normalization-map") {
    const parsed = parseNormalizationMapDocument(text, source);
    if (!parsed.ok) throw new ProtocolError("ROOT_INVALID");
    return computeNormalizationPolicyDigest(parsed.value);
  }
  const parsed = parseShardManifest(text, source);
  if (!parsed.ok) throw new ProtocolError("ROOT_INVALID");
  try {
    return computeSha256(Buffer.from(serializeShardManifest(parsed.value), "utf8"));
  } catch {
    throw new ProtocolError("ROOT_INVALID");
  }
}

function bindingIdentity(record: HandleRecord): unknown {
  if (record.kind === "workspace") {
    const snapshot = record.opened.manifestSnapshot;
    return {
      workspaceDigest: record.opened.workspaceDigest,
      manifest: snapshot.kind === "absent" ? "absent" : {
        dev: snapshot.dev, ino: snapshot.ino, mode: snapshot.mode,
        size: snapshot.size, mtimeMs: snapshot.mtimeMs, ctimeMs: snapshot.ctimeMs,
        sha256: snapshot.sha256,
      },
    };
  }
  if (record.kind === "project") return { state: record.state, dev: record.identity.dev, ino: record.identity.ino };
  if (record.purpose === "content") return { sourceKind: record.plan.kind, digest: record.digest };
  if ("sources" in record) {
    return { digest: record.digest, packages: record.sources.packages.map((item) => ({ packageId: item.packageId, brandVersion: item.brandVersion, brandSystemDigest: item.brandSystemDigest })) };
  }
  return {
    dev: record.identity.dev, ino: record.identity.ino, mode: record.identity.mode,
    size: record.identity.size, mtimeMs: record.identity.mtimeMs, ctimeMs: record.identity.ctimeMs,
    byteDigest: record.byteDigest, semanticDigest: record.semanticDigest, byteLength: record.byteLength,
  };
}

export class HandleRegistry {
  readonly #records = new Map<string, HandleRecord>();
  readonly #ledger: AuthorityLedger;
  readonly #sessionBinding: string;
  #auxiliaryBytes = 0;

  constructor(ledger?: AuthorityLedger, sessionBinding?: string);
  constructor(options?: HandleRegistryOptions, sessionBinding?: string);
  constructor(ledgerOrOptions: AuthorityLedger | HandleRegistryOptions = new AuthorityLedger(), sessionBinding?: string) {
    if (ledgerOrOptions instanceof AuthorityLedger) {
      this.#ledger = ledgerOrOptions;
      this.#sessionBinding = sessionBinding ?? randomBytes(32).toString("base64url");
      return;
    }
    this.#ledger = ledgerOrOptions.ledger ?? ledgerOrOptions.authorityLedger ?? new AuthorityLedger();
    this.#sessionBinding = ledgerOrOptions.sessionNonce ?? ledgerOrOptions.sessionBinding ?? sessionBinding ?? randomBytes(32).toString("base64url");
  }

  async openWorkspace(path: string): Promise<unknown> {
    const absolute = await validateAbsoluteComponents(path, "file");
    if (basename(absolute) !== WORKSPACE_FILENAME) throw new ProtocolError("ROOT_INVALID");
    const opened = await openWorkspaceFile(absolute);
    const handle = opaque("workspace") as WorkspaceHandle;
    this.#records.set(handle, { kind: "workspace", opened });
    return {
      workspaceHandle: handle, rootKind: "workspace", workspaceId: opened.workspace.id,
      name: opened.workspace.name, manifestDigest: opened.workspaceDigest,
      childCount: opened.workspace.projects.length, diagnostics: [],
    };
  }

  async openProject(path: string, modeOrOptions: ProjectOpenMode | OpenProjectOptions = "existing"): Promise<unknown> {
    const mode = typeof modeOrOptions === "string" ? modeOrOptions : modeOrOptions.mode ?? "existing";
    if (mode !== "existing" && mode !== "import-target") throw new ProtocolError("ROOT_INVALID");
    const absolute = await validateAbsoluteComponents(path, "directory");
    const stat = await lstat(absolute);
    const state: ProjectState = mode === "existing" ? "existing" : "uninitialized";
    if (state === "uninitialized") {
      await requireCanonicalAbsent(absolute);
      const handle = opaque("project") as ProjectHandle;
      this.#records.set(handle, { kind: "project", root: absolute, identity: rootIdentity(stat), state });
      return { projectHandle: handle, rootKind: "project", state };
    }
    const project = await loadCanonicalProject(absolute, "discover");
    const handle = opaque("project") as ProjectHandle;
    this.#records.set(handle, { kind: "project", root: absolute, identity: rootIdentity(stat), state });
    return {
      projectHandle: handle, rootKind: "project", schemaVersion: project.project.schemaVersion,
      name: project.project.name, canonicalDigest: computeWorkspaceChildSeal(project),
      assetCount: project.assets.length, companionCount: project.companions.size,
    };
  }

  async openSource(path: string, options: OpenSourceOptions | SourcePurpose = {}): Promise<unknown> {
    const hooks: OpenSourceOptions = typeof options === "string" ? { purpose: options } : options;
    const purpose = hooks.purpose ?? "content";
    if (purpose !== "content" && purpose !== "source-map" && purpose !== "normalization-map" && purpose !== "shard-manifest" && purpose !== "brand-bundle" && purpose !== "npm-installed-package") {
      throw new ProtocolError("ROOT_INVALID");
    }
    const finalKind = purpose === "brand-bundle" ? "file" : purpose === "npm-installed-package" ? "directory" : "either";
    const absolute = await validateAbsoluteComponents(path, finalKind);
    if (purpose === "source-map" || purpose === "normalization-map" || purpose === "shard-manifest") return this.#openAuxiliary(absolute, purpose, hooks.checkCancelled);
    if (purpose === "brand-bundle" || purpose === "npm-installed-package") return this.#openBrandSource(absolute, purpose, hooks.checkCancelled);
    const plan = await inspectAnalyzeInput(absolute, undefined, hooks);
    const digest = sourceDigest(plan);
    const handle = opaque("source") as SourceHandle;
    this.#records.set(handle, { kind: "source", purpose: "content", plan, digest });
    return {
      sourceHandle: handle, rootKind: "source", sourceKind: plan.kind, digest,
      candidateCount: plan.kind === "directory" ? plan.directoryEntries?.length ?? 0 : 1,
      capabilities: { analyze: true, mutation: false },
    };
  }

  async #openBrandSource(path: string, purpose: BrandSourcePurpose, checkCancelled?: () => void): Promise<unknown> {
    checkCancelled?.();
    let sources: VerifiedConsumerSources | undefined;
    try {
      sources = await verifyConsumerSourceCarrier({ kind: purpose, path });
      checkCancelled?.();
      if (sources.packages.length !== 1) throw new ProtocolError("ROOT_INVALID");
      const retainedBytes = inspectVerifiedConsumerSourcesRetainedBytes(sources);
      const ledgerRelease = this.#chargeAuxiliary(retainedBytes);
      try {
        const pkg = sources.packages[0]!;
        const digest = computeSha256(Buffer.from(JSON.stringify({ purpose, packageId: pkg.packageId, brandVersion: pkg.brandVersion, brandSystemDigest: pkg.brandSystemDigest, brandManifestDigest: pkg.source.brandManifestDigest }), "utf8"));
        const handle = opaque("source") as SourceHandle;
        this.#records.set(handle, { kind: "source", purpose, sources, digest, retainedBytes, ledgerRelease, ledgerReleased: false });
        return {
          sourceHandle: handle, rootKind: "source", authorityKind: purpose,
          packageId: pkg.packageId, brandVersion: pkg.brandVersion,
          brandSystemDigest: pkg.brandSystemDigest, brandManifestDigest: pkg.source.brandManifestDigest,
          consumerProfilesDigest: pkg.consumerProfilesDigest,
          profileCount: pkg.consumerProfiles?.profiles.length ?? 0,
          assetCount: pkg.assetIds.length, companionCount: pkg.companionIds.length,
          ...(pkg.source.kind === "npm-installed" ? { npmName: pkg.source.npmName, npmVersion: pkg.source.npmVersion } : {}),
          capabilities: { analyze: false, brandDiff: true, consumerSource: true },
        };
      } catch (error) {
        ledgerRelease();
        throw error;
      }
    } catch (error) {
      if (sources !== undefined && ![...this.#records.values()].some((record) => record.kind === "source" && (record.purpose === "brand-bundle" || record.purpose === "npm-installed-package") && record.sources === sources)) await disposeConsumerSources(sources);
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("ROOT_INVALID");
    }
  }

  async workspace(handle: string): Promise<WorkspaceRecord> {
    const record = this.#records.get(handle);
    if (record?.kind !== "workspace") throw new ProtocolError("ROOT_HANDLE_INVALID");
    await validateAbsoluteComponents(record.opened.manifestPath, "file");
    try { await verifyWorkspaceSnapshot(record.opened); }
    catch { throw new ProtocolError("ROOT_INVALID"); }
    return record;
  }

  async project(handle: string): Promise<{ readonly record: ProjectRecord; readonly loaded: LoadedProject; readonly digest: string }> {
    const record = await this.revalidateProject(handle, "existing");
    const loaded = await loadCanonicalProject(record.root, "list");
    return { record, loaded, digest: computeWorkspaceChildSeal(loaded) };
  }

  async source(handle: string): Promise<SourceRecord> {
    const record = this.#records.get(handle);
    if (record?.kind !== "source" || record.purpose !== "content") throw new ProtocolError("ROOT_HANDLE_INVALID");
    await validateAbsoluteComponents(record.plan.inputPath, "either");
    return record;
  }

  async brandSource(handle: string): Promise<BrandSourceRecord> {
    const record = this.#records.get(handle);
    if (record?.kind !== "source" || record.purpose !== "brand-bundle" && record.purpose !== "npm-installed-package") throw new ProtocolError("ROOT_HANDLE_INVALID");
    try {
      await revalidateConsumerSources(record.sources);
    } catch {
      throw new ProtocolError("ROOT_INVALID");
    }
    return record;
  }

  async leaseBrandSources(handles: readonly string[]): Promise<VerifiedConsumerSources> {
    if (handles.length < 1 || handles.length > 8 || new Set(handles).size !== handles.length) throw new ProtocolError("ROOT_HANDLE_INVALID");
    const records = await Promise.all(handles.map((handle) => this.brandSource(handle)));
    try { return combineVerifiedConsumerSources(records.map((record) => record.sources)); }
    catch (error) { if (error instanceof ProtocolError) throw error; throw new ProtocolError("DOMAIN_OPERATION_FAILED"); }
  }

  laneFor(kind: "workspace" | "project" | "source", handle: string): string {
    const record = this.#records.get(handle);
    if (record?.kind !== kind) throw new ProtocolError("ROOT_HANDLE_INVALID");
    if (record.kind === "workspace") return `workspace:${record.opened.root}`;
    if (record.kind === "project") {
      if (record.state !== "existing") throw new ProtocolError("ROOT_HANDLE_INVALID");
      return `project:${record.root}`;
    }
    if (record.purpose !== "content") throw new ProtocolError("ROOT_HANDLE_INVALID");
    return `source:${record.plan.inputPath}`;
  }

  async verifySource(record: SourceRecord, hooks: { readonly checkCancelled?: () => void } = {}): Promise<void> {
    await verifyAnalyzeInputPlan(record.plan, hooks);
  }

  /** Return an initialized project record after identity revalidation. */
  async revalidateProject(handle: string, expectedState: ProjectValidationState = "existing"): Promise<ProjectRecord> {
    const state: ProjectState = expectedState === "import-target" ? "uninitialized" : expectedState;
    const record = this.#records.get(handle);
    if (record?.kind !== "project" || record.state !== state) throw new ProtocolError("ROOT_HANDLE_INVALID");
    await validateAbsoluteComponents(record.root, "directory");
    const stat = await lstat(record.root).catch(() => undefined);
    if (stat === undefined || !sameRootIdentity(record.identity, rootIdentity(stat))) throw new ProtocolError("ROOT_INVALID");
    if (record.state === "uninitialized") await requireCanonicalAbsent(record.root);
    return record;
  }

  /** Dedicated import-target accessor; initialized project handles are rejected. */
  async importTarget(handle: string): Promise<ProjectRecord> {
    return this.revalidateProject(handle, "uninitialized");
  }

  /** Alias used by adapters that name the target by its protocol mode. */
  async revalidateImportTarget(handle: string): Promise<ProjectRecord> {
    return this.importTarget(handle);
  }

  async contentSource(handle: string): Promise<ContentSourceRecord> {
    return this.source(handle);
  }

  async revalidateContentSource(handle: string, hooks: { readonly checkCancelled?: () => void } = {}): Promise<ContentSourceRecord> {
    const record = await this.contentSource(handle);
    await this.verifySource(record, hooks);
    return record;
  }

  async revalidateSource(handle: string, purpose?: SourcePurpose, hooks: { readonly checkCancelled?: () => void } = {}): Promise<ContentSourceRecord | AuxiliarySourceRecord | BrandSourceRecord> {
    if (purpose === "brand-bundle" || purpose === "npm-installed-package") return this.brandSource(handle);
    if (purpose !== undefined && purpose !== "content") return this.revalidateAuxiliarySource(handle, purpose);
    return this.revalidateContentSource(handle, hooks);
  }

  async auxiliarySource(handle: string, purpose: AuxiliarySourcePurpose): Promise<AuxiliarySourceRecord> {
    return this.revalidateAuxiliarySource(handle, purpose);
  }

  async revalidateAuxiliary(handle: string, purpose: AuxiliarySourcePurpose): Promise<AuxiliarySourceRecord> {
    return this.revalidateAuxiliarySource(handle, purpose);
  }

  async revalidateAuxiliarySource(handle: string, purpose: AuxiliarySourcePurpose): Promise<AuxiliarySourceRecord> {
    const record = this.#records.get(handle);
    if (record?.kind !== "source" || record.purpose !== purpose) throw new ProtocolError("ROOT_HANDLE_INVALID");
    let read: Awaited<ReturnType<typeof readRegularFileSnapshot>>;
    try {
      await validateAbsoluteComponents(record.path, "file");
      read = await readRegularFileSnapshot(record.path, auxiliaryContext(purpose), "ROOT_INVALID", "Auxiliary source is unavailable or unsafe.", AUXILIARY_MAX_BYTES);
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("ROOT_INVALID");
    }
    if (!sameFileIdentity(record.snapshot, read.snapshot) || computeSha256(read.bytes) !== record.byteDigest) {
      throw new ProtocolError("ROOT_INVALID");
    }
    return record;
  }

  /** The only source-relative path derivation: the fixed canonical source map. */
  async sourceContainedMapPath(handle: string): Promise<string> {
    const record = await this.revalidateContentSource(handle);
    if (record.plan.kind !== "directory") throw new ProtocolError("ROOT_HANDLE_INVALID");
    return join(record.plan.inputPath, SOURCE_MAP_FILENAME);
  }

  /** Stable session-local binding digest; absolute paths are deliberately absent. */
  handleBindingDigest(handle: string): `sha256:${string}` {
    const record = this.#records.get(handle);
    if (record === undefined) throw new ProtocolError("ROOT_HANDLE_INVALID");
    const payload = JSON.stringify({
      session: this.#sessionBinding,
      handle,
      kind: record.kind,
      purpose: record.kind === "source" ? record.purpose : null,
      identity: bindingIdentity(record),
    });
    return computeSha256(Buffer.from(`${HANDLE_BINDING_BASIS}\n${payload}`, "utf8"));
  }

  /** Compatibility alias for plan adapters. */
  bindingDigest(handle: string): `sha256:${string}` { return this.handleBindingDigest(handle); }

  get retainedAuxiliaryBytes(): number { return this.#auxiliaryBytes; }

  clear(): void { void this.dispose(); }

  async dispose(): Promise<void> {
    const records = [...this.#records.values()];
    this.#records.clear();
    for (const record of records) {
      if (record.kind !== "source" || record.purpose === "content") continue;
      if ("sources" in record) {
        if (!record.ledgerReleased) { record.ledgerReleased = true; record.ledgerRelease(); }
        await disposeConsumerSources(record.sources);
      } else this.#releaseAuxiliary(record);
    }
  }

  async #openAuxiliary(path: string, purpose: AuxiliarySourcePurpose, checkCancelled?: () => void): Promise<unknown> {
    checkCancelled?.();
    let read: Awaited<ReturnType<typeof readRegularFileSnapshot>>;
    try {
      read = await readRegularFileSnapshot(path, auxiliaryContext(purpose), "ROOT_INVALID", "Auxiliary source is unavailable or unsafe.", purpose === "shard-manifest" ? SHARD_MANIFEST_MAX_BYTES : AUXILIARY_MAX_BYTES);
      const semanticDigest = semanticAuxiliaryDigest(purpose, decodeUtf8(read.bytes), basename(path));
      checkCancelled?.();
      const byteDigest = computeSha256(read.bytes);
      const ledgerRelease = this.#chargeAuxiliary(read.bytes.byteLength);
      try {
        const handle = opaque("source") as SourceHandle;
        const record: RetainedAuxiliarySourceRecord = {
          kind: "source", purpose, path,
          identity: {
            dev: read.snapshot.dev,
            ino: read.snapshot.ino,
            mode: read.snapshot.mode,
            size: read.snapshot.size,
            mtimeMs: read.snapshot.mtimeMs,
            ctimeMs: read.snapshot.ctimeMs,
          },
          snapshot: read.snapshot,
          bytes: read.bytes,
          byteDigest, semanticDigest, byteLength: read.bytes.byteLength, ledgerRelease, ledgerReleased: false,
        };
        this.#records.set(handle, record);
        this.#auxiliaryBytes += record.byteLength;
        return {
          sourceHandle: handle,
          rootKind: "source",
          authorityKind: purpose,
          byteDigest,
          semanticDigest,
          byteLength: read.bytes.byteLength,
          capabilities: { analyze: false, mutationAuthority: true },
        };
      } catch (error) {
        ledgerRelease();
        throw error;
      }
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("ROOT_INVALID");
    }
  }

  #chargeAuxiliary(bytes: number): () => void {
    let lease: ReturnType<AuthorityLedger["reserveHandle"]>;
    try {
      lease = this.#ledger.reserveHandle(bytes);
    } catch (error) {
      if (ledgerBusy(error)) throw new ProtocolError("REQUEST_BUSY");
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lease.release();
    };
  }

  #releaseAuxiliary(record: RetainedAuxiliarySourceRecord): void {
    if (record.ledgerReleased) return;
    record.ledgerReleased = true;
    record.bytes.fill(0);
    record.ledgerRelease();
    this.#auxiliaryBytes = Math.max(0, this.#auxiliaryBytes - record.byteLength);
  }
}
