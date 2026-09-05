import { checkProject } from "./check.js";
import { DiagnosticError, diagnostic } from "./diagnostics.js";
import { verifyLoadedProjectSnapshot } from "./project.js";
import type { Diagnostic } from "./types.js";
import { findWorkspaceAssetCollisions } from "./workspace-collisions.js";
import {
  computeWorkspaceChildSeal,
  openWorkspaceFile,
  verifyWorkspaceSnapshot,
  withWorkspaceChild,
  type WorkspaceProjectV1,
  type WorkspaceStreamMetrics,
} from "./workspace.js";

export type WorkspaceCheckStatus = "ok" | "drift" | "error";
export interface WorkspaceChildCheckSummary {
  readonly projectId: string;
  readonly projectPath: string;
  readonly status: "clean" | "drift" | "error";
  readonly sourceChanged: boolean;
  readonly buildMissing: number;
  readonly buildExtra: number;
  readonly buildDifferent: number;
  readonly installMissing: number;
  readonly installDifferent: number;
  readonly diagnostic?: { readonly code: string; readonly message: string };
}
export interface WorkspaceCheckResult {
  readonly status: WorkspaceCheckStatus;
  readonly workspace: { readonly id: string; readonly name: string; readonly digest: string };
  readonly projects: { readonly total: number; readonly checked: number; readonly clean: number; readonly drifted: number; readonly failed: number };
  readonly drift: { readonly sourceChangedProjects: number; readonly buildMissing: number; readonly buildExtra: number; readonly buildDifferent: number; readonly installMissing: number; readonly installDifferent: number };
  readonly children: readonly WorkspaceChildCheckSummary[];
  readonly diagnostics: readonly Diagnostic[];
}
export interface WorkspaceCheckOptions {
  readonly workspaceFile: string;
  readonly metrics?: WorkspaceStreamMetrics;
  readonly hooks?: { readonly checkCancelled?: () => void; readonly onProgress?: (completedProjects: number, totalProjects: number) => void };
}

const ctx = { operation: "check" as const, domain: "workspace" as const };

function failure(child: WorkspaceProjectV1, error: unknown): WorkspaceChildCheckSummary {
  const code = error instanceof DiagnosticError ? error.diagnostic.code : "INTERNAL_ERROR";
  return {
    projectId: child.id, projectPath: child.path, status: "error", sourceChanged: false,
    buildMissing: 0, buildExtra: 0, buildDifferent: 0, installMissing: 0, installDifferent: 0,
    diagnostic: { code, message: `Child '${child.id}' could not be checked (${code}).` },
  };
}

export async function checkWorkspace(options: WorkspaceCheckOptions): Promise<WorkspaceCheckResult> {
  const opened = await openWorkspaceFile(options.workspaceFile);
  const summaries = new Map<string, WorkspaceChildCheckSummary>();
  const seals = new Map<string, string>();
  const diagnostics: Diagnostic[] = [];

  for (const [childIndex, child] of opened.workspace.projects.entries()) {
    options.hooks?.checkCancelled?.();
    try {
      const initial = await withWorkspaceChild(opened, child, "check", async ({ loaded, root }) => {
        await verifyLoadedProjectSnapshot(loaded, "check");
        return { root, seal: computeWorkspaceChildSeal(loaded) };
      }, options.metrics);
      seals.set(child.id, initial.seal);
      const result = await checkProject(initial.root);
      summaries.set(child.id, {
        projectId: child.id, projectPath: child.path, status: result.drift ? "drift" : "clean", sourceChanged: result.sourceChanged,
        buildMissing: result.build.missing.length, buildExtra: result.build.extra.length, buildDifferent: result.build.different.length,
        installMissing: result.install.missing.length, installDifferent: result.install.different.length,
      });
    } catch (error) {
      const summary = failure(child, error);
      summaries.set(child.id, summary);
      diagnostics.push(diagnostic(ctx, "WORKSPACE_CHILD_CHECK_FAILED", summary.diagnostic!.message, child.path));
    }
    options.hooks?.onProgress?.(childIndex + 1, opened.workspace.projects.length);
  }

  for (const child of opened.workspace.projects) {
    options.hooks?.checkCancelled?.();
    if (!seals.has(child.id) || summaries.get(child.id)?.status === "error") continue;
    try {
      await withWorkspaceChild(opened, child, "check", async ({ loaded }) => {
        if (computeWorkspaceChildSeal(loaded) !== seals.get(child.id)) throw new DiagnosticError(diagnostic(ctx, "WORKSPACE_CHILD_CHANGED", `Child '${child.id}' changed during aggregate check.`, child.path));
        await verifyLoadedProjectSnapshot(loaded, "check");
      }, options.metrics);
    } catch (error) {
      const summary = failure(child, error);
      summaries.set(child.id, summary);
      diagnostics.push(diagnostic(ctx, "WORKSPACE_CHILD_CHANGED", `Child '${child.id}' changed during aggregate check.`, child.path));
    }
  }
  await verifyWorkspaceSnapshot(opened);

  const children = opened.workspace.projects.map((child) => summaries.get(child.id) ?? failure(child, undefined));
  const clean = children.filter((item) => item.status === "clean").length;
  const drifted = children.filter((item) => item.status === "drift").length;
  const failed = children.filter((item) => item.status === "error").length;
  if (failed === 0) diagnostics.push(...await findWorkspaceAssetCollisions(opened, "check", options.metrics, options.hooks ?? {}));
  const checked = clean + drifted;
  const hasCollision = diagnostics.some((item) => item.code === "WORKSPACE_ASSET_ID_COLLISION");
  const status: WorkspaceCheckStatus = failed > 0 || hasCollision ? "error" : drifted > 0 ? "drift" : "ok";
  return {
    status,
    workspace: { id: opened.workspace.id, name: opened.workspace.name, digest: opened.workspaceDigest },
    projects: { total: children.length, checked, clean, drifted, failed },
    drift: {
      sourceChangedProjects: children.filter((item) => item.status !== "error" && item.sourceChanged).length,
      buildMissing: children.reduce((sum, item) => sum + item.buildMissing, 0),
      buildExtra: children.reduce((sum, item) => sum + item.buildExtra, 0),
      buildDifferent: children.reduce((sum, item) => sum + item.buildDifferent, 0),
      installMissing: children.reduce((sum, item) => sum + item.installMissing, 0),
      installDifferent: children.reduce((sum, item) => sum + item.installDifferent, 0),
    },
    children,
    diagnostics,
  };
}
