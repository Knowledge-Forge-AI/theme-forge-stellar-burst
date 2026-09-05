export const STUDIO_PROTOCOL_IDENTIFIER = "tfsb.studio" as const;
export const STUDIO_PROTOCOL_VERSION = "1.0" as const;
export const STUDIO_PROTOCOL_VERSION_1_0 = "1.0" as const;
export const STUDIO_PROTOCOL_VERSION_1_1 = "1.1" as const;
export const STUDIO_PROTOCOL_VERSION_1_2 = "1.2" as const;
export const STUDIO_PROTOCOL_LATEST_VERSION = STUDIO_PROTOCOL_VERSION_1_2;

export type ProtocolVersionV1 = typeof STUDIO_PROTOCOL_VERSION;
export type StudioProtocolVersion = typeof STUDIO_PROTOCOL_VERSION_1_0 | typeof STUDIO_PROTOCOL_VERSION_1_1 | typeof STUDIO_PROTOCOL_VERSION_1_2;
export type JsonRpcId = string | number;
export type WorkspaceHandle = `workspace_${string}`;
export type ProjectHandle = `project_${string}`;
export type SourceHandle = `source_${string}`;
export type ServiceCursor = string;
export type Sha256Digest = `sha256:${string}`;

export type ProjectOpenMode = "existing" | "import-target";
export type SourcePurpose = "content" | "source-map" | "normalization-map" | "shard-manifest";
export type SourcePurposeV1_1 = SourcePurpose | "brand-bundle" | "npm-installed-package";

export type StudioBrandReadMethod =
  | "brand.status" | "brand.family.list" | "brand.token.list" | "brand.recipe.graph"
  | "brand.qa.profile.get" | "brand.qa.result.get" | "brand.diff"
  | "brand.consumer.profile.list" | "brand.consumer.lock.status"
  | "brand.export.capability" | "brand.export.status";
export type StudioBrandReadMethodV1_2 = "brand.qa.profile.list" | "brand.visual.evidence.get";
export type StudioBrandReadMethodLatest = StudioBrandReadMethod | StudioBrandReadMethodV1_2;
export type StudioBrandPlanMethod =
  | "brand.derive.plan" | "brand.qa.baseline.plan" | "brand.consumer.install.plan"
  | "brand.consumer.sync.plan" | "brand.export.plan";

export type StudioPlanMethod =
  | "asset.edit.plan"
  | "project.import.plan"
  | "project.reconcile.plan"
  | "project.migrate.plan"
  | "project.fmt.plan"
  | "project.build.plan"
  | "project.install.plan"
  | "preview.plan"
  | StudioBrandPlanMethod;
export type StudioMutationMethod = StudioPlanMethod | "plan.discard" | "plan.apply";

export type StudioApplicationErrorCode =
  | "INVALID_REQUEST_ID"
  | "PROTOCOL_VERSION_UNSUPPORTED"
  | "SESSION_NOT_INITIALIZED"
  | "SESSION_NONCE_INVALID"
  | "ROOT_INVALID"
  | "ROOT_HANDLE_INVALID"
  | "METHOD_CAPABILITY_UNAVAILABLE"
  | "REQUEST_BUSY"
  | "REQUEST_CANCELLED"
  | "PLAN_TOKEN_INVALID"
  | "PLAN_STALE"
  | "PLAN_DIGEST_MISMATCH"
  | "CURSOR_INVALID"
  | "CURSOR_STALE"
  | "DOMAIN_OPERATION_FAILED"
  | "MESSAGE_TOO_LARGE";

export type StudioStandardErrorCode =
  | "PARSE_ERROR"
  | "INVALID_REQUEST"
  | "METHOD_NOT_FOUND"
  | "INVALID_PARAMS"
  | "INTERNAL_ERROR";

export type StudioErrorCode = StudioStandardErrorCode | StudioApplicationErrorCode;

export interface StudioErrorData {
  readonly code: StudioErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly location?: string;
}

export interface StudioCapabilitiesV1 {
  readonly methods: {
    readonly workspaceOpen: true;
    readonly projectOpen: true;
    readonly sourceOpen: true;
    readonly workspaceStatus: true;
    readonly projectList: true;
    readonly assetList: true;
    readonly assetGet: true;
    readonly assetValidate: true;
    readonly assetDiff: true;
    readonly sourceAnalyze: true;
    readonly previewStatus: true;
    readonly progress: true;
    readonly cancellation: true;
    readonly mutationPlans: true;
    readonly planApply: true;
  };
  readonly limits: {
    readonly maxFrameBytes: 16_777_216;
    readonly maxConcurrentReads: 4;
    readonly maxQueuedReads: 4;
    readonly assetPageSizeMin: 1;
    readonly assetPageSizeDefault: 64;
    readonly assetPageSizeMax: 128;
    readonly sourceDetailPageSizeMin: 1;
    readonly sourceDetailPageSizeDefault: 64;
    readonly sourceDetailPageSizeMax: 128;
    readonly maxActivePlans: 4;
    readonly maxRetainedPlanBytes: 201_326_592;
    readonly maxRetainedNativeSnapshotPlans: 1;
    readonly planTtlMs: 600_000;
    readonly maxConcurrentApplies: 1;
  };
}

export interface StudioBrandCapabilityV1_1 {
  readonly schemaVersion: 1;
  readonly methods: {
    readonly status: true; readonly familyList: true; readonly tokenList: true;
    readonly recipeGraph: true; readonly qaProfileGet: true; readonly qaResultGet: true;
    readonly diff: true; readonly consumerProfileList: true; readonly consumerLockStatus: true;
    readonly exportCapability: true; readonly exportStatus: true; readonly derivePlan: true;
    readonly qaBaselinePlan: boolean; readonly consumerInstallPlan: true;
    readonly consumerSyncPlan: true; readonly exportPlan: boolean;
  };
  readonly sourcePurposes: { readonly brandBundle: true; readonly npmInstalledPackage: true };
  readonly raster: { readonly available: false } | {
    readonly available: true; readonly adapterId: "resvg-png-v1";
    readonly rendererVersion: string; readonly qualificationId: string; readonly platformClaim: "darwin-arm64";
  };
  readonly limits: {
    readonly pageSizeMin: 1; readonly pageSizeDefault: 64; readonly pageSizeMax: 128;
    readonly maxSourcePackages: 8; readonly maxSelectedProfiles: 8;
    readonly maxQaResultBytes: 16_777_216; readonly maxDiffResultBytes: 16_777_216;
    readonly maxExportOutputs: 128;
  };
}

