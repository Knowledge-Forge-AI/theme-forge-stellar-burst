import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { computeAssetSemanticDigest, computeSha256, type Sha256Digest } from "./digests.js";
import { fail, type DiagnosticContext } from "./diagnostics.js";
import { diffAssetModels, type ArchiveSemanticChange } from "./diff.js";
import { enforceMutationAssetLimit, loadCanonicalProject, type LoadedProject } from "./project.js";
import { inspectPlanRetention, type PlanRetentionInspection } from "./plan-retention.js";
import {
  parseAssetTomlVersioned,
  serializeAssetTomlVersioned,
  type AnyNormalizedAsset,
} from "./schema-dispatch.js";
import {
  executeCanonicalTransaction,
  snapshotCanonicalTree,
  snapshotsEqual,
  type CanonicalSnapshot,
  type CanonicalTree,
  type TransactionHooks,
} from "./transaction.js";

const ASSET_TOML_MAX_BYTES = 8 * 1024 * 1024;
const ASSET_EDIT_STAGE_INVALID = "EDIT_STAGE_INVALID";
const assetEditPlanBrand: unique symbol = Symbol("tfsb-asset-edit-plan");

export interface AssetEditOptions {
  readonly root: string;
  readonly assetId: string;
  readonly proposedToml: string;
}

export interface AssetEditPlan {
  readonly assetId: string;
  readonly affectedCanonicalPath: string;
  readonly oldDigest: Sha256Digest;
  readonly newDigest: Sha256Digest;
  readonly changed: boolean;
  readonly semanticChanges: readonly ArchiveSemanticChange[];
  readonly [assetEditPlanBrand]: true;
}

export type AssetProposalValidation =
  | {
      readonly valid: false;
      readonly diagnostics: readonly {
        readonly code: string;
        readonly message: string;
        readonly location?: string;
      }[];
    }
  | {
      readonly valid: true;
      readonly model: AnyNormalizedAsset;
      readonly canonicalToml: string;
      readonly digests: {
        readonly rawToml: Sha256Digest;
        readonly semantic: Sha256Digest;
      };
    };

interface AssetEditPlanInternals {
  readonly root: string;
  readonly snapshot: CanonicalSnapshot;
  readonly nextFiles: ReadonlyMap<string, Uint8Array>;
  readonly oldDigest: Sha256Digest;
  readonly newDigest: Sha256Digest;
  readonly oldModel: AnyNormalizedAsset;
  readonly newModel: AnyNormalizedAsset;
}

const assetEditPlanInternals = new WeakMap<AssetEditPlan, AssetEditPlanInternals>();

function context(): DiagnosticContext {
  return { operation: "edit", domain: "project" };
}

function safeDiagnostics(values: readonly { readonly code: string; readonly message: string; readonly location?: string }[]): readonly {
  readonly code: string;
  readonly message: string;
  readonly location?: string;
}[] {
  return values.slice(0, 128).map((value) => ({
    code: value.code.slice(0, 128),
    message: "The proposed asset is invalid.",
    ...(value.location === undefined || value.location.startsWith("/") || value.location.includes("\\") || value.location.length > 256
      ? {}
      : { location: value.location }),
  }));
}

/**
 * Validate and canonicalize an asset proposal for both read-only validation
 * and asset-edit planning. The caller owns whether the addressed asset must
 * already exist; this shared seam intentionally preserves read validation's
 * existing behavior for proposals with a new identity.
 */
export function validateAssetProposal(
  project: LoadedProject,
  assetId: string,
  toml: string,
): AssetProposalValidation {
  if (Buffer.byteLength(toml, "utf8") > ASSET_TOML_MAX_BYTES) {
    return { valid: false, diagnostics: [{ code: "ASSET_SIZE_LIMIT", message: "The proposed asset is invalid." }] };
  }
  const parsed = parseAssetTomlVersioned(toml, project.project.schemaVersion, `.tfsb/assets/${assetId}.toml`);
  if (!parsed.ok) return { valid: false, diagnostics: safeDiagnostics(parsed.diagnostics) };
  const model = parsed.value;
  if (model.id !== assetId) {
    return {
      valid: false,
      diagnostics: [{ code: "PROJECT_ASSET_FILENAME_MISMATCH", message: "The proposed asset is invalid.", location: "id" }],
    };
  }
  const owner = project.assets.find((item) => item.id !== assetId && item.filename === model.filename);
  if (owner !== undefined) {
    return {
      valid: false,
      diagnostics: [{ code: "PROJECT_DUPLICATE_FILENAME", message: "The proposed asset is invalid.", location: "filename" }],
    };
  }
  const canonicalToml = serializeAssetTomlVersioned(model);
  return {
    valid: true,
    model,
    canonicalToml,
    digests: {
      rawToml: computeSha256(Buffer.from(toml, "utf8")),
      semantic: computeAssetSemanticDigest(model),
    },
  };
}

