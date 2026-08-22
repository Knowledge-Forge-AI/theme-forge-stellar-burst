import { lstat, readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { isAllowedCompanionFilename } from "./archive.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import { resolveConfinedPath, validateProjectPathLayout } from "./root.js";
import { serializeSvg } from "./svg.js";
import { parseAssetToml, parseProjectToml } from "./toml.js";
import type { NormalizedAsset, NormalizedProject, Result } from "./types.js";

export interface LoadedProject {
  readonly root: string;
  readonly project: NormalizedProject;
  readonly assets: readonly NormalizedAsset[];
  readonly companions: ReadonlyMap<string, Uint8Array>;
  readonly canonicalFiles: ReadonlyMap<string, Uint8Array>;
  readonly outputs: ReadonlyMap<string, Uint8Array>;
  readonly buildDirectory: string;
  readonly installDestinations: ReadonlyMap<string, readonly string[]>;
  readonly companionDestinations: ReadonlyMap<string, readonly string[]>;
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
  const ctx = context(operation);
  const canonicalFiles = new Map<string, Uint8Array>();
  const canonicalDirectory = await lstat(join(root, ".tfsb"));
  if (!canonicalDirectory.isDirectory() || canonicalDirectory.isSymbolicLink()) {
    fail(ctx, "ROOT_SYMLINK_ESCAPE", "Canonical .tfsb must be a non-symlink directory.", ".tfsb");
  }
  const projectPath = join(root, ".tfsb", "project.toml");
  let projectBytes: Buffer;
  try {
    projectBytes = await readFile(projectPath);
  } catch {
    fail(ctx, "ROOT_NOT_FOUND", "Canonical .tfsb/project.toml could not be read.", ".tfsb/project.toml");
  }
  canonicalFiles.set(".tfsb/project.toml", projectBytes);
  const project = unwrap(parseProjectToml(projectBytes.toString("utf8"), ".tfsb/project.toml"));
  validateProjectPathLayout(project);

  const assetsDirectory = join(root, ".tfsb", "assets");
  const assetsStat = await lstat(assetsDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (assetsStat === undefined || !assetsStat.isDirectory() || assetsStat.isSymbolicLink()) {
    fail(ctx, "PROJECT_ASSETS_MISSING", "Canonical .tfsb/assets must be a non-symlink directory.", ".tfsb/assets");
  }
  let entries: Dirent<string>[];
  try {
    entries = await readdir(assetsDirectory, { withFileTypes: true });
  } catch {
    fail(ctx, "PROJECT_ASSETS_MISSING", "Canonical .tfsb/assets directory could not be read.", ".tfsb/assets");
  }
  const assets: NormalizedAsset[] = [];
  const ids = new Map<string, string>();
  const filenames = new Map<string, string>();
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relativePath = `.tfsb/assets/${entry.name}`;
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".toml")) {
      fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", `Unsupported canonical asset entry '${entry.name}'.`, relativePath);
    }
    const bytes = await readFile(join(assetsDirectory, entry.name));
    canonicalFiles.set(relativePath, bytes);
    const asset = unwrap(parseAssetToml(bytes.toString("utf8"), relativePath));
    if (entry.name !== `${asset.id}.toml`) {
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

  const companionsDirectory = join(root, ".tfsb", "companions");
  const companionsStat = await lstat(companionsDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const companions = new Map<string, Uint8Array>();
  if (companionsStat !== undefined) {
    if (!companionsStat.isDirectory() || companionsStat.isSymbolicLink()) {
      fail(ctx, "PROJECT_COMPANIONS_INVALID", "Canonical .tfsb/companions must be a non-symlink directory.", ".tfsb/companions");
    }
    let companionEntries: Dirent<string>[];
    try {
      companionEntries = await readdir(companionsDirectory, { withFileTypes: true });
    } catch {
      fail(ctx, "PROJECT_COMPANIONS_INVALID", "Canonical .tfsb/companions directory could not be read.", ".tfsb/companions");
    }
    for (const entry of [...companionEntries].sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const relativePath = `.tfsb/companions/${entry.name}`;
      if (!entry.isFile() || entry.isSymbolicLink() || !isAllowedCompanionFilename(entry.name)) {
        fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", `Unsupported canonical companion entry '${entry.name}'.`, relativePath);
      }
      const bytes = await readFile(join(companionsDirectory, entry.name));
      canonicalFiles.set(relativePath, bytes);
      companions.set(entry.name, bytes);
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
    const serialized = unwrap(serializeSvg(asset.svg, `.tfsb/assets/${asset.id}.toml`));
    outputs.set(asset.filename, Buffer.from(serialized, "utf8"));
  }
  const buildDirectory = await resolveConfinedPath(root, project.buildDirectory, operation);
  const installDestinations = new Map<string, readonly string[]>();
  for (const install of project.installs) {
    installDestinations.set(
      install.asset,
      await Promise.all(
        install.destinations.map((destination) => resolveConfinedPath(root, destination, operation)),
      ),
    );
  }
  const companionDestinations = new Map<string, readonly string[]>();
  for (const companion of project.companions ?? []) {
    companionDestinations.set(
      companion.file,
      await Promise.all(
        companion.destinations.map((destination) => resolveConfinedPath(root, destination, operation)),
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
  };
}