export interface StudioCapabilitiesV1_1 extends StudioCapabilitiesV1 {
  readonly brand: StudioBrandCapabilityV1_1;
}

export interface StudioBrandCapabilityV1_2 extends Omit<StudioBrandCapabilityV1_1, "methods"> {
  readonly methods: StudioBrandCapabilityV1_1["methods"] & {
    readonly qaProfileList: true;
    readonly visualEvidenceGet: boolean;
  };
  readonly visualEvidence: { readonly available: false } | {
    readonly available: true;
    readonly mediaTypes: readonly ["image/png"];
    readonly encoding: "base64";
    readonly maxDimension: 1024;
    readonly maxPixels: 1_048_576;
    readonly maxArtifactBytes: 6_291_456;
    readonly maxAggregateArtifactBytes: 8_388_608;
    readonly maxResultBytes: 12_582_912;
    readonly maxArtifacts: 2;
  };
}

export interface StudioCapabilitiesV1_2 extends StudioCapabilitiesV1 {
  readonly brand: StudioBrandCapabilityV1_2;
}

export interface InitializeParams {
  readonly protocol: "tfsb.studio";
  readonly minVersion: ProtocolVersionV1;
  readonly maxVersion: ProtocolVersionV1;
  readonly client: { readonly name: string; readonly version: string };
  readonly capabilities: { readonly progress: boolean; readonly cancellation: boolean };
}

export interface InitializeResult {
  readonly protocol: "tfsb.studio";
  readonly selectedVersion: ProtocolVersionV1;
  readonly server: { readonly name: "tfsb-studio-service"; readonly version: string };
  readonly sessionNonce: string;
  readonly capabilities: StudioCapabilitiesV1;
}

export interface InitializeParamsV1_1 {
  readonly protocol: "tfsb.studio";
  readonly minVersion: StudioProtocolVersion;
  readonly maxVersion: StudioProtocolVersion;
  readonly client: { readonly name: string; readonly version: string };
  readonly capabilities: { readonly progress: boolean; readonly cancellation: boolean };
}

export interface InitializeResultV1_1 {
  readonly protocol: "tfsb.studio";
  readonly selectedVersion: "1.1";
  readonly server: { readonly name: "tfsb-studio-service"; readonly version: string };
  readonly sessionNonce: string;
  readonly capabilities: StudioCapabilitiesV1_1;
}

export interface InitializeResultV1_2 {
  readonly protocol: "tfsb.studio";
  readonly selectedVersion: "1.2";
  readonly server: { readonly name: "tfsb-studio-service"; readonly version: string };
  readonly sessionNonce: string;
  readonly capabilities: StudioCapabilitiesV1_2;
}

export interface SessionParams { readonly sessionNonce: string }
export interface WorkspaceOpenParams extends SessionParams { readonly path: string }
export interface ProjectOpenParams extends SessionParams { readonly path: string; readonly mode?: ProjectOpenMode }
export interface SourceOpenParams extends SessionParams { readonly path: string; readonly purpose?: SourcePurpose }
export interface SourceOpenParamsV1_1 extends SessionParams { readonly path: string; readonly purpose?: SourcePurposeV1_1 }
export interface WorkspaceStatusParams extends SessionParams {
  readonly workspaceHandle: WorkspaceHandle;
  readonly mode: "discovery" | "check";
}
export interface ProjectListParams extends SessionParams { readonly projectHandle: ProjectHandle }

export type AssetListScope =
  | { readonly kind: "project"; readonly projectHandle: ProjectHandle }
  | { readonly kind: "workspace"; readonly workspaceHandle: WorkspaceHandle };
export interface AssetListParams extends SessionParams {
  readonly scope: AssetListScope;
  readonly pageSize: number;
  readonly cursor?: ServiceCursor;
}

export type AssetGetScope =
  | { readonly kind: "project"; readonly projectHandle: ProjectHandle; readonly assetId: string }
  | { readonly kind: "workspace"; readonly workspaceHandle: WorkspaceHandle; readonly projectId: string; readonly assetId: string };
export interface AssetGetParams extends SessionParams { readonly scope: AssetGetScope }
export interface AssetValidateParams extends SessionParams {
  readonly projectHandle: ProjectHandle;
  readonly assetId: string;
  readonly toml: string;
}
export interface AssetDiffParams extends AssetValidateParams {}
export interface SourceAnalyzeParams extends SessionParams {
  readonly sourceHandle: SourceHandle;
  readonly includeDetails: boolean;
  readonly pageSize: number;
  readonly cursor?: ServiceCursor;
}
export interface PreviewStatusParams extends SessionParams { readonly projectHandle: ProjectHandle }
export interface CancelRequestParams extends SessionParams { readonly id: JsonRpcId }
export interface ExitParams {}

export type SourceMapAuthority =
  | { readonly kind: "source-contained" }
  | { readonly kind: "handle"; readonly sourceMapHandle: SourceHandle };

export interface AssetEditPlanParams extends SessionParams {
  readonly projectHandle: ProjectHandle;
  readonly assetId: string;
  readonly proposedToml: string;
}

export type ImportArchiveMode = "ordinary" | "manifest";
export type ImportNormalization = "none" | "exact-common";

