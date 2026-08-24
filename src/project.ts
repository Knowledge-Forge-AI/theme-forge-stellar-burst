import { isAllowedCompanionFilename } from "./archive.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import { resolveConfinedPath, validateProjectPathLayout } from "./root.js";
import {
  parseAssetTomlVersioned,
  parseProjectTomlVersioned,
  type AnyNormalizedAsset,
  type AnyNormalizedProject,
} from "./schema-dispatch.js";
import { serializeSvgV2 } from "./schema2-svg.js";
import { serializeSvg } from "./svg.js";
import { snapshotCanonicalTree, snapshotsEqual, type CanonicalSnapshot } from "./transaction.js";
import type { Result } from "./types.js";

export interface LoadedProject {
  readonly root: string;
  readonly project: AnyNormalizedProject;
  readonly assets: readonly AnyNormalizedAsset[];
  readonly companions: ReadonlyMap<string, Uint8Array>;
  readonly canonicalFiles: ReadonlyMap<string, Uint8Array>;
  readonly outputs: ReadonlyMap<string, Uint8Array>;
  readonly buildDirectory: string;
  readonly installDestinations: ReadonlyMap<string, readonly string[]>;
  readonly companionDestinations: ReadonlyMap<string, readonly string[]>;
  readonly snapshot: CanonicalSnapshot;
}

export const MAX_LIFECYCLE_ASSETS = 128;

export function enforceMutationAssetLimit(
  project: number | Pick<LoadedProject, "assets">,
  operation: DiagnosticContext["operation"],
): void {
  const assetCount = typeof project === "number" ? project : project.assets.length;
  if (assetCount > MAX_LIFECYCLE_ASSETS) {
    fail(
      { operation, domain: "project" },
      "RESOURCE_LIMIT_EXCEEDED",
      `Mutation supports at most ${MAX_LIFECYCLE_ASSETS} assets; project contains ${assetCount}.`,
      ".tfsb/assets",
    );
  }
}

export async function verifyLoadedProjectSnapshot(
  project: Pick<LoadedProject, "root" | "snapshot">,
  operation: DiagnosticContext["operation"],
): Promise<void> {
  const current = await snapshotCanonicalTree(project.root, false, operation);
  if (!snapshotsEqual(project.snapshot, current)) {
    fail(
      { operation, domain: "transaction" },
      "CANONICAL_CHANGED_DURING_PLAN",
      "Canonical tree changed during the operation.",
      ".tfsb",
    );
  }
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const first = result.diagnostics[0];
  if (first === undefined) throw new Error("Diagnostic result was unexpectedly empty.");
  throw new DiagnosticError(first);
}

function context(operation: DiagnosticContext["operation"]): DiagnosticContext {
  return { operation, domain: "project" };
}

export async function loadCanonicalProject(
  root: string,
  operation: DiagnosticContext["operation"],
): Promise<LoadedProject> {
  return decodeCanonicalProjectSnapshot(await snapshotCanonicalTree(root, false, operation), operation, root);
}

export async function loadCanonicalProjectFromSnapshot(
  snapshot: CanonicalSnapshot,
  operation: DiagnosticContext["operation"],
): Promise<LoadedProject> {
  return decodeCanonicalProjectSnapshot(snapshot, operation, snapshot.root);
}

