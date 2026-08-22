import { join } from "node:path";

import { loadCanonicalProject } from "./project.js";

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
  const assets = project.assets.map((asset) => ({
    id: asset.id,
    filename: asset.filename,
    buildPath: join(project.project.buildDirectory, asset.filename).replaceAll("\\", "/"),
    destinations: project.project.installs.find((install) => install.asset === asset.id)?.destinations ?? [],
  }));
  const companions = (project.project.companions ?? []).map((companion) => ({
    file: companion.file,
    canonicalPath: `.tfsb/companions/${companion.file}`,
    destinations: companion.destinations,
  }));
  return { assets, companions };
}