export interface ProjectImportPlanParams extends SessionParams {
  readonly projectHandle: ProjectHandle;
  readonly sourceHandle: SourceHandle;
  readonly schemaVersion: 2;
  readonly archiveMode?: ImportArchiveMode;
  readonly selections?: readonly string[];
  readonly companions?: readonly string[];
  readonly collections?: readonly string[];
  readonly normalization?: ImportNormalization;
  readonly normalizationMapHandle?: SourceHandle;
  readonly sourceMapAuthority?: SourceMapAuthority;
  readonly shardManifestHandle?: SourceHandle;
}

export type ReconcileChoice = "archive" | "canonical" | "source";
export interface ReconcileResolution {
  readonly key: string;
  readonly choice: ReconcileChoice;
}
export interface ReconcileRename {
  readonly from: string;
  readonly to: string;
}
export interface ReconcileRemoval { readonly key: string }

export interface ProjectReconcilePlanParams extends SessionParams {
  readonly projectHandle: ProjectHandle;
  readonly sourceHandle: SourceHandle;
  readonly selections?: readonly string[];
  readonly companions?: readonly string[];
  readonly collections?: readonly string[];
  readonly resolutions?: readonly ReconcileResolution[];
  readonly renames?: readonly ReconcileRename[];
  readonly companionRenames?: readonly ReconcileRename[];
  readonly removals?: readonly ReconcileRemoval[];
  readonly companionRemovals?: readonly ReconcileRemoval[];
  readonly normalization?: ImportNormalization;
  readonly normalizationMapHandle?: SourceHandle;
  readonly sourceMapAuthority?: SourceMapAuthority;
  readonly shardManifestHandle?: SourceHandle;
  readonly acceptedSourceMapDigest?: Sha256Digest;
  readonly acceptedSourceKindChange?: "archive-to-directory";
  readonly acceptedNormalizationPolicyDigest?: Sha256Digest;
}

export interface ProjectMigratePlanParams extends SessionParams {
  readonly projectHandle: ProjectHandle;
  readonly targetSchemaVersion: 2;
}
export interface ProjectFmtPlanParams extends SessionParams { readonly projectHandle: ProjectHandle }
export interface ProjectBuildPlanParams extends SessionParams { readonly projectHandle: ProjectHandle }
export interface ProjectInstallPlanParams extends SessionParams { readonly projectHandle: ProjectHandle }
export interface PreviewPlanParams extends SessionParams {
  readonly projectHandle: ProjectHandle;
  readonly outputDirectory?: string;
}
export interface PlanDiscardParams extends SessionParams { readonly planToken: string }
export interface PlanApplyParams extends SessionParams {
  readonly planToken: string;
  readonly expectedPlanDigest: Sha256Digest;
}

export interface BrandProjectParams extends SessionParams { readonly projectHandle: ProjectHandle }
export interface BrandPageParams extends BrandProjectParams { readonly pageSize: number; readonly cursor?: ServiceCursor }
export interface BrandQaProfileParams extends BrandProjectParams { readonly profileId: string }
export interface BrandQaProfileListParams extends BrandPageParams {}
export interface BrandDiffParams extends BrandProjectParams { readonly sourceHandle: SourceHandle }
export interface BrandConsumerSourcesParams extends BrandProjectParams { readonly sourceHandles?: readonly SourceHandle[] }
export interface BrandConsumerProfileListParams extends BrandConsumerSourcesParams { readonly pageSize: number; readonly cursor?: ServiceCursor }
export interface BrandDerivePlanParams extends BrandProjectParams {
  readonly selection: { readonly kind: "all" } | { readonly kind: "recipes"; readonly recipeIds: readonly string[] };
}
export interface BrandQaBaselinePlanParams extends BrandQaProfileParams { readonly caseId: string }
export interface BrandConsumerParameterSelection {
  readonly profileId: string;
  readonly values: readonly { readonly parameter: string; readonly value: string }[];
}
export interface BrandConsumerPlanParams extends BrandProjectParams {
  readonly sourceHandles: readonly SourceHandle[];
  readonly profiles?: readonly string[];
  readonly parameters?: readonly BrandConsumerParameterSelection[];
}
export interface BrandExportPlanParams extends BrandQaProfileParams { readonly outputIds?: readonly string[] }

export type BrandVisualTarget =
  | { readonly kind: "asset"; readonly assetId: string }
  | { readonly kind: "binding"; readonly family: string; readonly role: string; readonly variant: string };
export type BrandVisualEvidenceParams =
  | (BrandProjectParams & { readonly kind: "project-render"; readonly target: BrandVisualTarget; readonly width: number; readonly height: number; readonly background: string })
  | (BrandProjectParams & { readonly kind: "qa-baseline"; readonly profileId: string; readonly caseId: string })
  | (BrandProjectParams & { readonly kind: "brand-diff"; readonly sourceHandle: SourceHandle; readonly target: BrandVisualTarget; readonly width: number; readonly height: number; readonly background: string });