async function decodeCanonicalProjectSnapshot(
  snapshot: CanonicalSnapshot,
  operation: DiagnosticContext["operation"],
  root: string,
): Promise<LoadedProject> {
  const ctx = context(operation);
  const canonicalFiles = new Map<string, Uint8Array>();
  if (!snapshot.canonicalPresent) fail(ctx, "ROOT_NOT_FOUND", "Canonical .tfsb directory is missing.", ".tfsb");
  const projectBytes = snapshot.files.get(".tfsb/project.toml")?.bytes;
  if (projectBytes === undefined) fail(ctx, "ROOT_NOT_FOUND", "Canonical .tfsb/project.toml could not be read.", ".tfsb/project.toml");
  canonicalFiles.set(".tfsb/project.toml", projectBytes);
  const project = unwrap(parseProjectTomlVersioned(Buffer.from(projectBytes).toString("utf8"), ".tfsb/project.toml"));
  validateProjectPathLayout(project);

  if (!snapshot.directories.includes(".tfsb/assets")) {
    fail(ctx, "PROJECT_ASSETS_MISSING", "Canonical .tfsb/assets must be a non-symlink directory.", ".tfsb/assets");
  }
  const assets: AnyNormalizedAsset[] = [];
  const ids = new Map<string, string>();
  const filenames = new Map<string, string>();
  const assetPaths = [...snapshot.files.keys()]
    .filter((path) => path.startsWith(".tfsb/assets/"))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const relativePath of assetPaths) {
    const entryName = relativePath.slice(".tfsb/assets/".length);
    const bytes = snapshot.files.get(relativePath)!.bytes;
    canonicalFiles.set(relativePath, bytes);
    const asset = unwrap(parseAssetTomlVersioned(Buffer.from(bytes).toString("utf8"), project.schemaVersion, relativePath));
    if (entryName !== `${asset.id}.toml`) {
      fail(
        ctx,
        "PROJECT_ASSET_FILENAME_MISMATCH",
        `Asset '${asset.id}' must be stored as '${asset.id}.toml'.`,
        relativePath,
      );
    }
    const previousId = ids.get(asset.id);
    if (previousId !== undefined) {
      fail(ctx, "PROJECT_DUPLICATE_ASSET", `Asset id '${asset.id}' is duplicated.`, relativePath);
    }
    const previousFilename = filenames.get(asset.filename);
    if (previousFilename !== undefined) {
      fail(
        ctx,
        "PROJECT_DUPLICATE_FILENAME",
        `Generated filename '${asset.filename}' is shared by '${previousFilename}' and '${asset.id}'.`,
        relativePath,
      );
    }
    ids.set(asset.id, relativePath);
    filenames.set(asset.filename, asset.id);
    assets.push(asset);
  }
  for (const install of project.installs) {
    if (!ids.has(install.asset)) {
      fail(
        ctx,
        "PROJECT_UNKNOWN_INSTALL_ASSET",
        `Install rule refers to unknown asset '${install.asset}'.`,
        "install.asset",
      );
    }
  }

  const companions = new Map<string, Uint8Array>();
  if (snapshot.directories.includes(".tfsb/companions")) {
    const companionPaths = [...snapshot.files.keys()]
      .filter((path) => path.startsWith(".tfsb/companions/"))
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const relativePath of companionPaths) {
      const entryName = relativePath.slice(".tfsb/companions/".length);
      if (!isAllowedCompanionFilename(entryName)) {
        fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", `Unsupported canonical companion entry '${entryName}'.`, relativePath);
      }
      const bytes = snapshot.files.get(relativePath)!.bytes;
      canonicalFiles.set(relativePath, bytes);
      companions.set(entryName, bytes);
    }
  }
  for (const companion of project.companions ?? []) {
    if (!companions.has(companion.file)) {
      fail(
        ctx,
        "PROJECT_UNKNOWN_COMPANION",
        `Companion rule refers to unknown companion file '${companion.file}'.`,
        "companion.file",
      );
    }
  }

  const outputs = new Map<string, Uint8Array>();
  for (const asset of assets) {
    const serialized = unwrap(
      asset.schemaVersion === 1
        ? serializeSvg(asset.svg, `.tfsb/assets/${asset.id}.toml`)
        : serializeSvgV2(asset.svg, `.tfsb/assets/${asset.id}.toml`),
    );
    outputs.set(asset.filename, Buffer.from(serialized, "utf8"));
  }
  const buildDirectory = await resolveConfinedPath(root, project.buildDirectory, operation);
  const installDestinations = new Map<string, readonly string[]>();
  for (const install of project.installs) {
    installDestinations.set(
      install.asset,
      await Promise.all(
        install.destinations.map((destination) => resolveConfinedPath(root, destination, operation, { allowFinalSymlink: true })),
      ),
    );
  }
  const companionDestinations = new Map<string, readonly string[]>();
  for (const companion of project.companions ?? []) {
    companionDestinations.set(
      companion.file,
      await Promise.all(
        companion.destinations.map((destination) => resolveConfinedPath(root, destination, operation, { allowFinalSymlink: true })),
      ),
    );
  }
  return {
    root,
    project,
    assets,
    companions,
    canonicalFiles,
    outputs,
    buildDirectory,
    installDestinations,
    companionDestinations,
    snapshot,
  };
}
