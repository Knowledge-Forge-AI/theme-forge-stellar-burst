import { isDeepStrictEqual } from "node:util";

import { DiagnosticError, fail } from "./diagnostics.js";
import { enforceMutationAssetLimit, loadCanonicalProjectFromSnapshot } from "./project.js";
import { findProjectRoot } from "./root.js";
import { parseAssetToml, parseProjectToml } from "./toml.js";
import { serializeAssetToml, serializeProjectToml } from "./toml-writer.js";
import {
  executeCanonicalTransaction,
  snapshotCanonicalTree,
  snapshotsEqual,
  type CanonicalSnapshot,
  type TransactionHooks,
} from "./transaction.js";
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

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const first = result.diagnostics[0];
  if (first === undefined) throw new Error("Diagnostic result was unexpectedly empty.");
  throw new DiagnosticError(first);
}

export async function planFormat(rootInput?: string): Promise<FormatPlan> {
  const root = await findProjectRoot(rootInput, "fmt", rootInput !== undefined);
  const snapshot = await snapshotCanonicalTree(root, false, "fmt");
  const project = await loadCanonicalProjectFromSnapshot(snapshot, "fmt");
  const nextFiles = new Map([...snapshot.files].map(([path, file]) => [path, file.bytes]));
  const changedPaths: string[] = [];
  for (const [path, file] of snapshot.files) {
    if (path !== ".tfsb/project.toml" && !path.startsWith(".tfsb/assets/")) continue;
    const before = path === ".tfsb/project.toml"
      ? project.project
      : project.assets.find((asset) => `.tfsb/assets/${asset.id}.toml` === path)!;
    const serialized = path === ".tfsb/project.toml"
      ? serializeProjectToml(before as Parameters<typeof serializeProjectToml>[0])
      : serializeAssetToml(before as Parameters<typeof serializeAssetToml>[0]);
    const after = path === ".tfsb/project.toml" ? unwrap(parseProjectToml(serialized, path)) : unwrap(parseAssetToml(serialized, path));
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
  const plan = Object.freeze({ changed: changedPaths.length > 0, paths: Object.freeze(changedPaths), [formatPlanBrand]: true as const });
  formatPlanInternals.set(plan, { root, snapshot, nextFiles, assetCount: project.assets.length });
  return plan;
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

export async function formatProject(options: FormatOptions = {}, hooks: TransactionHooks = {}): Promise<FormatResult> {
  const plan = await planFormat(options.root);
  const check = options.check === true;
  if (!check && plan.changed) await executeFormat(plan, hooks);
  return { check, changed: plan.changed, applied: !check && plan.changed, paths: plan.paths };
}