export type StudioRequest =
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "initialize"; readonly params: InitializeParams | InitializeParamsV1_1 }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "shutdown"; readonly params: SessionParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "workspace.open"; readonly params: WorkspaceOpenParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "project.open"; readonly params: ProjectOpenParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "source.open"; readonly params: SourceOpenParams | SourceOpenParamsV1_1 }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "workspace.status"; readonly params: WorkspaceStatusParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "project.list"; readonly params: ProjectListParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "asset.list"; readonly params: AssetListParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "asset.get"; readonly params: AssetGetParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "asset.validate"; readonly params: AssetValidateParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "asset.diff"; readonly params: AssetDiffParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "source.analyze"; readonly params: SourceAnalyzeParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "preview.status"; readonly params: PreviewStatusParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "asset.edit.plan"; readonly params: AssetEditPlanParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "project.import.plan"; readonly params: ProjectImportPlanParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "project.reconcile.plan"; readonly params: ProjectReconcilePlanParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "project.migrate.plan"; readonly params: ProjectMigratePlanParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "project.fmt.plan"; readonly params: ProjectFmtPlanParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "project.build.plan"; readonly params: ProjectBuildPlanParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "project.install.plan"; readonly params: ProjectInstallPlanParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "preview.plan"; readonly params: PreviewPlanParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.status"; readonly params: BrandProjectParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.family.list"; readonly params: BrandPageParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.token.list"; readonly params: BrandPageParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.recipe.graph"; readonly params: BrandProjectParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.qa.profile.get"; readonly params: BrandQaProfileParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.qa.profile.list"; readonly params: BrandQaProfileListParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.qa.result.get"; readonly params: BrandQaProfileParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.diff"; readonly params: BrandDiffParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.consumer.profile.list"; readonly params: BrandConsumerProfileListParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.consumer.lock.status"; readonly params: BrandConsumerSourcesParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.export.capability"; readonly params: BrandProjectParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.export.status"; readonly params: BrandPageParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.visual.evidence.get"; readonly params: BrandVisualEvidenceParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.derive.plan"; readonly params: BrandDerivePlanParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.qa.baseline.plan"; readonly params: BrandQaBaselinePlanParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.consumer.install.plan"; readonly params: BrandConsumerPlanParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.consumer.sync.plan"; readonly params: BrandConsumerPlanParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "brand.export.plan"; readonly params: BrandExportPlanParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "plan.discard"; readonly params: PlanDiscardParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: "plan.apply"; readonly params: PlanApplyParams };

export type StudioClientNotification =
  | { readonly jsonrpc: "2.0"; readonly method: "initialized"; readonly params: SessionParams }
  | { readonly jsonrpc: "2.0"; readonly method: "$/cancelRequest"; readonly params: CancelRequestParams }
  | { readonly jsonrpc: "2.0"; readonly method: "exit"; readonly params: ExitParams };

export interface ProgressParams {
  readonly requestId: JsonRpcId;
  readonly stage: StudioProgressStage;
  readonly completed: number;
  readonly total?: number;
}
export type ReadProgressStage = "started" | "scanning" | "complete";
export type PlanProgressStage = "validate" | "snapshot" | "analyze" | "plan" | "ready";
export type ApplyProgressStage = "revalidate" | "waiting-lock" | "staging" | "promoting" | "cleanup" | "complete";
export type StudioProgressStage = ReadProgressStage | PlanProgressStage | ApplyProgressStage;
export interface StudioProgressNotification {
  readonly jsonrpc: "2.0";
  readonly method: "$/progress";
  readonly params: ProgressParams;
}

export type StudioInboundMessage = StudioRequest | StudioClientNotification;

export interface WorkspaceOpenResult {
  readonly workspaceHandle: WorkspaceHandle;
  readonly rootKind: "workspace";
  readonly workspaceId: string;
  readonly name: string;
  readonly manifestDigest: string;
  readonly childCount: number;
  readonly diagnostics: readonly [];
}
export interface ProjectOpenResult {
  readonly projectHandle: ProjectHandle;
  readonly rootKind: "project";
  readonly schemaVersion: 1 | 2;
  readonly name: string;
  readonly canonicalDigest: string;
  readonly assetCount: number;
  readonly companionCount: number;
}
export interface UninitializedProjectOpenResult {
  readonly projectHandle: ProjectHandle;
  readonly rootKind: "project";
  readonly state: "uninitialized";
}
export type ProjectOpenResponse = ProjectOpenResult | UninitializedProjectOpenResult;
export interface SourceOpenContentResult {
  readonly sourceHandle: SourceHandle;
  readonly rootKind: "source";
  readonly sourceKind: AnalyzeInputKind;
  readonly digest: string;
  readonly candidateCount: number;
  readonly capabilities: { readonly analyze: true; readonly mutation: false };
}
export interface SourceOpenAuxiliaryResult {
  readonly sourceHandle: SourceHandle;
  readonly rootKind: "source";
  readonly authorityKind: Exclude<SourcePurpose, "content">;
  readonly byteDigest: Sha256Digest;
  readonly semanticDigest: Sha256Digest;
  readonly byteLength: number;
  readonly capabilities: { readonly analyze: false; readonly mutationAuthority: true };
}
export interface SourceOpenBrandResult {
  readonly sourceHandle: SourceHandle;
  readonly rootKind: "source";
  readonly authorityKind: "brand-bundle" | "npm-installed-package";
  readonly packageId: string;
  readonly brandVersion: string;
  readonly brandSystemDigest: Sha256Digest;
  readonly brandManifestDigest: Sha256Digest;
  readonly consumerProfilesDigest: Sha256Digest;
  readonly profileCount: number;
  readonly assetCount: number;
  readonly companionCount: number;
  readonly npmName?: string;
  readonly npmVersion?: string;
  readonly capabilities: { readonly analyze: false; readonly brandDiff: true; readonly consumerSource: true };
}
export type SourceOpenResult = SourceOpenContentResult | SourceOpenAuxiliaryResult | SourceOpenBrandResult;

