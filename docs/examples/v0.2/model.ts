import type {
  NormalizedAsset,
  NormalizedProject,
  ProjectRelativePath,
} from "../../../src/types.js";

declare const validated: unique symbol;

export type Sha256 = string & { readonly [validated]: "Sha256" };
export type PortableEntryName = string & {
  readonly [validated]: "PortableEntryName";
};

export type LifecycleOperation =
  | "reconcile"
  | "bundle"
  | "diff"
  | "fmt"
  | "preview"
  | "check"
  | "list";

export interface LifecycleDiagnostic {
  readonly code: string;
  readonly severity: "error";
  readonly operation: LifecycleOperation;
  readonly domain:
    | "archive"
    | "provenance"
    | "project"
    | "filesystem"
    | "bundle"
    | "preview"
    | "cli";
  readonly path?: ProjectRelativePath;
  readonly entry?: PortableEntryName;
  readonly location?: string;
  readonly message: string;
}

export type OperationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostics: readonly LifecycleDiagnostic[] };

export interface CanonicalSnapshot {
  readonly rootIdentity: string;
  readonly treeDigest: Sha256;
  readonly project: NormalizedProject;
  readonly assets: readonly NormalizedAsset[];
  readonly canonicalFiles: ReadonlyMap<ProjectRelativePath, Uint8Array>;
  readonly companions: ReadonlyMap<ProjectRelativePath, Uint8Array>;
  readonly provenance?: ImportProvenanceV1;
}

export interface ImportProvenanceV1 {
  readonly kind: "tfsb-import-provenance";
  readonly schemaVersion: 1;
  readonly records: readonly ProvenanceRecordV1[];
}

export type ProvenanceResolution = "aligned" | "canonical";

export interface AssetProvenanceV1 {
  readonly type: "asset";
  readonly assetId: string;
  readonly canonicalPath: ProjectRelativePath;
  readonly archiveDigest: Sha256;
  readonly entryName: PortableEntryName;
  readonly entryDigest: Sha256;
  readonly digestBasis: "tfsb-asset-toml-v1";
  readonly archiveModelDigest: Sha256;
  readonly canonicalState: "present" | "absent";
  readonly canonicalModelDigest?: Sha256;
  readonly resolution: ProvenanceResolution;
  readonly toolVersion: string;
}

export interface CompanionProvenanceV1 {
  readonly type: "companion";
  readonly canonicalPath: ProjectRelativePath;
  readonly archiveDigest: Sha256;
  readonly entryName: PortableEntryName;
  readonly entryDigest: Sha256;
  readonly archiveByteDigest: Sha256;
  readonly canonicalState: "present" | "absent";
  readonly canonicalByteDigest?: Sha256;
  readonly resolution: ProvenanceResolution;
  readonly toolVersion: string;
}

export type ProvenanceRecordV1 =
  | AssetProvenanceV1
  | CompanionProvenanceV1;

export type ReconcileClassification =
  | "UNCHANGED"
  | "UNCHANGED_ACCEPTED_DIVERGENCE"
  | "UNCHANGED_ACCEPTED_ABSENCE"
  | "UNTRACKED_MATCH"
  | "UNTRACKED_CONFLICT"
  | "ARCHIVE_CHANGED"
  | "CANONICAL_EDITED"
  | "CONVERGED"
  | "CONVERGED_ABSENCE"
  | "CONFLICT"
  | "NEW_ASSET"
  | "ARCHIVE_OMISSION"
  | "ARCHIVE_OMISSION_CANONICAL_EDITED"
  | "COMPANION_CHANGED"
  | "CANONICAL_MISSING"
  | "RENAMED";

export type ExplicitResolution = "canonical" | "archive";

export interface ReconcileRecordPlan {
  readonly key: string;
  readonly classification: ReconcileClassification;
  readonly canonicalChanged: boolean;
  readonly archiveChanged: boolean;
  readonly requestedResolution?: ExplicitResolution;
  readonly plannedAction:
    | "none"
    | "replace_canonical"
    | "update_provenance"
    | "add_canonical"
    | "retain"
    | "resolve"
    | "rename"
    | "remove"
    | "blocked_collision";
  readonly requiredAuthority: "none" | "resolve" | "rename" | "remove";
  readonly diagnostics: readonly LifecycleDiagnostic[];
}

export type CanonicalMutation =
  | {
      readonly type: "write";
      readonly path: ProjectRelativePath;
      readonly bytes: Uint8Array;
    }
  | { readonly type: "remove"; readonly path: ProjectRelativePath };

export interface CanonicalTransactionPlan {
  readonly expectedTreeDigest: Sha256;
  readonly nextTreeDigest: Sha256;
  readonly mutations: readonly CanonicalMutation[];
  readonly completeNextFiles: ReadonlyMap<ProjectRelativePath, Uint8Array>;
}

