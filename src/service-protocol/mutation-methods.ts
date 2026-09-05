import { Buffer } from "node:buffer";

import {
  executeAssetEdit,
  inspectAssetEditPlanRetention,
  planAssetEdit,
  type AssetEditPlan,
} from "../edit.js";
import {
  executeAuthenticImport,
  disposeImportPlan,
  inspectImportPlanRetention,
  planImportWithHooks,
  type ImportPlan,
} from "../importer.js";
import {
  disposeDirectoryReconciliationPlan,
  executeDirectoryReconciliationPlan,
  inspectDirectoryReconciliationPlanRetention,
  planDirectoryReconciliationWithHooks,
  type DirectoryReconciliationPlan,
} from "../reconcile-directory.js";
import {
  executeReconciliationPlan,
  inspectReconciliationPlanRetention,
  planReconciliationWithHooks,
  type ReconcileOptions,
  type ReconciliationPlan,
} from "../reconcile.js";
import {
  executeMigration,
  inspectMigrationPlanRetention,
  planMigrationWithHooks,
  type MigrationPlan,
} from "../migration.js";
import {
  executeFormat,
  formatPlanCanonicalPaths,
  inspectFormatPlanRetention,
  planFormatWithHooks,
  type FormatPlan,
} from "../fmt.js";
import {
  executeBuild,
  inspectBuildPlanRetention,
  planBuildWithHooks,
  type BuildPlan,
  type BuildTestHooks,
} from "../build.js";
import {
  executeInstall,
  inspectInstallPlanRetention,
  planInstallWithHooks,
  type InstallPlan,
  type InstallTestHooks,
} from "../install.js";
import {
  executePreviewPlan,
  inspectPreviewPlanRetention,
  planPreviewWithHooks,
  type PreviewPlan,
  type PreviewTransactionHooks,
} from "../preview.js";
import { computeSha256 } from "../digests.js";
import type { DiagnosticError } from "../diagnostics.js";
import { serializeBuildReceipt } from "../receipt.js";
import type {
  AuxiliarySourcePurpose,
  AuxiliarySourceRecord,
  ContentSourceRecord,
  HandleRegistry,
  ProjectRecord,
  SourceRecord,
} from "./handles.js";
import {
  canonicalJson,
  type PlanDigestEnvelope,
} from "./canonical-json.js";
import {
  PlanRegistry,
  type PlanBindings,
  type StudioPlanResult as RegistryPlanResult,
} from "./plan-registry.js";
import { ProtocolError } from "./errors.js";
import type {
  AssetEditPlanParams,
  AssetEditPlanResult,
  AssetEditPlanSummary,
  BuildPlanOutputSummary,
  JsonRpcId,
  PlanApplyParams,
  PlanApplyResult,
  PlanDiscardParams,
  PreviewPlanParams,
  PreviewPlanResult,
  PreviewPlanSummary,
  ProjectBuildPlanParams,
  ProjectBuildPlanResult,
  ProjectBuildPlanSummary,
  ProjectFmtPlanParams,
  ProjectFmtPlanResult,
  ProjectFmtPlanSummary,
  ProjectImportPlanParams,
  ProjectImportPlanResult,
  ProjectImportPlanSummary,
  ProjectInstallPlanParams,
  ProjectInstallPlanResult,
  ProjectInstallPlanSummary,
  ProjectMigratePlanParams,
  ProjectMigratePlanResult,
  ProjectMigratePlanSummary,
  ProjectReconcilePlanParams,
  ProjectReconcilePlanResult,
  ProjectReconcilePlanSummary,
  ReconcileChoice,
  ReconcileRename,
  ReconcileRemoval,
  ReconcileResolution,
  Sha256Digest,
  SourceMapAuthority,
  StudioMutationMethod,
  StudioPlanMethod,
  StudioPlanSummary,
  StudioProgressStage,
} from "./v1-types.js";
import type { TransactionHooks } from "../transaction.js";
import { createBrandPlanAuthority } from "./brand-methods.js";
import { BRAND_PLAN_METHODS } from "./v1-registry.js";
import type { StudioSession } from "./session.js";

/** Progress emitted by the server-facing mutation adapter. */
export type MutationProgress = (
  stage: Extract<StudioProgressStage, "validate" | "snapshot" | "analyze" | "plan" | "ready" | "revalidate" | "waiting-lock" | "staging" | "promoting" | "cleanup" | "complete">,
  completed: number,
  total?: number,
) => void;

/**
 * The adapter deliberately depends on this small session shape instead of on
 * StudioSession itself.  This keeps the protocol/domain seam free of a
 * circular import and lets the session own the shared ledger and registry.
 */
export interface MutationSession {
  readonly nonce: string;
  readonly handles: HandleRegistry;
  readonly plans?: PlanRegistry;
  readonly planRegistry?: PlanRegistry;
}

type ProjectContext = Awaited<ReturnType<HandleRegistry["project"]>>;
type AuxiliaryContext = AuxiliarySourceRecord;
export type DomainPlan = unknown;
type DomainSummary = StudioPlanSummary;

interface AuxiliaryAuthorities {
  readonly sourceMap?: AuxiliaryContext;
  readonly normalizationMap?: AuxiliaryContext;
  readonly shardManifest?: AuxiliaryContext;
}

export interface PlanAuthority<TPlan = DomainPlan> {
  readonly plan: TPlan;
  readonly summary: DomainSummary;
  readonly envelope: PlanDigestEnvelope;
  readonly bindings: PlanBindings;
  readonly retention: ReturnType<typeof inspectAssetEditPlanRetention>;
  readonly dispose: (plan: TPlan) => void | Promise<void>;
  readonly revalidate: (signal: AbortSignal) => Promise<void>;
  readonly execute: (plan: TPlan, lifecycle: ApplyLifecycle) => Promise<unknown>;
  readonly mutates: boolean;
}