export interface AssetEditSemanticChange extends ArchiveSemanticChange {}
export interface AssetEditPlanSummary {
  readonly assetId: string;
  readonly affectedCanonicalPath: string;
  readonly oldDigest: Sha256Digest;
  readonly newDigest: Sha256Digest;
  readonly changed: boolean;
  readonly changes: readonly AssetEditSemanticChange[];
}
export interface ProjectImportPlanSummary {
  readonly sourceKind: AnalyzeInputKind;
  readonly schemaVersion: 2;
  readonly assetCount: number;
  readonly companionCount: number;
  readonly canonicalFileCount: number;
  readonly normalizationPolicyDigest?: Sha256Digest;
  readonly sourceMapDigest?: Sha256Digest;
  readonly snapshotDigest?: Sha256Digest;
  readonly willInitialize: true;
}
export type ReconciliationClassification =
  | "UNCHANGED"
  | "UNCHANGED_ACCEPTED_DIVERGENCE"
  | "ARCHIVE_CHANGED"
  | "CANONICAL_EDITED"
  | "CONVERGED"
  | "CONFLICT"
  | "ARCHIVE_OMISSION"
  | "ARCHIVE_OMISSION_CANONICAL_EDITED"
  | "UNCHANGED_ACCEPTED_ABSENCE"
  | "CONVERGED_ABSENCE"
  | "CANONICAL_MISSING"
  | "UNTRACKED_MATCH"
  | "UNTRACKED_CONFLICT"
  | "NEW_ASSET"
  | "COMPANION_CHANGED"
  | "NEW_COMPANION"
  | "RENAMED"
  | "COMPANION_RENAMED"
  | "REMOVED"
  | "COMPANION_REMOVED"
  | "POLICY_AUTHORITY_REQUIRED"
  | "SOURCE_CHANGED"
  | "SOURCE_FORMATTING_ONLY"
  | "CANONICAL_CHANGED"
  | "BOTH_CHANGED"
  | "SOURCE_OMISSION"
  | "NEW_SOURCE"
  | "ACCEPTED_CANONICAL_DIVERGENCE"
  | "ACCEPTED_SOURCE_ABSENCE"
  | "RENAME_REQUIRED"
  | "REMOVE_REQUIRED"
  | "SOURCE_MAP_AUTHORITY_REQUIRED"
  | "SOURCE_KIND_AUTHORITY_REQUIRED";
export type ReconciliationPlannedAction =
  | "none"
  | "replace_canonical"
  | "update_provenance"
  | "add_canonical"
  | "retain"
  | "resolve"
  | "rename"
  | "remove"
  | "blocked_collision";
export type ReconciliationRequiredAuthority =
  | "none"
  | "resolve"
  | "rename"
  | "remove"
  | "source-map"
  | "source-kind"
  | "policy";
export interface ReconciliationRecordSummary {
  readonly key: string;
  readonly kind: "asset" | "companion";
  readonly classification: ReconciliationClassification;
  readonly plannedAction: ReconciliationPlannedAction;
  readonly requiredAuthority: ReconciliationRequiredAuthority;
  readonly blocker: boolean;
}
export interface ProjectReconcilePlanSummary {
  readonly sourceKind: AnalyzeInputKind;
  readonly changed: boolean;
  readonly pending: boolean;
  readonly blocked: boolean;
  readonly sourceMapDigest?: Sha256Digest;
  readonly snapshotDigest?: Sha256Digest;
  readonly records: readonly ReconciliationRecordSummary[];
}
export interface ProjectMigratePlanSummary {
  readonly fromSchemaVersion: 1 | 2;
  readonly toSchemaVersion: 2;
  readonly migrationNeeded: boolean;
  readonly assetCount: number;
  readonly companionCount: number;
  readonly svgEquivalentCount: number;
  readonly canonicalPaths: readonly string[];
}
export interface ProjectFmtPlanSummary {
  readonly changed: boolean;
  readonly fileCount: number;
  readonly canonicalPaths: readonly string[];
}
export interface BuildPlanOutputSummary {
  readonly filename: string;
  readonly size: number;
  readonly sha256: Sha256Digest;
}
export interface ProjectBuildPlanSummary {
  readonly buildDirectory: string;
  readonly outputCount: number;
  readonly outputs: readonly BuildPlanOutputSummary[];
  readonly replacingExisting: boolean;
  readonly receiptDigest: Sha256Digest;
}
export interface InstallPlanItemSummary {
  readonly assetId: string;
  readonly source: string;
  readonly configuredDestination: string;
}
export interface ProjectInstallPlanSummary {
  readonly itemCount: number;
  readonly items: readonly InstallPlanItemSummary[];
}
export interface PreviewPlanSummary {
  readonly outputDirectory: string;
  readonly replaced: boolean;
  readonly assetCount: number;
  readonly companionCount: number;
  readonly fileCount: number;
  readonly buildExtraCount: number;
}
export type StudioPlanSummary =
  | AssetEditPlanSummary
  | ProjectImportPlanSummary
  | ProjectReconcilePlanSummary
  | ProjectMigratePlanSummary
  | ProjectFmtPlanSummary
  | ProjectBuildPlanSummary
  | ProjectInstallPlanSummary
  | PreviewPlanSummary
  | BrandDerivePlanSummary
  | BrandQaBaselinePlanSummary
  | ConsumerPlanSummary
  | BrandRasterExportPlanSummary;
export interface StudioPlanResult<TSummary> {
  readonly planToken: string;
  readonly planDigest: Sha256Digest;
  readonly expiresInMs: 600_000;
  readonly method: StudioPlanMethod;
  readonly summary: TSummary;
}
export type AssetEditPlanResult = StudioPlanResult<AssetEditPlanSummary>;
export type ProjectImportPlanResult = StudioPlanResult<ProjectImportPlanSummary>;
export type ProjectReconcilePlanResult = StudioPlanResult<ProjectReconcilePlanSummary>;
export type ProjectMigratePlanResult = StudioPlanResult<ProjectMigratePlanSummary>;
export type ProjectFmtPlanResult = StudioPlanResult<ProjectFmtPlanSummary>;
export type ProjectBuildPlanResult = StudioPlanResult<ProjectBuildPlanSummary>;
export type ProjectInstallPlanResult = StudioPlanResult<ProjectInstallPlanSummary>;
export type PreviewPlanResult = StudioPlanResult<PreviewPlanSummary>;
export interface PlanDiscardResult { readonly discarded: true }
export type PlanApplyResult = null | { readonly applied: true; readonly method: StudioPlanMethod };
export interface WorkspaceDiscoveryStatusResult {
  readonly workspaceId: string;
  readonly name: string;
  readonly digest: string;
  readonly totalProjects: number;
  readonly loadable: number;
  readonly failed: number;
  readonly diagnostics: readonly { readonly code: string; readonly location: string | null }[];
}
export type WorkspaceStatusResult = WorkspaceDiscoveryStatusResult | WorkspaceCheckResult;
export type ProjectListResult = ProjectInventory;
export interface AssetListItem {
  readonly assetId: string;
  readonly filename?: string;
  readonly projectId?: string;
  readonly qualifiedIdentity?: string;
  readonly collections?: readonly string[];
  readonly buildPath?: string;
  readonly destinations?: readonly string[];
}
export interface AssetListResult {
  readonly scope: { readonly kind: "project" | "workspace"; readonly workspaceId?: string };
  readonly page: { readonly size: number; readonly count: number; readonly items: readonly AssetListItem[]; readonly nextCursor: ServiceCursor | null };
  readonly viewDigest: string;
}
export interface AssetGetResult {
  readonly assetId: string;
  readonly canonicalToml: string;
  readonly model: AnyNormalizedAsset;
  readonly canonicalSvg: string;
  readonly digests: { readonly rawToml: string; readonly semantic: string; readonly svg: string };
}
export type AssetValidationResult =
  | { readonly valid: false; readonly diagnostics: readonly { readonly code: string; readonly message: string; readonly location?: string }[] }
  | { readonly valid: true; readonly model: AnyNormalizedAsset; readonly canonicalToml: string; readonly digests: { readonly rawToml: string; readonly semantic: string } };
