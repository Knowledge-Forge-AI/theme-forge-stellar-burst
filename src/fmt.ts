import { isDeepStrictEqual } from "node:util";

import { DiagnosticError, fail } from "./diagnostics.js";
import { enforceMutationAssetLimit, loadCanonicalProjectFromSnapshot } from "./project.js";
import { findProjectRoot } from "./root.js";
import {
  parseAssetTomlVersioned,
  parseProjectTomlVersioned,
  serializeAssetTomlVersioned,
  serializeProjectTomlVersioned,
} from "./schema-dispatch.js";
import {
  executeCanonicalTransaction,
  snapshotCanonicalTree,
  snapshotsEqual,
  type CanonicalSnapshot,
  type TransactionHooks,
} from "./transaction.js";
import { inspectPlanRetention, type PlanRetentionInspection } from "./plan-retention.js";
import type { Result } from "./types.js";

const formatPlanBrand: unique symbol = Symbol("tfsb-format-plan");

export interface FormatPlan {
  readonly changed: boolean;
  readonly paths: readonly string[];
  readonly [formatPlanBrand]: true;
}

export interface FormatOptions {
  readonly root?: string;
  readonly check?: boolean;
}

export interface FormatResult {
  readonly check: boolean;
  readonly changed: boolean;
  readonly applied: boolean;
  readonly paths: readonly string[];
}

interface FormatPlanInternals {
  readonly root: string;
  readonly snapshot: CanonicalSnapshot;
  readonly nextFiles: ReadonlyMap<string, Uint8Array>;
  readonly assetCount: number;
}

const formatPlanInternals = new WeakMap<FormatPlan, FormatPlanInternals>();

export interface FormatPlanningHooks {
  readonly checkCancelled?: () => void | Promise<void>;
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const first = result.diagnostics[0];
  if (first === undefined) throw new Error("Diagnostic result was unexpectedly empty.");
  throw new DiagnosticError(first);
}

export async function planFormatWithHooks(rootInput?: string, hooks: FormatPlanningHooks = {}): Promise<FormatPlan> {
  await hooks.checkCancelled?.();
  const root = await findProjectRoot(rootInput, "fmt", rootInput !== undefined);
  const snapshot = await snapshotCanonicalTree(root, false, "fmt");
  const project = await loadCanonicalProjectFromSnapshot(snapshot, "fmt");
  const nextFiles = new Map([...snapshot.files].map(([path, file]) => [path, file.bytes]));
  const changedPaths: string[] = [];
  for (const [path, file] of snapshot.files) {
    await hooks.checkCancelled?.();
    if (path !== ".tfsb/project.toml" && !path.startsWith(".tfsb/assets/")) continue;
    const before = path === ".tfsb/project.toml"
      ? project.project
      : project.assets.find((asset) => `.tfsb/assets/${asset.id}.toml` === path)!;
    const serialized = path === ".tfsb/project.toml"
      ? serializeProjectTomlVersioned(project.project)
      : serializeAssetTomlVersioned(before as (typeof project.assets)[number]);
    const after = path === ".tfsb/project.toml"
      ? unwrap(parseProjectTomlVersioned(serialized, path))
      : unwrap(parseAssetTomlVersioned(serialized, project.project.schemaVersion, path));
    if (!isDeepStrictEqual(before, after)) throw new Error("Canonical formatting changed normalized project semantics.");
    const bytes = Buffer.from(serialized, "utf8");
    if (!Buffer.from(file.bytes).equals(bytes)) {
      changedPaths.push(path);
      nextFiles.set(path, bytes);
    }
  }
  changedPaths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const current = await snapshotCanonicalTree(root, false, "fmt");
  if (!snapshotsEqual(snapshot, current)) {
    fail({ operation: "fmt", domain: "transaction" }, "CANONICAL_CHANGED_DURING_PLAN", "Canonical tree changed during formatting inspection.", ".tfsb");
  }
  await hooks.checkCancelled?.();
  const plan = Object.freeze({ changed: changedPaths.length > 0, paths: Object.freeze(changedPaths), [formatPlanBrand]: true as const });
  formatPlanInternals.set(plan, { root, snapshot, nextFiles, assetCount: project.assets.length });
  return plan;
}

export async function planFormat(rootInput?: string): Promise<FormatPlan> {
  return planFormatWithHooks(rootInput, {});
}

export async function executeFormat(plan: FormatPlan, hooks: TransactionHooks = {}): Promise<void> {
  const internals = formatPlanInternals.get(plan);
  if (internals === undefined || !Object.isFrozen(plan) || !Object.isFrozen(plan.paths)) {
    throw new DiagnosticError({ code: "FORMAT_INVALID_PLAN", operation: "fmt", domain: "transaction", message: "Format plan is not authentic." });
  }
  enforceMutationAssetLimit(internals.assetCount, "fmt");
  if (!plan.changed) return;
  await executeCanonicalTransaction({ root: internals.root, nextFiles: internals.nextFiles, expectedSnapshot: internals.snapshot, hooks, operation: "fmt" });
}

/** Internal retention seam; not re-exported by the package root. */
export function inspectFormatPlanRetention(plan: FormatPlan): PlanRetentionInspection {
  const internals = formatPlanInternals.get(plan);
  if (internals === undefined) throw new Error("Format plan was not produced by this planner instance.");
  return inspectPlanRetention([plan, internals]);
}

/** Internal service summary seam; preserves the public changed-path contract. */
export function formatPlanCanonicalPaths(plan: FormatPlan): readonly string[] {
  const internals = formatPlanInternals.get(plan);
  if (internals === undefined) throw new Error("Format plan was not produced by this planner instance.");
  return Object.freeze([...internals.snapshot.files.keys()].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
}

export async function formatProject(options: FormatOptions = {}, hooks: TransactionHooks = {}): Promise<FormatResult> {
  const plan = await planFormat(options.root);
  const check = options.check === true;
  if (!check && plan.changed) await executeFormat(plan, hooks);
  return { check, changed: plan.changed, applied: !check && plan.changed, paths: plan.paths };
}
