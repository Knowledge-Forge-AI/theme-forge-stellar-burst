import { join } from "node:path";

import { loadCanonicalProject, verifyLoadedProjectSnapshot } from "./project.js";
import { compareUtf8 } from "./provenance.js";

export interface AssetInventoryItem {
  readonly id: string;
  readonly filename: string;
  readonly buildPath: string;
  readonly destinations: readonly string[];
}

export interface CompanionInventoryItem {
  readonly file: string;
  readonly canonicalPath: string;
  readonly destinations: readonly string[];
}

export interface ProjectInventory {
  readonly assets: readonly AssetInventoryItem[];
  readonly companions: readonly CompanionInventoryItem[];
}

export async function listProject(root: string): Promise<ProjectInventory> {
  const project = await loadCanonicalProject(root, "list");
  const assets = [...project.assets].sort((left, right) => compareUtf8(left.id, right.id)).map((asset) => ({
    id: asset.id,
    filename: asset.filename,
    buildPath: join(project.project.buildDirectory, asset.filename).replaceAll("\\", "/"),
    destinations: project.project.installs.find((install) => install.asset === asset.id)?.destinations ?? [],
  }));
  const declarations = new Map<string, readonly string[]>(project.project.companions.map((companion) => [companion.file, companion.destinations]));
  const companions = [...project.companions.keys()].sort(compareUtf8).map((file) => ({
    file,
    canonicalPath: `.tfsb/companions/${file}`,
    destinations: declarations.get(file) ?? [],
  }));
  await verifyLoadedProjectSnapshot(project, "list");
  return { assets, companions };
}