export type AssetDiffResult =
  | Extract<AssetValidationResult, { readonly valid: false }>
  | { readonly valid: true; readonly different: boolean; readonly changes: readonly ArchiveSemanticChange[]; readonly proposedDigest: string };
export interface SourceAnalyzeResult {
  readonly sourceKind: AnalyzeInputKind;
  readonly status: "ok" | "drift" | "error";
  readonly summary: Pick<AnalyzeJsonData, "totals" | "profiles" | "resourceObservations" | "identity">;
  readonly details: {
    readonly count: number;
    readonly items: readonly Pick<AnalyzeDetailsFile, "path" | "derivedAssetId" | "profiles">[];
    readonly nextCursor: ServiceCursor | null;
  };
}
export type PreviewStatusResult =
  | { readonly status: "absent" | "unowned/invalid"; readonly outputIdentity: ".tfsb-preview"; readonly markerDigest: string | null }
  | { readonly status: "owned-clean" | "owned-drift"; readonly outputIdentity: ".tfsb-preview"; readonly markerDigest: string; readonly assetCount: number };

export type BrandStatusResult =
  | { readonly present: false; readonly raster: { readonly available: boolean } }
  | {
    readonly present: true;
    readonly schemaVersion: 1;
    readonly brandDigest: Sha256Digest;
    readonly brandSystemDigest: Sha256Digest | null;
    readonly domains: readonly { readonly domain: string; readonly state: string; readonly digest: Sha256Digest | null }[];
    readonly counts: {
      readonly families: number; readonly roles: number; readonly variants: number;
      readonly bindings: number; readonly requirements: number; readonly tokens: number;
      readonly recipes: number; readonly qaProfiles: number; readonly qaCases: number; readonly qaBaselines: number;
      readonly consumerProfiles: number; readonly exportProfiles: number;
    };
    readonly completeness: { readonly satisfied: boolean; readonly familyCount: number; readonly variantCount: number; readonly bindingCount: number; readonly requirementCount: number };
    readonly derived: Readonly<Record<string, number>>;
    readonly consumerLock: { readonly present: boolean; readonly status: string; readonly packages: number; readonly profiles: number; readonly mappings: number };
    readonly export: { readonly outputs: number; readonly receipts: number };
    readonly raster: { readonly available: boolean };
  };