export interface ApplyLifecycle {
  readonly check: () => void;
  readonly transactionHooks: () => TransactionHooks;
  readonly buildHooks: () => BuildTestHooks;
  readonly installHooks: () => InstallTestHooks;
  readonly previewHooks: () => PreviewTransactionHooks;
  readonly didReachStaging: () => boolean;
  readonly didReachPromotion: () => boolean;
}

const STALE_DIAGNOSTIC_CODES = new Set([
  "ANALYZE_SOURCE_CHANGED",
  "ARCHIVE_CHANGED",
  "ARCHIVE_CHANGED_DURING_PLAN",
  "BUILD_TARGET_CHANGED_DURING_PLAN",
  "CANONICAL_CHANGED_DURING_PLAN",
  "DIRECTORY_SOURCE_CHANGED",
  "INSTALL_DESTINATION_CHANGED_DURING_PLAN",
  "INSTALL_STALE_BUILD",
  "NORMALIZATION_MAP_CHANGED",
  "PREVIEW_TARGET_CHANGED_DURING_PLAN",
  "ROOT_ALREADY_INITIALIZED",
  "ROOT_CHANGED",
  "SHARD_MANIFEST_CHANGED",
  "SHARD_MANIFEST_STALE",
  "SOURCE_MAP_CHANGED",
]);

const SAFE_CANCELLATION_DIAGNOSTIC_CODES = new Set([
  "INSTALL_FAILED_ROLLED_BACK",
  "TFSB_TRANSACTION_FAILED",
]);

function check(signal: AbortSignal): void {
  if (signal.aborted) throw new ProtocolError("REQUEST_CANCELLED");
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function digest(value: string): Sha256Digest {
  return value as Sha256Digest;
}

function rawBuildDigest(value: string): Sha256Digest {
  return value.startsWith("sha256:") ? digest(value) : digest(`sha256:${value}`);
}

function sortedPaths(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))));
}

function normalizedResolution(value: ReconcileResolution, sourceKind: "archive" | "directory"): string {
  const choice: ReconcileChoice = sourceKind === "directory"
    ? value.choice === "archive" ? "archive" : value.choice
    : value.choice === "source" ? "source" : value.choice;
  return `${value.key}=${choice}`;
}

function normalizedRename(value: ReconcileRename): string {
  return `${value.from}=${value.to}`;
}

function normalizedRemoval(value: ReconcileRemoval): string {
  return value.key;
}

function stripAssetPrefix(value: string): string {
  return value.startsWith("asset:") ? value.slice("asset:".length) : value;
}

function stripCompanionPrefix(value: string): string {
  return value.startsWith("companion:") ? value.slice("companion:".length) : value;
}

function sourceMapKind(authority: SourceMapAuthority | undefined): string {
  return authority?.kind ?? "source-contained";
}

function sourceDigestState(source: ContentSourceRecord): Record<string, unknown> {
  return { kind: source.plan.kind, digest: source.digest };
}

function auxiliaryDigestState(authorities: AuxiliaryAuthorities): Record<string, unknown> {
  return {
    ...(authorities.sourceMap === undefined ? {} : { sourceMap: { byteDigest: authorities.sourceMap.byteDigest, semanticDigest: authorities.sourceMap.semanticDigest } }),
    ...(authorities.normalizationMap === undefined ? {} : { normalizationMap: { byteDigest: authorities.normalizationMap.byteDigest, semanticDigest: authorities.normalizationMap.semanticDigest } }),
    ...(authorities.shardManifest === undefined ? {} : { shardManifest: { byteDigest: authorities.shardManifest.byteDigest, semanticDigest: authorities.shardManifest.semanticDigest } }),
  };
}

function authorityHandleState(
  handles: HandleRegistry,
  projectHandle: string | undefined,
  sourceHandle: string | undefined,
  authorities: RoleBoundAuthorities,
): Record<string, unknown> {
  const auxiliary = {
    ...(authorities.sourceMapHandle === undefined ? {} : { sourceMap: handles.bindingDigest(authorities.sourceMapHandle) }),
    ...(authorities.normalizationMapHandle === undefined ? {} : { normalizationMap: handles.bindingDigest(authorities.normalizationMapHandle) }),
    ...(authorities.shardManifestHandle === undefined ? {} : { shardManifest: handles.bindingDigest(authorities.shardManifestHandle) }),
  };
  return {
    ...(projectHandle === undefined ? {} : { project: handles.bindingDigest(projectHandle) }),
    ...(sourceHandle === undefined ? {} : { source: handles.bindingDigest(sourceHandle) }),
    ...(Object.keys(auxiliary).length === 0 ? {} : { auxiliary }),
  };
}

/** Internal role-aware authority records retain the originating handles. */
interface RoleBoundAuthorities extends AuxiliaryAuthorities {
  readonly sourceMapHandle?: string;
  readonly normalizationMapHandle?: string;
  readonly shardManifestHandle?: string;
}

function roleBoundAuthorities(value: AuxiliaryAuthorities & Partial<RoleBoundAuthorities>): RoleBoundAuthorities {
  return value as RoleBoundAuthorities;
}

function envelope(
  authority: unknown,
  handles: unknown,
  method: StudioPlanMethod,
  preState: unknown,
  summary: DomainSummary,
): PlanDigestEnvelope {
  return {
    authority: authority as PlanDigestEnvelope["authority"],
    handles: handles as PlanDigestEnvelope["handles"],
    method,
    preState: preState as PlanDigestEnvelope["preState"],
    protocol: "tfsb.studio",
    protocolVersion: "1.0",
    summary: summary as unknown as PlanDigestEnvelope["summary"],
  };
}

