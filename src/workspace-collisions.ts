import { computeRawSha256 } from "./digests.js";
import { diagnostic } from "./diagnostics.js";
import { verifyLoadedProjectSnapshot } from "./project.js";
import type { Diagnostic } from "./types.js";
import { compareWorkspaceUtf8, withWorkspaceChild, type OpenWorkspace, type WorkspaceStreamMetrics } from "./workspace.js";

const BLOOM_BYTES = 1024 * 1024;
const MAX_COLLISION_DIAGNOSTICS = 64;

function indexes(id: string): readonly number[] {
  const bytes = Buffer.from(computeRawSha256(Buffer.from(id, "utf8")), "hex");
  return [0, 4, 8, 12].map((offset) => bytes.readUInt32BE(offset) % (BLOOM_BYTES * 8));
}
function present(bits: Uint8Array, id: string): boolean {
  return indexes(id).every((index) => (bits[Math.floor(index / 8)]! & (1 << (index % 8))) !== 0);
}
function add(bits: Uint8Array, id: string): void {
  for (const index of indexes(id)) bits[Math.floor(index / 8)]! |= 1 << (index % 8);
}

/** Fixed-memory exact collision detection. Bloom hits are confirmed by bounded child rescans. */
export async function findWorkspaceAssetCollisions(
  opened: OpenWorkspace,
  operation: "list" | "check" | "preview",
  metrics?: WorkspaceStreamMetrics,
  hooks: { readonly checkCancelled?: () => void } = {},
): Promise<readonly Diagnostic[]> {
  const bits = new Uint8Array(BLOOM_BYTES);
  const diagnostics: Diagnostic[] = [];
  const reported = new Set<string>();
  for (const [childIndex, child] of opened.workspace.projects.entries()) {
    hooks.checkCancelled?.();
    const ids = await withWorkspaceChild(opened, child, operation, async ({ loaded }) => {
      const value = loaded.assets.map((asset) => asset.id).sort(compareWorkspaceUtf8);
      await verifyLoadedProjectSnapshot(loaded, operation);
      return value;
    }, metrics);
    for (const id of ids.filter((value) => present(bits, value))) {
      let previousOwner: string | undefined;
      for (const previous of opened.workspace.projects.slice(0, childIndex)) {
        hooks.checkCancelled?.();
        const found = await withWorkspaceChild(opened, previous, operation, async ({ loaded }) => {
          const match = loaded.assets.some((asset) => asset.id === id);
          await verifyLoadedProjectSnapshot(loaded, operation);
          return match;
        }, metrics);
        if (found) { previousOwner = previous.id; break; }
      }
      if (previousOwner !== undefined && !reported.has(id)) {
        reported.add(id);
        if (diagnostics.length < MAX_COLLISION_DIAGNOSTICS) diagnostics.push(diagnostic(
          { operation, domain: "workspace" },
          "WORKSPACE_ASSET_ID_COLLISION",
          `Asset ID '${id}' is present in ${previousOwner}, ${child.id}.`,
          id,
        ));
      }
    }
    for (const id of ids) add(bits, id);
  }
  if (reported.size > MAX_COLLISION_DIAGNOSTICS) diagnostics.push(diagnostic(
    { operation, domain: "workspace" },
    "WORKSPACE_ASSET_ID_COLLISION",
    `Workspace contains ${reported.size} colliding asset IDs; ${MAX_COLLISION_DIAGNOSTICS} diagnostics are shown.`,
  ));
  return diagnostics;
}