export interface BrandPage<T> { readonly page: { readonly size: number; readonly count: number; readonly items: readonly T[]; readonly nextCursor: ServiceCursor | null }; readonly viewDigest: Sha256Digest }
export type BrandFamilyItem = BrandFamily & { readonly variants: readonly BrandVariant[]; readonly bindings: readonly (BrandBinding & { readonly derivedState?: string })[]; readonly requirements: readonly BrandRequirement[]; readonly complete: boolean };
export type BrandFamilyListResult = BrandPage<BrandFamilyItem>;
export type BrandTokenItem = BrandToken & { readonly referenceCount: number; readonly recipeUseCount: number; readonly unused: boolean };
export type BrandTokenListResult = BrandPage<BrandTokenItem>;
export interface BrandRecipeGraphResult { readonly recipeDigest: Sha256Digest; readonly graphDigest: Sha256Digest; readonly nodes: readonly { readonly recipeId: string; readonly sourceAsset: string; readonly targetAsset: string; readonly dependencies: readonly string[]; readonly dependents: readonly string[]; readonly operations: readonly string[]; readonly operationDigest: Sha256Digest; readonly depth: number; readonly targetState: string; readonly receiptDigest: Sha256Digest | null }[]; readonly affectedTargetCount: number; readonly ownershipConflicts: number }
export interface BrandQaProfileResult { readonly profile: BrandQaProfile; readonly cases: readonly BrandQaCase[]; readonly resolvedTargetCount: number; readonly evaluationCount: number; readonly qaDigest: Sha256Digest; readonly brandSystemDigest: Sha256Digest; readonly baselines: readonly { readonly identity: string; readonly digest: Sha256Digest | null }[]; readonly raster: { readonly available: boolean } }
export type BrandQaPublicCase = BrandQaCase extends infer Case ? Case extends { readonly baselinePath: string } ? Omit<Case, "baselinePath"> : Case : never;
export interface BrandQaProfileResultV1_2 { readonly profile: BrandQaProfile; readonly cases: readonly BrandQaPublicCase[]; readonly resolvedTargetCount: number; readonly evaluationCount: number; readonly qaDigest: Sha256Digest; readonly brandSystemDigest: Sha256Digest; readonly baselines: readonly { readonly caseId: string; readonly digest: Sha256Digest | null }[]; readonly raster: { readonly available: boolean } }
export interface BrandQaProfileListItem {
  readonly id: string;
  readonly renderer: "optional" | "required";
  readonly formats: readonly string[];
  readonly caseCount: number;
  readonly semanticCaseCount: number;
  readonly visualCaseCount: number;
  readonly baselineCaseCount: number;
  readonly qaDigest: Sha256Digest;
  readonly brandSystemDigest: Sha256Digest;
}
export type BrandQaProfileListResult = BrandPage<BrandQaProfileListItem>;
export interface BrandDiffReadResult { readonly diff: BrandDiffResult; readonly beforeBindingDigest: Sha256Digest; readonly afterBindingDigest: Sha256Digest; readonly visualDiff: { readonly available: boolean } }
export interface BrandVisualEvidenceArtifact {
  readonly role: "current" | "baseline" | "before" | "after";
  readonly mediaType: "image/png";
  readonly encoding: "base64";
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly pngDigest: Sha256Digest;
  readonly decodedPixelDigest: Sha256Digest;
  readonly bytesBase64: string;
}
export interface BrandVisualEvidenceDifference {
  readonly changedPixels: number;
  readonly maximumChannelDelta: number;
  readonly changedBounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } | null;
  readonly claim: "pixel-equal-for-this-renderer-and-case-only" | "pixel-different-for-this-renderer-and-case-only";
}
export interface BrandVisualEvidenceResult {
  readonly schema: "tfsb.studio-visual-evidence";
  readonly schemaVersion: 1;
  readonly kind: "project-render" | "qa-baseline" | "brand-diff";
  readonly projectDigest: Sha256Digest;
  readonly brandSystemDigest: Sha256Digest;
  readonly sourceDigest?: Sha256Digest;
  readonly qaDigest?: Sha256Digest;
  readonly target: { readonly assetId: string; readonly canonicalAssetDigest: Sha256Digest; readonly svgDigest: Sha256Digest; readonly binding?: { readonly family: string; readonly role: string; readonly variant: string } };
  readonly configuration: { readonly width: number; readonly height: number; readonly background: string };
  readonly renderer: { readonly id: string; readonly version: string; readonly qualificationId: string; readonly platformClaim: string };
  readonly artifacts: readonly BrandVisualEvidenceArtifact[];
  readonly difference?: BrandVisualEvidenceDifference;
  readonly evidenceDigest: Sha256Digest;
}
export interface BrandConsumerProfileItem { readonly qualifiedProfileId: string; readonly authorityKind: "producer-project" | "producer-package" | "consumer-local"; readonly packageId: string; readonly profile: ConsumerProfile; readonly outputRuleCount: number; readonly resolvedOutputCount: number | null }
export type BrandConsumerProfileListResult = BrandPage<BrandConsumerProfileItem>;
export interface BrandExportCapabilityResult { readonly available: false };
export interface BrandExportCapabilityAvailableResult { readonly available: true; readonly adapterId: "resvg-png-v1"; readonly rendererPackage: string; readonly rendererVersion: string; readonly rendererBuildDigest: Sha256Digest; readonly nodeMajor: 22; readonly platformClaim: "darwin-arm64"; readonly qualificationId: string }
export type BrandExportStatusResult = BrandPage<{
  readonly profileId: string;
  readonly outputId: string;
  readonly assetId: string | null;
  readonly binding: { readonly family: string; readonly role: string; readonly variant: string } | null;
  readonly destination: string;
  readonly state: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly purpose: string | null;
  readonly background: string | null;
  readonly alpha: "straight" | "opaque" | null;
  readonly canonicalAssetDigest: Sha256Digest | null;
  readonly svgDigest: Sha256Digest | null;
  readonly profileDigest: Sha256Digest | null;
  readonly outputConfigDigest: Sha256Digest | null;
  readonly pngDigest: Sha256Digest | null;
  readonly decodedPixelDigest: Sha256Digest | null;
  readonly receiptDigest: Sha256Digest | null;
  readonly capabilityAvailable: boolean;
}>;
export type BrandDerivePlanSummary = Pick<BrandDerivePlan, "selectedRecipes" | "transitiveRecipes" | "affectedTargets" | "createdCount" | "updatedCount" | "unchangedCount" | "operationSummaries" | "targetStates" | "tokenDigest" | "recipeDigest" | "warnings" | "dryRun"> & { readonly brandSystemDigest: Sha256Digest };
export interface BrandQaBaselinePlanSummary extends Pick<BrandQaBaselineUpdatePlan, "profileId" | "caseId" | "baselinePath" | "state" | "oldBaselineDigest" | "newBaselineDigest" | "oldQaDigest" | "newQaDigest" | "rasterDifference"> {
  readonly renderer: { readonly id: string; readonly version: string; readonly qualificationId: string; readonly platformClaim: string; readonly rendererBuildDigest: Sha256Digest };
  readonly assetDigests: { readonly old: Sha256Digest; readonly next: Sha256Digest };
  readonly svgDigests: { readonly old: Sha256Digest; readonly next: Sha256Digest };
  readonly brandSystemDigests: { readonly old: Sha256Digest; readonly next: Sha256Digest };
}
export type BrandRasterExportPlanSummary = Pick<RasterExportPlan, "profileId" | "adapter" | "outputs" | "counts" | "warnings">;
export type BrandDerivePlanResult = StudioPlanResult<BrandDerivePlanSummary>;
export type BrandQaBaselinePlanResult = StudioPlanResult<BrandQaBaselinePlanSummary>;
export type BrandConsumerInstallPlanResult = StudioPlanResult<ConsumerPlanSummary>;
export type BrandConsumerSyncPlanResult = StudioPlanResult<ConsumerPlanSummary>;
export type BrandExportPlanResult = StudioPlanResult<BrandRasterExportPlanSummary>;
export type StudioResult =
  | InitializeResult | InitializeResultV1_1 | InitializeResultV1_2 | WorkspaceOpenResult | ProjectOpenResponse | SourceOpenResult
  | WorkspaceStatusResult | ProjectListResult | AssetListResult | AssetGetResult
  | AssetValidationResult | AssetDiffResult | SourceAnalyzeResult | PreviewStatusResult
  | AssetEditPlanResult | ProjectImportPlanResult | ProjectReconcilePlanResult
  | ProjectMigratePlanResult | ProjectFmtPlanResult | ProjectBuildPlanResult
  | ProjectInstallPlanResult | PreviewPlanResult | BrandStatusResult | BrandFamilyListResult
  | BrandTokenListResult | BrandRecipeGraphResult | BrandQaProfileResult | BrandQaProfileResultV1_2 | BrandQaProfileListResult | BrandQaResult
  | BrandDiffReadResult | BrandConsumerProfileListResult | ConsumerStateInspection
  | BrandExportCapabilityResult | BrandExportCapabilityAvailableResult | BrandExportStatusResult | BrandVisualEvidenceResult
  | BrandDerivePlanResult | BrandQaBaselinePlanResult | BrandConsumerInstallPlanResult
  | BrandConsumerSyncPlanResult | BrandExportPlanResult | PlanDiscardResult | PlanApplyResult | null;

