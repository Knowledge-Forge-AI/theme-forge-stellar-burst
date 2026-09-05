import type { StudioApplicationErrorCode, StudioErrorCode, StudioStandardErrorCode } from "./v1-types.js";
import type { RasterCapabilityStatus } from "../brand/raster-capability.js";

export const MAX_FRAME_BYTES = 16_777_216 as const;
export const MAX_CONCURRENT_READS = 4 as const;
export const MAX_QUEUED_READS = 4 as const;
export const DEFAULT_PAGE_SIZE = 64 as const;
export const MAX_PAGE_SIZE = 128 as const;
export const MAX_ACTIVE_PLANS = 4 as const;
export const MAX_RETAINED_PLAN_BYTES = 201_326_592 as const;
export const MAX_RETAINED_NATIVE_SNAPSHOT_PLANS = 1 as const;
export const PLAN_TTL_MS = 600_000 as const;
export const MAX_CONCURRENT_APPLIES = 1 as const;

export const SUPPORTED_REQUEST_METHODS = [
  "initialize", "shutdown", "workspace.open", "project.open", "source.open",
  "workspace.status", "project.list", "asset.list", "asset.get", "asset.validate",
  "asset.diff", "source.analyze", "preview.status", "asset.edit.plan", "project.import.plan",
  "project.reconcile.plan", "project.migrate.plan", "project.fmt.plan", "project.build.plan",
  "project.install.plan", "preview.plan", "plan.discard", "plan.apply",
] as const;
export const BRAND_READ_METHODS = [
  "brand.status", "brand.family.list", "brand.token.list", "brand.recipe.graph",
  "brand.qa.profile.get", "brand.qa.result.get", "brand.diff", "brand.consumer.profile.list",
  "brand.consumer.lock.status", "brand.export.capability", "brand.export.status",
] as const;
export const BRAND_READ_METHODS_1_2 = ["brand.qa.profile.list", "brand.visual.evidence.get"] as const;
export const BRAND_PLAN_METHODS = [
  "brand.derive.plan", "brand.qa.baseline.plan", "brand.consumer.install.plan",
  "brand.consumer.sync.plan", "brand.export.plan",
] as const;
export const SUPPORTED_REQUEST_METHODS_1_1 = [
  ...SUPPORTED_REQUEST_METHODS,
  ...BRAND_READ_METHODS,
  ...BRAND_PLAN_METHODS,
] as const;
export const SUPPORTED_REQUEST_METHODS_1_2 = [
  ...SUPPORTED_REQUEST_METHODS_1_1,
  ...BRAND_READ_METHODS_1_2,
] as const;

export const SUPPORTED_CLIENT_NOTIFICATION_METHODS = ["initialized", "$/cancelRequest", "exit"] as const;
export const SERVER_NOTIFICATION_METHODS = ["$/progress"] as const;

export const UNAVAILABLE_PLAN_METHODS = [] as const;

export const ADVERTISED_METHODS = [
  ...SUPPORTED_REQUEST_METHODS,
  ...SUPPORTED_CLIENT_NOTIFICATION_METHODS,
  ...SERVER_NOTIFICATION_METHODS,
] as const;
export const ADVERTISED_METHODS_1_1 = [
  ...SUPPORTED_REQUEST_METHODS_1_1,
  ...SUPPORTED_CLIENT_NOTIFICATION_METHODS,
  ...SERVER_NOTIFICATION_METHODS,
] as const;
export const ADVERTISED_METHODS_1_2 = [
  ...SUPPORTED_REQUEST_METHODS_1_2,
  ...SUPPORTED_CLIENT_NOTIFICATION_METHODS,
  ...SERVER_NOTIFICATION_METHODS,
] as const;

export const KNOWN_METHODS = [...ADVERTISED_METHODS_1_2, ...UNAVAILABLE_PLAN_METHODS] as const;

export type SupportedRequestMethod = typeof SUPPORTED_REQUEST_METHODS_1_2[number];
export type SupportedClientNotificationMethod = typeof SUPPORTED_CLIENT_NOTIFICATION_METHODS[number];
export type UnavailablePlanMethod = typeof UNAVAILABLE_PLAN_METHODS[number];
export type KnownMethod = typeof KNOWN_METHODS[number];