function mapApplyFailure(error: unknown, signal: AbortSignal, promotionStarted: boolean): ProtocolError {
  if (error instanceof ProtocolError) {
    if (error.symbolicCode === "ROOT_INVALID" || error.symbolicCode === "ROOT_HANDLE_INVALID") return new ProtocolError("PLAN_STALE");
    return error;
  }
  const diagnostic = error as Partial<DiagnosticError>;
  if (signal.aborted && !promotionStarted && diagnostic.diagnostic !== undefined && SAFE_CANCELLATION_DIAGNOSTIC_CODES.has(diagnostic.diagnostic.code)) {
    return new ProtocolError("REQUEST_CANCELLED");
  }
  if (diagnostic.diagnostic !== undefined && STALE_DIAGNOSTIC_CODES.has(diagnostic.diagnostic.code)) {
    return new ProtocolError("PLAN_STALE");
  }
  if (diagnostic.diagnostic !== undefined) return new ProtocolError("DOMAIN_OPERATION_FAILED");
  return new ProtocolError("DOMAIN_OPERATION_FAILED");
}

function makeLifecycle(signal: AbortSignal, progress: MutationProgress): ApplyLifecycle {
  let staging = false;
  let promotion = false;
  let stageEmitted = false;
  let promotionEmitted = false;
  const markStaging = (): void => {
    check(signal);
    staging = true;
    if (!stageEmitted) {
      stageEmitted = true;
      progress("staging", 0, 1);
    }
  };
  const markPromotion = (): void => {
    if (promotion) return;
    check(signal);
    promotion = true;
    if (!promotionEmitted) {
      promotionEmitted = true;
      progress("promoting", 0, 1);
    }
  };
  return {
    check: () => check(signal),
    transactionHooks: () => ({
      beforeStageCreate: () => check(signal),
      beforeStageWrite: () => check(signal),
      afterStageWrite: markStaging,
      beforeFirstRename: markPromotion,
    }),
    buildHooks: () => ({
      afterStage: markStaging,
      beforePromotion: markPromotion,
    }),
    installHooks: () => ({
      afterStage: markStaging,
      beforeReplace: (index) => { if (index === 0) markPromotion(); },
    }),
    previewHooks: () => ({
      afterStage: markStaging,
      beforePromotion: markPromotion,
    }),
    didReachStaging: () => staging,
    didReachPromotion: () => promotion,
  };
}

function toSummary<TSummary extends DomainSummary>(value: TSummary): TSummary {
  return value;
}

function authorityPlanBytes<TPlan extends DomainPlan>(authority: PlanAuthority<TPlan>): number {
  return authority.retention.retainedBytes + Buffer.byteLength(canonicalJson(authority.summary), "utf8");
}

/**
 * Exact service mutation adapter.  It has no filesystem implementation of its
 * own: all roots and authority paths are recovered from opaque handles and all
 * mutation is delegated to the authentic domain plan retained in PlanRegistry.
 */
export class MutationMethods {
  constructor(readonly session: MutationSession) {}

  lane(method: StudioMutationMethod, params: unknown): string {
    if (method === "plan.apply") return "mutation:apply";
    if (method === "plan.discard") return "mutation:discard";
    if (typeof params !== "object" || params === null) return `mutation:${method}`;
    const value = params as { readonly projectHandle?: string; readonly sourceHandle?: string };
    if (value.projectHandle !== undefined) return `mutation:project:${value.projectHandle}`;
    if (value.sourceHandle !== undefined) return `mutation:source:${value.sourceHandle}`;
    return `mutation:${method}`;
  }

  async execute(
    method: StudioMutationMethod,
    params: unknown,
    signal: AbortSignal,
    requestId: JsonRpcId,
    progress: MutationProgress,
  ): Promise<unknown> {
    void requestId;
    const value = params as { readonly sessionNonce?: string };
    if (value.sessionNonce !== undefined && value.sessionNonce !== this.session.nonce) throw new ProtocolError("SESSION_NONCE_INVALID");
    if (method === "plan.discard") return this.discard(params as PlanDiscardParams);
    if (method === "plan.apply") return this.apply(params as PlanApplyParams, signal, progress);
    return this.plan(method, params, signal, progress);
  }

  private registry(): PlanRegistry {
    const registry = this.session.plans ?? this.session.planRegistry;
    if (registry === undefined) throw new ProtocolError("SESSION_NOT_INITIALIZED");
    return registry;
  }

  private async plan(
    method: StudioPlanMethod,
    params: unknown,
    signal: AbortSignal,
    progress: MutationProgress,
  ): Promise<unknown> {
    check(signal);
    progress("validate", 0, 1);
    if (BRAND_PLAN_METHODS.includes(method as (typeof BRAND_PLAN_METHODS)[number])) {
      const authority = await createBrandPlanAuthority(this.session as StudioSession, method as (typeof BRAND_PLAN_METHODS)[number], params, signal, progress);
      return this.register(authority);
    }
    if (method === "asset.edit.plan") return this.planAssetEdit(params as AssetEditPlanParams, signal, progress);
    if (method === "project.import.plan") return this.planImport(params as ProjectImportPlanParams, signal, progress);
    if (method === "project.reconcile.plan") return this.planReconcile(params as ProjectReconcilePlanParams, signal, progress);
    if (method === "project.migrate.plan") return this.planMigration(params as ProjectMigratePlanParams, signal, progress);
    if (method === "project.fmt.plan") return this.planFormat(params as ProjectFmtPlanParams, signal, progress);
    if (method === "project.build.plan") return this.planBuild(params as ProjectBuildPlanParams, signal, progress);
    if (method === "project.install.plan") return this.planInstall(params as ProjectInstallPlanParams, signal, progress);
    return this.planPreview(params as PreviewPlanParams, signal, progress);
  }