export interface StudioSuccessResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: StudioResult;
}
export interface StudioErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: { readonly code: number; readonly message: string; readonly data: StudioErrorData };
}
export type StudioOutboundMessage = StudioSuccessResponse | StudioErrorResponse | StudioProgressNotification;

export const V1_TYPE_METHODS = [
  "initialize", "shutdown", "workspace.open", "project.open", "source.open",
  "workspace.status", "project.list", "asset.list", "asset.get", "asset.validate",
  "asset.diff", "source.analyze", "preview.status", "asset.edit.plan", "project.import.plan",
  "project.reconcile.plan", "project.migrate.plan", "project.fmt.plan", "project.build.plan",
  "project.install.plan", "preview.plan", "plan.discard", "plan.apply", "initialized",
  "$/cancelRequest", "exit", "$/progress",
] as const;

export const V1_1_TYPE_METHODS = [
  ...V1_TYPE_METHODS.slice(0, 23),
  "brand.status", "brand.family.list", "brand.token.list", "brand.recipe.graph",
  "brand.qa.profile.get", "brand.qa.result.get", "brand.diff", "brand.consumer.profile.list",
  "brand.consumer.lock.status", "brand.export.capability", "brand.export.status",
  "brand.derive.plan", "brand.qa.baseline.plan", "brand.consumer.install.plan",
  "brand.consumer.sync.plan", "brand.export.plan",
  ...V1_TYPE_METHODS.slice(23),
] as const;

export const V1_2_TYPE_METHODS = [
  ...V1_1_TYPE_METHODS.slice(0, 39),
  "brand.qa.profile.list", "brand.visual.evidence.get",
  ...V1_1_TYPE_METHODS.slice(39),
] as const;

export const V1_TYPE_ERROR_CODES = [
  "PARSE_ERROR", "INVALID_REQUEST", "METHOD_NOT_FOUND", "INVALID_PARAMS", "INTERNAL_ERROR",
  "INVALID_REQUEST_ID", "PROTOCOL_VERSION_UNSUPPORTED", "SESSION_NOT_INITIALIZED",
  "SESSION_NONCE_INVALID", "ROOT_INVALID", "ROOT_HANDLE_INVALID", "METHOD_CAPABILITY_UNAVAILABLE",
  "REQUEST_BUSY", "REQUEST_CANCELLED", "PLAN_TOKEN_INVALID", "PLAN_STALE",
  "PLAN_DIGEST_MISMATCH", "CURSOR_INVALID", "CURSOR_STALE", "DOMAIN_OPERATION_FAILED",
  "MESSAGE_TOO_LARGE",
] as const satisfies readonly StudioErrorCode[];

type TypedMethod = StudioInboundMessage["method"] | StudioProgressNotification["method"];
type MethodInventoryComplete = Exclude<TypedMethod, typeof V1_2_TYPE_METHODS[number]> extends never
  ? Exclude<typeof V1_2_TYPE_METHODS[number], TypedMethod> extends never ? true : false
  : false;
type ErrorInventoryComplete = Exclude<StudioErrorCode, typeof V1_TYPE_ERROR_CODES[number]> extends never
  ? Exclude<typeof V1_TYPE_ERROR_CODES[number], StudioErrorCode> extends never ? true : false
  : false;
export const V1_TYPE_METHOD_INVENTORY_COMPLETE: MethodInventoryComplete = true;
export const V1_TYPE_ERROR_INVENTORY_COMPLETE: ErrorInventoryComplete = true;
import type { AnalyzeDetailsFile, AnalyzeJsonData, AnalyzeInputKind } from "../analyze-contract.js";
import type { ArchiveSemanticChange } from "../diff.js";
import type { ProjectInventory } from "../list.js";
import type { AnyNormalizedAsset } from "../schema-dispatch.js";
import type { WorkspaceCheckResult } from "../workspace-check.js";
import type { BrandBinding, BrandFamily, BrandRequirement, BrandVariant } from "../brand/brand-schema.js";
import type { BrandToken } from "../brand/tokens.js";
import type { BrandQaCase, BrandQaProfile } from "../brand/qa-schema.js";
import type { BrandQaResult } from "../brand/qa-report.js";
import type { BrandDiffResult } from "../brand/brand-diff.js";
import type { ConsumerProfile } from "../brand/consumer-profile.js";
import type { ConsumerPlanSummary, ConsumerStateInspection } from "../brand/consumer-plan.js";
import type { BrandDerivePlan } from "../brand/derive.js";
import type { BrandQaBaselineUpdatePlan } from "../brand/qa-baseline.js";
import type { RasterExportPlan } from "../brand/export-plan.js";