export interface ErrorRegistryEntry { readonly numeric: number; readonly message: string; readonly retryable: boolean }

export const STANDARD_ERROR_REGISTRY: Readonly<Record<StudioStandardErrorCode, ErrorRegistryEntry>> = Object.freeze({
  PARSE_ERROR: { numeric: -32700, message: "The protocol frame could not be parsed.", retryable: false },
  INVALID_REQUEST: { numeric: -32600, message: "The JSON-RPC request is invalid.", retryable: false },
  METHOD_NOT_FOUND: { numeric: -32601, message: "The requested method is unknown.", retryable: false },
  INVALID_PARAMS: { numeric: -32602, message: "The method parameters are invalid.", retryable: false },
  INTERNAL_ERROR: { numeric: -32603, message: "The service encountered an internal error.", retryable: false },
});

export const APPLICATION_ERROR_REGISTRY: Readonly<Record<StudioApplicationErrorCode, ErrorRegistryEntry>> = Object.freeze({
  INVALID_REQUEST_ID: { numeric: -32000, message: "The request ID is invalid or already active.", retryable: false },
  PROTOCOL_VERSION_UNSUPPORTED: { numeric: -32001, message: "No compatible protocol version is available.", retryable: false },
  SESSION_NOT_INITIALIZED: { numeric: -32002, message: "The session handshake is incomplete.", retryable: true },
  SESSION_NONCE_INVALID: { numeric: -32003, message: "The session binding is invalid.", retryable: false },
  ROOT_INVALID: { numeric: -32010, message: "The selected root is unavailable or unsafe.", retryable: false },
  ROOT_HANDLE_INVALID: { numeric: -32011, message: "The root handle is invalid for this method.", retryable: false },
  METHOD_CAPABILITY_UNAVAILABLE: { numeric: -32020, message: "The typed method is unavailable in this service capability set.", retryable: false },
  REQUEST_BUSY: { numeric: -32030, message: "The bounded service capacity is busy.", retryable: true },
  REQUEST_CANCELLED: { numeric: -32031, message: "The request was cancelled at a safe boundary.", retryable: true },
  PLAN_TOKEN_INVALID: { numeric: -32040, message: "The plan token is invalid.", retryable: false },
  PLAN_STALE: { numeric: -32041, message: "The plan pre-state is stale.", retryable: false },
  PLAN_DIGEST_MISMATCH: { numeric: -32042, message: "The expected plan digest does not match.", retryable: false },
  CURSOR_INVALID: { numeric: -32050, message: "The service cursor is invalid for this session or scope.", retryable: false },
  CURSOR_STALE: { numeric: -32051, message: "The service cursor no longer matches current state.", retryable: true },
  DOMAIN_OPERATION_FAILED: { numeric: -32060, message: "The requested domain operation failed.", retryable: false },
  MESSAGE_TOO_LARGE: { numeric: -32061, message: "The protocol message exceeds the fixed byte limit.", retryable: false },
});

export const ERROR_REGISTRY: Readonly<Record<StudioErrorCode, ErrorRegistryEntry>> = Object.freeze({
  ...STANDARD_ERROR_REGISTRY,
  ...APPLICATION_ERROR_REGISTRY,
});

export const STUDIO_CAPABILITIES = Object.freeze({
  methods: Object.freeze({
    workspaceOpen: true, projectOpen: true, sourceOpen: true, workspaceStatus: true,
    projectList: true, assetList: true, assetGet: true, assetValidate: true,
    assetDiff: true, sourceAnalyze: true, previewStatus: true, progress: true,
    cancellation: true, mutationPlans: true, planApply: true,
  }),
  limits: Object.freeze({
    maxFrameBytes: MAX_FRAME_BYTES, maxConcurrentReads: MAX_CONCURRENT_READS,
    maxQueuedReads: MAX_QUEUED_READS, assetPageSizeMin: 1, assetPageSizeDefault: DEFAULT_PAGE_SIZE,
    assetPageSizeMax: MAX_PAGE_SIZE, sourceDetailPageSizeMin: 1,
    sourceDetailPageSizeDefault: DEFAULT_PAGE_SIZE, sourceDetailPageSizeMax: MAX_PAGE_SIZE,
    maxActivePlans: MAX_ACTIVE_PLANS, maxRetainedPlanBytes: MAX_RETAINED_PLAN_BYTES,
    maxRetainedNativeSnapshotPlans: MAX_RETAINED_NATIVE_SNAPSHOT_PLANS,
    planTtlMs: PLAN_TTL_MS, maxConcurrentApplies: MAX_CONCURRENT_APPLIES,
  }),
});