  private async planAssetEdit(
    params: AssetEditPlanParams,
    signal: AbortSignal,
    progress: MutationProgress,
  ): Promise<AssetEditPlanResult> {
    const project = await this.session.handles.project(params.projectHandle);
    check(signal);
    progress("snapshot", 1, 1);
    progress("plan", 0, 1);
    const plan = await planAssetEdit({ root: project.record.root, assetId: params.assetId, proposedToml: params.proposedToml });
    check(signal);
    const summary: AssetEditPlanSummary = toSummary({
      assetId: plan.assetId,
      affectedCanonicalPath: plan.affectedCanonicalPath,
      oldDigest: plan.oldDigest,
      newDigest: plan.newDigest,
      changed: plan.changed,
      changes: plan.semanticChanges,
    });
    const authority = {
      assetId: params.assetId,
      proposedDigest: plan.newDigest,
    };
    const handles = { project: this.session.handles.bindingDigest(params.projectHandle) };
    const preState = { asset: plan.oldDigest, project: project.digest };
    const retained: PlanAuthority<AssetEditPlan> = {
      plan,
      summary,
      envelope: envelope(authority, handles, "asset.edit.plan", preState, summary),
      bindings: { sessionNonce: this.session.nonce, method: "asset.edit.plan", root: handles.project },
      retention: inspectAssetEditPlanRetention(plan),
      dispose: () => undefined,
      revalidate: async (applySignal) => { await this.session.handles.revalidateProject(params.projectHandle, "existing"); check(applySignal); },
      execute: async (authenticPlan, lifecycle) => { await executeAssetEdit(authenticPlan, lifecycle.transactionHooks()); },
      mutates: plan.changed,
    };
    progress("ready", 1, 1);
    return this.register<AssetEditPlan, AssetEditPlanResult>(retained);
  }