function throwProposalFailure(result: Extract<AssetProposalValidation, { readonly valid: false }>): never {
  const first = result.diagnostics[0];
  if (first === undefined) fail(context(), "TRANSACTION_INVALID_PLAN", "Asset proposal validation returned no diagnostic.");
  fail(context(), first.code, first.message, first.location);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function freezeChanges(changes: readonly ArchiveSemanticChange[]): readonly ArchiveSemanticChange[] {
  return deepFreeze(Object.freeze(changes.map((change) => ({
    ...change,
    ...(change.pathText === undefined ? {} : { pathText: { ...change.pathText } }),
  }))));
}

export async function planAssetEdit(options: AssetEditOptions): Promise<AssetEditPlan> {
  const project = await loadCanonicalProject(options.root, "edit");
  enforceMutationAssetLimit(project, "edit");
  const current = project.assets.find((asset) => asset.id === options.assetId);
  if (current === undefined) {
    fail(context(), "PROJECT_UNKNOWN_ASSET", `Asset '${options.assetId}' does not exist in the canonical project.`, options.assetId);
  }
  const proposal = validateAssetProposal(project, options.assetId, options.proposedToml);
  if (!proposal.valid) throwProposalFailure(proposal);

  const affectedCanonicalPath = `.tfsb/assets/${options.assetId}.toml`;
  const currentFile = project.snapshot.files.get(affectedCanonicalPath);
  if (currentFile === undefined) {
    fail(context(), "PROJECT_ASSET_MISSING", "The addressed canonical asset file is missing.", affectedCanonicalPath);
  }
  const oldDigest = computeAssetSemanticDigest(current);
  const newDigest = proposal.digests.semantic;
  const semanticDiff = diffAssetModels(current, proposal.model);
  const proposedBytes = Buffer.from(proposal.canonicalToml, "utf8");
  const nextFiles = new Map<string, Uint8Array>(
    [...project.snapshot.files].map(([path, file]) => [path, Buffer.from(file.bytes)]),
  );
  nextFiles.set(affectedCanonicalPath, proposedBytes);
  const plan: AssetEditPlan = Object.freeze({
    assetId: options.assetId,
    affectedCanonicalPath,
    oldDigest,
    newDigest,
    changed: !Buffer.from(currentFile.bytes).equals(proposedBytes),
    semanticChanges: freezeChanges(semanticDiff.changes),
    [assetEditPlanBrand]: true as const,
  });
  assetEditPlanInternals.set(plan, {
    root: project.root,
    snapshot: project.snapshot,
    nextFiles,
    oldDigest,
    newDigest,
    oldModel: current,
    newModel: proposal.model,
  });
  return plan;
}

async function stagedPaths(root: string, prefix = ""): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await stagedPaths(root, path));
    else if (entry.isFile() && !entry.isSymbolicLink()) paths.push(path);
    else fail({ operation: "edit", domain: "transaction" }, ASSET_EDIT_STAGE_INVALID, "Staged edit contains a symlink or special file.", path);
  }
  return paths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

async function validateStagedTree(stageRoot: string, expected: CanonicalTree): Promise<void> {
  const expectedPaths = [...expected.keys()]
    .map((path) => path.slice(".tfsb/".length))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const actualPaths = await stagedPaths(stageRoot);
  if (expectedPaths.length !== actualPaths.length || expectedPaths.some((path, index) => path !== actualPaths[index])) {
    fail({ operation: "edit", domain: "transaction" }, ASSET_EDIT_STAGE_INVALID, "Staged edit contains an unexpected or missing file.");
  }
  for (const [path, expectedBytes] of expected) {
    const actual = await readFile(join(stageRoot, path.slice(".tfsb/".length)));
    if (!actual.equals(Buffer.from(expectedBytes))) {
      fail({ operation: "edit", domain: "transaction" }, ASSET_EDIT_STAGE_INVALID, "Staged edit bytes differ from the authentic private plan.", path);
    }
  }
}

function requirePlanInternals(plan: AssetEditPlan): AssetEditPlanInternals {
  if (typeof plan !== "object" || plan === null) {
    fail({ operation: "edit", domain: "transaction" }, "TRANSACTION_INVALID_PLAN", "Asset edit plan is not authentic.");
  }
  const internals = assetEditPlanInternals.get(plan);
  if (internals === undefined || !Object.isFrozen(plan) || !Object.isFrozen(plan.semanticChanges)) {
    fail({ operation: "edit", domain: "transaction" }, "TRANSACTION_INVALID_PLAN", "Asset edit plan is not authentic.");
  }
  return internals;
}

export async function executeAssetEdit(plan: AssetEditPlan, hooks: TransactionHooks = {}): Promise<void> {
  const internals = requirePlanInternals(plan);
  const verifyCanonicalSnapshot = async (): Promise<void> => {
    const current = await snapshotCanonicalTree(internals.root, false, "edit");
    if (!snapshotsEqual(internals.snapshot, current)) {
      fail({ operation: "edit", domain: "transaction" }, "CANONICAL_CHANGED_DURING_PLAN", "Canonical tree changed during asset edit planning.", ".tfsb");
    }
  };
  // A semantically unchanged proposal does not need a transaction write, but
  // its authentic plan still binds the canonical state it was based on.
  if (!plan.changed) {
    await verifyCanonicalSnapshot();
    return;
  }
  const transactionHooks: TransactionHooks = {
    ...hooks,
    beforeFirstRename: async () => {
      await hooks.beforeFirstRename?.();
      await verifyCanonicalSnapshot();
    },
  };
  await executeCanonicalTransaction({
    root: internals.root,
    nextFiles: internals.nextFiles,
    expectedSnapshot: internals.snapshot,
    hooks: transactionHooks,
    operation: "edit",
    validateStagedTree: (stageRoot) => validateStagedTree(stageRoot, internals.nextFiles),
    verifyExternalState: verifyCanonicalSnapshot,
  });
}

/** Internal retention seam; not re-exported by the package root. */
export function inspectAssetEditPlanRetention(plan: AssetEditPlan): PlanRetentionInspection {
  const internals = assetEditPlanInternals.get(plan);
  if (internals === undefined) throw new Error("Asset edit plan was not produced by this planner instance.");
  return inspectPlanRetention([plan, internals]);
}
