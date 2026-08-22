import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { inspectBuild } from "./build.js";
import { loadCanonicalProject } from "./project.js";
import { createBuildReceipt } from "./receipt.js";

export interface CheckResult {
  readonly valid: true;
  readonly sourceChanged: boolean;
  readonly build: {
    readonly missing: readonly string[];
    readonly extra: readonly string[];
    readonly different: readonly string[];
  };
  readonly install: {
    readonly missing: readonly string[];
    readonly different: readonly string[];
  };
  readonly drift: boolean;
}

export async function checkProject(root: string): Promise<CheckResult> {
  const project = await loadCanonicalProject(root, "check");
  const build = await inspectBuild(project);
  const expectedReceipt = createBuildReceipt(project);
  const sourceChanged =
    build.receipt === undefined ||
    !isDeepStrictEqual(build.receipt.canonicalSources, expectedReceipt.canonicalSources);
  const installMissing: string[] = [];
  const installDifferent: string[] = [];
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  for (const install of project.project.installs) {
    const asset = assets.get(install.asset);
    if (asset === undefined) throw new Error("Validated install asset unexpectedly disappeared.");
    const expected = project.outputs.get(asset.filename);
    if (expected === undefined) throw new Error("Validated output unexpectedly disappeared.");
    for (const destination of project.installDestinations.get(install.asset) ?? []) {
      try {
        const actual = await readFile(destination);
        if (!Buffer.from(actual).equals(Buffer.from(expected))) installDifferent.push(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") installMissing.push(destination);
        else throw error;
      }
    }
  }
  for (const companion of project.project.companions ?? []) {
    const expected = project.companions.get(companion.file);
    if (expected === undefined) throw new Error("Validated companion unexpectedly disappeared.");
    for (const destination of project.companionDestinations.get(companion.file) ?? []) {
      try {
        const actual = await readFile(destination);
        if (!Buffer.from(actual).equals(Buffer.from(expected))) installDifferent.push(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") installMissing.push(destination);
        else throw error;
      }
    }
  }
  const drift =
    sourceChanged ||
    build.missing.length > 0 ||
    build.extra.length > 0 ||
    build.different.length > 0 ||
    installMissing.length > 0 ||
    installDifferent.length > 0;
  return {
    valid: true,
    sourceChanged,
    build: { missing: build.missing, extra: build.extra, different: build.different },
    install: { missing: installMissing, different: installDifferent },
    drift,
  };
}