  private async planImport(
    params: ProjectImportPlanParams,
    signal: AbortSignal,
    progress: MutationProgress,
  ): Promise<ProjectImportPlanResult> {
    const target = await this.session.handles.importTarget(params.projectHandle);
    const source = await this.session.handles.revalidateContentSource(params.sourceHandle, { checkCancelled: () => check(signal) });
    progress("snapshot", 1, 1);
    progress("analyze", 1, 1);
    const authorities = await this.importAuthorities(params, source, signal);
    if (source.plan.kind === "directory" && params.archiveMode !== undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
    if (source.plan.kind === "archive" && (
      params.shardManifestHandle !== undefined || params.sourceMapAuthority !== undefined || params.collections !== undefined
    )) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
    progress("plan", 0, 1);
    const plan = await planImportWithHooks({
      root: target.root,
      source: { kind: source.plan.kind, path: source.plan.inputPath },
      schema: 2,
      recordProvenance: true,
      ...(params.archiveMode === "manifest" ? { manifest: true } : {}),
      ...(params.selections === undefined ? {} : { selections: params.selections }),
      ...(params.companions === undefined ? {} : { companions: params.companions }),
      ...(params.collections === undefined ? {} : { collections: params.collections }),
      ...(params.normalization === undefined || params.normalization === "none" ? {} : { normalize: "exact-common" as const }),
      ...(authorities.normalizationMap === undefined ? {} : { normalizationMap: authorities.normalizationMap.path }),
      ...(authorities.sourceMap === undefined ? source.plan.kind === "directory" ? { sourceMap: await this.session.handles.sourceContainedMapPath(params.sourceHandle) } : {} : { sourceMap: authorities.sourceMap.path }),
      ...(authorities.shardManifest === undefined ? {} : { shardManifest: authorities.shardManifest.path }),
    }, { checkCancelled: () => check(signal) });
    check(signal);
    const summary: ProjectImportPlanSummary = toSummary({
      sourceKind: plan.sourceKind,
      schemaVersion: 2,
      assetCount: plan.assets.length,
      companionCount: plan.companions.length,
      canonicalFileCount: plan.files.size,
      ...optional("normalizationPolicyDigest", plan.normalizationPolicy?.policyDigest),
      ...optional("sourceMapDigest", plan.sourceMapDigest),
      ...optional("snapshotDigest", plan.snapshotDigest),
      willInitialize: true,
    });
    const authority = {
      sourceKind: source.plan.kind,
      schemaVersion: 2,
      ...(params.archiveMode === undefined ? {} : { archiveMode: params.archiveMode }),
      ...(params.selections === undefined ? {} : { selections: params.selections }),
      ...(params.companions === undefined ? {} : { companions: params.companions }),
      ...(params.collections === undefined ? {} : { collections: params.collections }),
      ...(params.normalization === undefined ? {} : { normalization: params.normalization }),
      ...(source.plan.kind === "directory" ? { sourceMapAuthority: sourceMapKind(params.sourceMapAuthority) } : {}),
      ...auxiliaryDigestState(authorities),
    };
    const handles = authorityHandleState(this.session.handles, params.projectHandle, params.sourceHandle, authorities);
    const preState = {
      target: "absent",
      source: sourceDigestState(source),
      ...auxiliaryDigestState(authorities),
    };
    const retained: PlanAuthority<ImportPlan> = {
      plan,
      summary,
      envelope: envelope(authority, handles, "project.import.plan", preState, summary),
      bindings: {
        sessionNonce: this.session.nonce,
        method: "project.import.plan",
        root: this.session.handles.bindingDigest(params.projectHandle),
        source: this.session.handles.bindingDigest(params.sourceHandle),
        ...optional("auxiliary", this.bindings("project.import.plan", params.projectHandle, params.sourceHandle, authorities).auxiliary),
      },
      retention: inspectImportPlanRetention(plan),
      dispose: disposeImportPlan,
      revalidate: async (applySignal) => {
        await this.session.handles.importTarget(params.projectHandle);
        await this.session.handles.revalidateContentSource(params.sourceHandle, { checkCancelled: () => check(applySignal) });
        await this.revalidateAuthorities(authorities, applySignal);
      },
      execute: async (authenticPlan, lifecycle) => { await executeAuthenticImport(authenticPlan, lifecycle.transactionHooks()); },
      mutates: true,
    };
    progress("ready", 1, 1);
    return this.register<ImportPlan, ProjectImportPlanResult>(retained);
  }

  private async planReconcile(
    params: ProjectReconcilePlanParams,
    signal: AbortSignal,
    progress: MutationProgress,
  ): Promise<ProjectReconcilePlanResult> {
    const project = await this.session.handles.project(params.projectHandle);
    const source = await this.session.handles.revalidateContentSource(params.sourceHandle, { checkCancelled: () => check(signal) });
    progress("snapshot", 1, 1);
    progress("analyze", 1, 1);
    const authorities = await this.reconcileAuthorities(params, source, signal);
    if (source.plan.kind === "archive" && (
      params.sourceMapAuthority !== undefined || params.shardManifestHandle !== undefined ||
      params.acceptedSourceMapDigest !== undefined || params.acceptedSourceKindChange !== undefined ||
      params.acceptedNormalizationPolicyDigest !== undefined || params.collections !== undefined ||
      params.resolutions?.some((item) => item.choice === "source") === true
    )) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
    if (source.plan.kind === "directory" && params.sourceMapAuthority === undefined) throw new ProtocolError("ROOT_HANDLE_INVALID");
    if (source.plan.kind === "directory" && params.resolutions?.some((item) => item.choice === "archive") === true) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
    if (source.plan.kind === "directory" && (params.companionRenames?.length ?? 0) > 0 || source.plan.kind === "directory" && (params.companionRemovals?.length ?? 0) > 0) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
    progress("plan", 0, 1);
    const common = {
      root: project.record.root,
      ...(params.selections === undefined ? {} : { selections: params.selections }),
      ...(params.companions === undefined ? {} : { companions: params.companions }),
      ...(params.collections === undefined ? {} : { collections: params.collections }),
      ...(params.normalization === "exact-common" ? { normalize: "exact-common" as const } : {}),
      ...(authorities.normalizationMap === undefined ? {} : { normalizationMap: authorities.normalizationMap.path }),
      ...(params.acceptedNormalizationPolicyDigest === undefined ? {} : { acceptedNormalizationPolicyDigest: params.acceptedNormalizationPolicyDigest }),
    };
    let plan: ReconciliationPlan | DirectoryReconciliationPlan;
    if (source.plan.kind === "directory") {
      plan = await planDirectoryReconciliationWithHooks({
        ...common,
        source: { kind: "directory", path: source.plan.inputPath },
        sourceMap: authorities.sourceMap?.path ?? await this.session.handles.sourceContainedMapPath(params.sourceHandle),
        resolutions: (params.resolutions ?? []).map((item) => normalizedResolution(item, "directory")),
        renames: (params.renames ?? []).map((item) => `${stripAssetPrefix(item.from)}=${item.to}`),
        removals: (params.removals ?? []).map((item) => stripAssetPrefix(item.key)),
        ...(params.acceptedSourceMapDigest === undefined ? {} : { acceptedSourceMapDigest: params.acceptedSourceMapDigest }),
        ...(params.acceptedSourceKindChange === undefined ? {} : { acceptedSourceKindChanges: ["archive=directory"] }),
        ...(authorities.shardManifest === undefined ? {} : { shardManifest: authorities.shardManifest.path }),
      }, { checkCancelled: () => check(signal) });
    } else {
      const archiveOptions: ReconcileOptions = {
        root: project.record.root,
        archive: source.plan.inputPath,
        ...(params.selections === undefined ? {} : { selections: params.selections }),
        ...(params.companions === undefined ? {} : { companions: params.companions }),
        ...(params.resolutions === undefined ? {} : { resolutions: params.resolutions.map((item) => normalizedResolution(item, "archive")).map((item) => item.startsWith("asset:") ? item.slice("asset:".length) : item) }),
        ...(params.renames === undefined ? {} : { renames: params.renames.map((item) => `${stripAssetPrefix(item.from)}=${item.to}`) }),
        ...(params.companionRenames === undefined ? {} : { companionRenames: params.companionRenames.map((item) => `${stripCompanionPrefix(item.from)}=${item.to}`) }),
        ...(params.removals === undefined ? {} : { removals: params.removals.map((item) => stripAssetPrefix(item.key)) }),
        ...(params.companionRemovals === undefined ? {} : { companionRemovals: params.companionRemovals.map((item) => stripCompanionPrefix(item.key)) }),
        ...(params.normalization === "exact-common" ? { normalize: "exact-common" as const } : {}),
        ...(authorities.normalizationMap === undefined ? {} : { normalizationMap: authorities.normalizationMap.path }),
      };
      plan = await planReconciliationWithHooks(archiveOptions, { checkCancelled: () => check(signal) });
    }
    check(signal);
    const summary: ProjectReconcilePlanSummary = toSummary({
      sourceKind: source.plan.kind,
      changed: plan.changed,
      pending: plan.pending,
      blocked: plan.blocked,
      ...optional("sourceMapDigest", "sourceMapDigest" in plan ? plan.sourceMapDigest : undefined),
      ...optional("snapshotDigest", "snapshotDigest" in plan ? plan.snapshotDigest : undefined),
      records: plan.records.map((record) => ({
        key: record.key,
        kind: record.kind,
        classification: record.classification,
        plannedAction: record.plannedAction,
        requiredAuthority: record.requiredAuthority,
        blocker: record.blocker,
      })),
    });
    const authority = {
      sourceKind: source.plan.kind,
      ...(params.selections === undefined ? {} : { selections: params.selections }),
      ...(params.companions === undefined ? {} : { companions: params.companions }),
      ...(params.collections === undefined ? {} : { collections: params.collections }),
      ...(params.resolutions === undefined ? {} : { resolutions: params.resolutions }),
      ...(params.renames === undefined ? {} : { renames: params.renames }),
      ...(params.companionRenames === undefined ? {} : { companionRenames: params.companionRenames }),
      ...(params.removals === undefined ? {} : { removals: params.removals }),
      ...(params.companionRemovals === undefined ? {} : { companionRemovals: params.companionRemovals }),
      ...(params.normalization === undefined ? {} : { normalization: params.normalization }),
      ...(source.plan.kind === "directory" ? { sourceMapAuthority: sourceMapKind(params.sourceMapAuthority) } : {}),
      ...(params.acceptedSourceMapDigest === undefined ? {} : { acceptedSourceMapDigest: params.acceptedSourceMapDigest }),
      ...(params.acceptedSourceKindChange === undefined ? {} : { acceptedSourceKindChange: params.acceptedSourceKindChange }),
      ...(params.acceptedNormalizationPolicyDigest === undefined ? {} : { acceptedNormalizationPolicyDigest: params.acceptedNormalizationPolicyDigest }),
      ...auxiliaryDigestState(authorities),
    };
    const handles = authorityHandleState(this.session.handles, params.projectHandle, params.sourceHandle, authorities);
    const preState = {
      project: project.digest,
      source: sourceDigestState(source),
      ...auxiliaryDigestState(authorities),
    };
    if (source.plan.kind === "directory") {
      const directoryPlan = plan as DirectoryReconciliationPlan;
      const retained: PlanAuthority<DirectoryReconciliationPlan> = {
        plan: directoryPlan,
        summary,
        envelope: envelope(authority, handles, "project.reconcile.plan", preState, summary),
        bindings: this.bindings("project.reconcile.plan", params.projectHandle, params.sourceHandle, authorities),
        retention: inspectDirectoryReconciliationPlanRetention(directoryPlan),
        dispose: disposeDirectoryReconciliationPlan,
        revalidate: async (applySignal) => {
          await this.session.handles.revalidateProject(params.projectHandle, "existing");
          await this.session.handles.revalidateContentSource(params.sourceHandle, { checkCancelled: () => check(applySignal) });
          await this.revalidateAuthorities(authorities, applySignal);
        },
        execute: async (authenticPlan, lifecycle) => { await executeDirectoryReconciliationPlan(authenticPlan, lifecycle.transactionHooks()); },
        mutates: directoryPlan.changed,
      };
      progress("ready", 1, 1);
      return this.register<DirectoryReconciliationPlan, ProjectReconcilePlanResult>(retained);
    }
    const archivePlan = plan as ReconciliationPlan;
    const retained: PlanAuthority<ReconciliationPlan> = {
      plan: archivePlan,
      summary,
      envelope: envelope(authority, handles, "project.reconcile.plan", preState, summary),
      bindings: this.bindings("project.reconcile.plan", params.projectHandle, params.sourceHandle, authorities),
      retention: inspectReconciliationPlanRetention(archivePlan),
      dispose: () => undefined,
      revalidate: async (applySignal) => {
        await this.session.handles.revalidateProject(params.projectHandle, "existing");
        await this.session.handles.revalidateContentSource(params.sourceHandle, { checkCancelled: () => check(applySignal) });
        await this.revalidateAuthorities(authorities, applySignal);
      },
      execute: async (authenticPlan, lifecycle) => { await executeReconciliationPlan(authenticPlan, lifecycle.transactionHooks()); },
      mutates: archivePlan.changed,
    };
    progress("ready", 1, 1);
    return this.register<ReconciliationPlan, ProjectReconcilePlanResult>(retained);
  }

  private async planMigration(params: ProjectMigratePlanParams, signal: AbortSignal, progress: MutationProgress): Promise<ProjectMigratePlanResult> {
    const project = await this.session.handles.project(params.projectHandle);
    progress("snapshot", 1, 1);
    progress("plan", 0, 1);
    const plan = await planMigrationWithHooks({ root: project.record.root, check: false }, { checkCancelled: () => check(signal) });
    const summary: ProjectMigratePlanSummary = toSummary({
      fromSchemaVersion: plan.fromSchemaVersion,
      toSchemaVersion: 2,
      migrationNeeded: plan.migrationNeeded,
      assetCount: plan.assetCount,
      companionCount: plan.companionCount,
      svgEquivalentCount: plan.svgEquivalentCount,
      canonicalPaths: sortedPaths([
        plan.projectPath,
        ...plan.files.map((item) => item.path),
        ...plan.companionPaths,
        ...(plan.provenancePath === null ? [] : [plan.provenancePath]),
      ]),
    });
    const handles = { project: this.session.handles.bindingDigest(params.projectHandle) };
    const authority = { targetSchemaVersion: 2 };
    const preState = { project: project.digest, fromSchemaVersion: plan.fromSchemaVersion };
    const retained: PlanAuthority<MigrationPlan> = {
      plan,
      summary,
      envelope: envelope(authority, handles, "project.migrate.plan", preState, summary),
      bindings: { sessionNonce: this.session.nonce, method: "project.migrate.plan", root: handles.project },
      retention: inspectMigrationPlanRetention(plan),
      dispose: () => undefined,
      revalidate: async (applySignal) => { await this.session.handles.revalidateProject(params.projectHandle, "existing"); check(applySignal); },
      execute: async (authenticPlan, lifecycle) => { await executeMigration(authenticPlan, lifecycle.transactionHooks()); },
      mutates: plan.migrationNeeded,
    };
    progress("ready", 1, 1);
    return this.register<MigrationPlan, ProjectMigratePlanResult>(retained);
  }

  private async planFormat(params: ProjectFmtPlanParams, signal: AbortSignal, progress: MutationProgress): Promise<ProjectFmtPlanResult> {
    const project = await this.session.handles.project(params.projectHandle);
    progress("snapshot", 1, 1);
    progress("plan", 0, 1);
    const plan = await planFormatWithHooks(project.record.root, { checkCancelled: () => check(signal) });
    const canonicalPaths = formatPlanCanonicalPaths(plan);
    const summary: ProjectFmtPlanSummary = toSummary({ changed: plan.changed, fileCount: canonicalPaths.length, canonicalPaths });
    const handles = { project: this.session.handles.bindingDigest(params.projectHandle) };
    const retained: PlanAuthority<FormatPlan> = {
      plan,
      summary,
      envelope: envelope({}, handles, "project.fmt.plan", { project: project.digest }, summary),
      bindings: { sessionNonce: this.session.nonce, method: "project.fmt.plan", root: handles.project },
      retention: inspectFormatPlanRetention(plan),
      dispose: () => undefined,
      revalidate: async (applySignal) => { await this.session.handles.revalidateProject(params.projectHandle, "existing"); check(applySignal); },
      execute: async (authenticPlan, lifecycle) => { await executeFormat(authenticPlan, lifecycle.transactionHooks()); },
      mutates: plan.changed,
    };
    progress("ready", 1, 1);
    return this.register<FormatPlan, ProjectFmtPlanResult>(retained);
  }

  private async planBuild(params: ProjectBuildPlanParams, signal: AbortSignal, progress: MutationProgress): Promise<ProjectBuildPlanResult> {
    const project = await this.session.handles.project(params.projectHandle);
    progress("snapshot", 1, 1);
    progress("plan", 0, 1);
    const plan = await planBuildWithHooks(project.record.root, { checkCancelled: () => check(signal) });
    const outputs: BuildPlanOutputSummary[] = plan.outputs.map((output) => ({ filename: output.filename, size: output.size, sha256: rawBuildDigest(output.sha256) }));
    const summary: ProjectBuildPlanSummary = toSummary({
      buildDirectory: plan.buildDirectory,
      outputCount: outputs.length,
      outputs,
      replacingExisting: plan.replacingExisting,
      receiptDigest: computeSha256(serializeBuildReceipt(plan.receipt)),
    });
    const handles = { project: this.session.handles.bindingDigest(params.projectHandle) };
    const retained: PlanAuthority<BuildPlan> = {
      plan,
      summary,
      envelope: envelope({}, handles, "project.build.plan", { project: project.digest }, summary),
      bindings: { sessionNonce: this.session.nonce, method: "project.build.plan", root: handles.project },
      retention: inspectBuildPlanRetention(plan),
      dispose: () => undefined,
      revalidate: async (applySignal) => { await this.session.handles.revalidateProject(params.projectHandle, "existing"); check(applySignal); },
      execute: async (authenticPlan, lifecycle) => { await executeBuild(authenticPlan, lifecycle.buildHooks()); },
      mutates: true,
    };
    progress("ready", 1, 1);
    return this.register<BuildPlan, ProjectBuildPlanResult>(retained);
  }

  private async planInstall(params: ProjectInstallPlanParams, signal: AbortSignal, progress: MutationProgress): Promise<ProjectInstallPlanResult> {
    const project = await this.session.handles.project(params.projectHandle);
    progress("snapshot", 1, 1);
    progress("plan", 0, 1);
    const plan = await planInstallWithHooks(project.record.root, { checkCancelled: () => check(signal) });
    const summary: ProjectInstallPlanSummary = toSummary({
      itemCount: plan.items.length,
      items: plan.items.map((item) => ({ assetId: item.assetId, source: item.source, configuredDestination: item.configuredDestination })),
    });
    const handles = { project: this.session.handles.bindingDigest(params.projectHandle) };
    const retained: PlanAuthority<InstallPlan> = {
      plan,
      summary,
      envelope: envelope({}, handles, "project.install.plan", { project: project.digest }, summary),
      bindings: { sessionNonce: this.session.nonce, method: "project.install.plan", root: handles.project },
      retention: inspectInstallPlanRetention(plan),
      dispose: () => undefined,
      revalidate: async (applySignal) => { await this.session.handles.revalidateProject(params.projectHandle, "existing"); check(applySignal); },
      execute: async (authenticPlan, lifecycle) => { await executeInstall(authenticPlan, lifecycle.installHooks()); },
      mutates: true,
    };
    progress("ready", 1, 1);
    return this.register<InstallPlan, ProjectInstallPlanResult>(retained);
  }

  private async planPreview(params: PreviewPlanParams, signal: AbortSignal, progress: MutationProgress): Promise<PreviewPlanResult> {
    const project = await this.session.handles.project(params.projectHandle);
    progress("snapshot", 1, 1);
    progress("plan", 0, 1);
    const outputDirectory = params.outputDirectory ?? ".tfsb-preview";
    const plan = await planPreviewWithHooks({ root: project.record.root, output: outputDirectory, open: false }, { checkCancelled: () => check(signal) });
    const summary: PreviewPlanSummary = toSummary({
      outputDirectory: plan.outputDirectory,
      replaced: plan.replaced,
      assetCount: plan.assetCount,
      companionCount: plan.companionCount,
      fileCount: plan.assets.length + 3,
      buildExtraCount: plan.buildExtra.length,
    });
    const handles = { project: this.session.handles.bindingDigest(params.projectHandle) };
    const retained: PlanAuthority<PreviewPlan> = {
      plan,
      summary,
      envelope: envelope({ outputDirectory }, handles, "preview.plan", { project: project.digest }, summary),
      bindings: { sessionNonce: this.session.nonce, method: "preview.plan", root: handles.project },
      retention: inspectPreviewPlanRetention(plan),
      dispose: () => undefined,
      revalidate: async (applySignal) => { await this.session.handles.revalidateProject(params.projectHandle, "existing"); check(applySignal); },
      execute: async (authenticPlan, lifecycle) => { await executePreviewPlan(authenticPlan, lifecycle.previewHooks()); },
      mutates: true,
    };
    progress("ready", 1, 1);
    return this.register<PreviewPlan, PreviewPlanResult>(retained);
  }

  private bindings(method: StudioPlanMethod, projectHandle: string, sourceHandle: string, authorities: RoleBoundAuthorities): PlanBindings {
    return {
      sessionNonce: this.session.nonce,
      method,
      root: this.session.handles.bindingDigest(projectHandle),
      source: this.session.handles.bindingDigest(sourceHandle),
      auxiliary: Object.freeze([
        ...(authorities.sourceMapHandle === undefined ? [] : [this.session.handles.bindingDigest(authorities.sourceMapHandle)]),
        ...(authorities.normalizationMapHandle === undefined ? [] : [this.session.handles.bindingDigest(authorities.normalizationMapHandle)]),
        ...(authorities.shardManifestHandle === undefined ? [] : [this.session.handles.bindingDigest(authorities.shardManifestHandle)]),
      ]),
    };
  }

  private async importAuthorities(params: ProjectImportPlanParams, _source: ContentSourceRecord, signal: AbortSignal): Promise<RoleBoundAuthorities> {
    const sourceMap = params.sourceMapAuthority?.kind === "handle"
      ? await this.session.handles.revalidateAuxiliarySource(params.sourceMapAuthority.sourceMapHandle, "source-map")
      : undefined;
    const normalizationMap = params.normalizationMapHandle === undefined
      ? undefined
      : await this.session.handles.revalidateAuxiliarySource(params.normalizationMapHandle, "normalization-map");
    const shardManifest = params.shardManifestHandle === undefined
      ? undefined
      : await this.session.handles.revalidateAuxiliarySource(params.shardManifestHandle, "shard-manifest");
    check(signal);
    return roleBoundAuthorities({
      ...(sourceMap === undefined || params.sourceMapAuthority?.kind !== "handle" ? {} : { sourceMap, sourceMapHandle: params.sourceMapAuthority.sourceMapHandle }),
      ...(normalizationMap === undefined ? {} : { normalizationMap, normalizationMapHandle: params.normalizationMapHandle }),
      ...(shardManifest === undefined ? {} : { shardManifest, shardManifestHandle: params.shardManifestHandle }),
    });
  }

  private async reconcileAuthorities(params: ProjectReconcilePlanParams, _source: ContentSourceRecord, signal: AbortSignal): Promise<RoleBoundAuthorities> {
    const sourceMap = params.sourceMapAuthority?.kind === "handle"
      ? await this.session.handles.revalidateAuxiliarySource(params.sourceMapAuthority.sourceMapHandle, "source-map")
      : undefined;
    const normalizationMap = params.normalizationMapHandle === undefined
      ? undefined
      : await this.session.handles.revalidateAuxiliarySource(params.normalizationMapHandle, "normalization-map");
    const shardManifest = params.shardManifestHandle === undefined
      ? undefined
      : await this.session.handles.revalidateAuxiliarySource(params.shardManifestHandle, "shard-manifest");
    check(signal);
    return roleBoundAuthorities({
      ...(sourceMap === undefined || params.sourceMapAuthority?.kind !== "handle" ? {} : { sourceMap, sourceMapHandle: params.sourceMapAuthority.sourceMapHandle }),
      ...(normalizationMap === undefined ? {} : { normalizationMap, normalizationMapHandle: params.normalizationMapHandle }),
      ...(shardManifest === undefined ? {} : { shardManifest, shardManifestHandle: params.shardManifestHandle }),
    });
  }

  private async revalidateAuthorities(authorities: RoleBoundAuthorities, signal: AbortSignal): Promise<void> {
    if (authorities.sourceMapHandle !== undefined) await this.session.handles.revalidateAuxiliarySource(authorities.sourceMapHandle, "source-map");
    if (authorities.normalizationMapHandle !== undefined) await this.session.handles.revalidateAuxiliarySource(authorities.normalizationMapHandle, "normalization-map");
    if (authorities.shardManifestHandle !== undefined) await this.session.handles.revalidateAuxiliarySource(authorities.shardManifestHandle, "shard-manifest");
    check(signal);
  }

  private register<TPlan extends DomainPlan, TResult>(
    authority: PlanAuthority<TPlan>,
  ): TResult {
    let privateBytes: number;
    try { privateBytes = authorityPlanBytes(authority); }
    catch (error) {
      authority.dispose(authority.plan);
      throw error;
    }
    const registry = this.registry();
    const result = registry.register({
      method: authority.envelope.method as StudioPlanMethod,
      plan: authority,
      summary: authority.summary,
      envelope: authority.envelope,
      bindings: authority.bindings,
      planPrivateBytes: privateBytes,
      nativeSnapshot: authority.retention.nativeSnapshot === "directory",
      dispose: (retained) => retained.dispose(retained.plan),
    });
    return result as unknown as TResult;
  }

  private discard(params: PlanDiscardParams): { readonly discarded: true } {
    return this.registry().discard({ sessionNonce: params.sessionNonce, planToken: params.planToken });
  }

  private async apply(params: PlanApplyParams, signal: AbortSignal, progress: MutationProgress): Promise<PlanApplyResult> {
    check(signal);
    return await this.registry().apply({
      sessionNonce: params.sessionNonce,
      planToken: params.planToken,
      expectedPlanDigest: params.expectedPlanDigest,
      signal,
    }, async (authority, authenticated) => {
      const retained = authority as PlanAuthority<DomainPlan>;
      const lifecycle = makeLifecycle(signal, progress);
      try {
        progress("revalidate", 0, 1);
        await retained.revalidate(signal);
        progress("revalidate", 1, 1);
        lifecycle.check();
        if (retained.mutates) progress("waiting-lock", 0, 1);
        await retained.execute(retained.plan, lifecycle);
        if (lifecycle.didReachStaging()) {
          progress("cleanup", 0, 1);
          progress("cleanup", 1, 1);
        }
        progress("complete", 1, 1);
        return { applied: true, method: authenticated.method as StudioPlanMethod };
      } catch (error) {
        if (lifecycle.didReachStaging()) progress("cleanup", 1, 1);
        throw mapApplyFailure(error, signal, lifecycle.didReachPromotion());
      }
    });
  }
}

export type { AuxiliarySourcePurpose, AuxiliarySourceRecord, ProjectRecord, SourceRecord };