export interface ReconcilePlan {
  readonly snapshot: CanonicalSnapshot;
  readonly records: readonly ReconcileRecordPlan[];
  readonly transaction?: CanonicalTransactionPlan;
  readonly hasConflict: boolean;
}

export interface BundleManifestV1 {
  readonly kind: "tfsb-bundle-manifest";
  readonly schemaVersion: 1;
  readonly generator: {
    readonly name: "@knowledge-forge-ai/theme-forge-stellar-burst";
    readonly version: string;
  };
  readonly projectName?: string;
  readonly files: readonly BundleManifestFileV1[];
}

export type BundleManifestFileV1 =
  | {
      readonly type: "asset";
      readonly name: PortableEntryName;
      readonly assetId: string;
      readonly sha256: Sha256;
    }
  | {
      readonly type: "companion";
      readonly name: PortableEntryName;
      readonly sha256: Sha256;
    };

export interface BundlePlan {
  readonly output: ProjectRelativePath;
  readonly manifest: BundleManifestV1;
  readonly entries: ReadonlyMap<PortableEntryName, Uint8Array>;
  readonly archiveBytes: Uint8Array;
}

export interface BuildReceiptV3 {
  readonly kind: "tfsb-build-v3";
  readonly schemaVersion: 3;
  readonly toolVersion: string;
  readonly buildDirectory: ProjectRelativePath;
  readonly canonicalSources: Readonly<Record<string, Sha256>>;
  readonly outputs: Readonly<Record<string, Sha256>>;
  readonly projectPolicy: {
    readonly buildDirectory: ProjectRelativePath;
    readonly installs: readonly {
      readonly assetId: string;
      readonly destinations: readonly ProjectRelativePath[];
    }[];
    readonly companions: readonly {
      readonly file: ProjectRelativePath;
      readonly destinations: readonly ProjectRelativePath[];
    }[];
  };
}

export type DiffBaseline =
  | { readonly type: "provenance" }
  | { readonly type: "archive"; readonly archive: string }
  | { readonly type: "build" }
  | { readonly type: "install" };

export interface SemanticChange {
  readonly assetId?: string;
  readonly category:
    | "canvas"
    | "accessibility"
    | "metadata"
    | "gradient"
    | "element"
    | "presentation"
    | "transform"
    | "path"
    | "policy"
    | "companion"
    | "derived";
  readonly location: string;
  readonly change: "added" | "removed" | "changed";
  readonly beforeDigest?: Sha256;
  readonly afterDigest?: Sha256;
  readonly summary: string;
}

export interface FormatPlan {
  readonly transaction?: CanonicalTransactionPlan;
  readonly changedPaths: readonly ProjectRelativePath[];
}

declare const previewPlanBrand: unique symbol;

export interface PreviewPlan {
  readonly outputDirectory: ProjectRelativePath;
  readonly files: {
    readonly index: "index.html";
    readonly stylesheet: "preview.css";
    readonly marker: ".tfsb-preview.json";
    readonly assets: readonly ProjectRelativePath[];
  };
  readonly assetCount: number;
  readonly companionCount: number;
  readonly replaced: boolean;
  readonly [previewPlanBrand]: true;
}

export interface PreviewResult {
  readonly outputDirectory: ProjectRelativePath;
  readonly written: true;
  readonly replaced: boolean;
  readonly assetCount: number;
  readonly companionCount: number;
  readonly opened: {
    readonly requested: boolean;
    readonly status: "not_requested" | "skipped" | "opened" | "failed";
  };
}

export type JsonStatus = "ok" | "drift" | "conflict" | "error";

export interface JsonCommandResult<
  TCommand extends LifecycleOperation,
  TData,
> {
  readonly schemaVersion: 1;
  readonly command: TCommand;
  readonly status: JsonStatus;
  readonly exitCode: 0 | 1 | 2;
  readonly summary: string;
  readonly diagnostics: readonly LifecycleDiagnostic[];
  readonly data: TData;
}

export interface LifecycleApi {
  inspectReconciliation(
    snapshot: CanonicalSnapshot,
    archive: Uint8Array,
    resolutions: ReadonlyMap<string, ExplicitResolution>,
  ): OperationResult<ReconcilePlan>;

  commitCanonicalTransaction(
    root: string,
    plan: CanonicalTransactionPlan,
  ): Promise<OperationResult<void>>;

  planBundle(
    snapshot: CanonicalSnapshot,
    output: ProjectRelativePath,
    selection: readonly string[],
  ): OperationResult<BundlePlan>;

  diff(
    snapshot: CanonicalSnapshot,
    baseline: DiffBaseline,
  ): Promise<OperationResult<readonly SemanticChange[]>>;

  planFormat(snapshot: CanonicalSnapshot): OperationResult<FormatPlan>;

  planPreview(
    snapshot: CanonicalSnapshot,
    output: ProjectRelativePath,
  ): Promise<OperationResult<PreviewPlan>>;

  executePreviewPlan(plan: PreviewPlan): Promise<OperationResult<PreviewResult>>;
}