export const QUALIFICATION_ID = "sha256:4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11";
export const RENDERER_BUILD_DIGEST = "sha256:22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70";

export function isQualifiedStudioRasterCapability(capability: RasterCapabilityStatus | undefined): capability is Extract<RasterCapabilityStatus, { readonly available: true }> {
  if (capability?.available !== true) return false;
  const value = capability.adapter.descriptor;
  return value.adapterId === "resvg-png-v1" && value.rendererPackage === "@resvg/resvg-wasm"
    && value.rendererVersion === "2.6.2" && value.rendererBuildDigest === RENDERER_BUILD_DIGEST
    && value.nodeMajor === 22 && value.platformClaim === "darwin-arm64" && value.qualificationId === QUALIFICATION_ID;
}

export function createStudioCapabilitiesV1_1(capability: RasterCapabilityStatus | undefined) {
  const qualified = isQualifiedStudioRasterCapability(capability);
  const descriptor = qualified ? capability.adapter.descriptor : undefined;
  return Object.freeze({
    ...STUDIO_CAPABILITIES,
    brand: Object.freeze({
      schemaVersion: 1,
      methods: Object.freeze({
        status: true, familyList: true, tokenList: true, recipeGraph: true,
        qaProfileGet: true, qaResultGet: true, diff: true, consumerProfileList: true,
        consumerLockStatus: true, exportCapability: true, exportStatus: true,
        derivePlan: true, qaBaselinePlan: qualified, consumerInstallPlan: true,
        consumerSyncPlan: true, exportPlan: qualified,
      }),
      sourcePurposes: Object.freeze({ brandBundle: true, npmInstalledPackage: true }),
      raster: qualified ? Object.freeze({ available: true, adapterId: "resvg-png-v1", rendererVersion: descriptor!.rendererVersion, qualificationId: descriptor!.qualificationId, platformClaim: "darwin-arm64" }) : Object.freeze({ available: false }),
      limits: Object.freeze({ pageSizeMin: 1, pageSizeDefault: 64, pageSizeMax: 128, maxSourcePackages: 8, maxSelectedProfiles: 8, maxQaResultBytes: 16_777_216, maxDiffResultBytes: 16_777_216, maxExportOutputs: 128 }),
    }),
  });
}

export function createStudioCapabilitiesV1_2(capability: RasterCapabilityStatus | undefined) {
  const base = createStudioCapabilitiesV1_1(capability);
  const qualified = isQualifiedStudioRasterCapability(capability);
  return Object.freeze({
    ...STUDIO_CAPABILITIES,
    brand: Object.freeze({
      ...base.brand,
      methods: Object.freeze({ ...base.brand.methods, qaProfileList: true, visualEvidenceGet: qualified }),
      visualEvidence: qualified ? Object.freeze({
        available: true, mediaTypes: Object.freeze(["image/png"]), encoding: "base64",
        maxDimension: 1024, maxPixels: 1_048_576, maxArtifactBytes: 6_291_456,
        maxAggregateArtifactBytes: 8_388_608, maxResultBytes: 12_582_912, maxArtifacts: 2,
      }) : Object.freeze({ available: false }),
    }),
  });
}

export function isUnavailablePlanMethod(method: string): method is UnavailablePlanMethod {
  return (UNAVAILABLE_PLAN_METHODS as readonly string[]).includes(method);
}

export function isKnownMethod(method: string): method is KnownMethod {
  return (KNOWN_METHODS as readonly string[]).includes(method);
}
