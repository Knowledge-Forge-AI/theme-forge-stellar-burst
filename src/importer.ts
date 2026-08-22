import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { readArchive, type SelectedArchiveCompanion } from "./archive.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import { defaultProjectName, resolveImportRoot } from "./root.js";
import { parseAssetToml, parseProjectToml } from "./toml.js";
import { serializeAssetToml, serializeProjectToml } from "./toml-writer.js";
import { parseSvg } from "./svg.js";
import type {
  AssetId,
  NormalizedAsset,
  NormalizedProject,
  ProjectRelativePath,
  Result,
  SvgFilename,
} from "./types.js";

export interface ImportOptions {
  readonly archive: string;
  readonly root?: string;
  readonly selections?: readonly string[];
  readonly companions?: readonly string[];
  readonly dryRun?: boolean;
}

export interface ImportPlan {
  readonly root: string;
  readonly archive: string;
  readonly project: NormalizedProject;
  readonly assets: readonly NormalizedAsset[];
  readonly companions: readonly SelectedArchiveCompanion[];
  readonly files: ReadonlyMap<string, string | Uint8Array>;
}

function context(source?: string): DiagnosticContext {
  return { operation: "import", domain: "project", ...(source === undefined ? {} : { source }) };
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const first = result.diagnostics[0];
  if (first === undefined) throw new Error("Diagnostic result was unexpectedly empty.");
  throw new DiagnosticError(first);
}

function deriveAssetIdentity(entryName: string, ctx: DiagnosticContext): { id: AssetId; filename: SvgFilename } {
  const leaf = basename(entryName);
  const rawStem = leaf.slice(0, -4).normalize("NFC");
  const id = rawStem.toLowerCase().replace(/[ _]+/g, "-");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    fail(
      ctx,
      "ARCHIVE_INVALID_ASSET_ID",
      `Entry '${entryName}' cannot be deterministically mapped to a lowercase kebab-case asset id.`,
      entryName,
    );
  }
  return { id: id as AssetId, filename: `${id}.svg` as SvgFilename };
}

export async function planImport(options: ImportOptions): Promise<ImportPlan> {
  const root = await resolveImportRoot(options.root);
  const ctx = context(options.archive);
  const archiveResult = await readArchive(
    options.archive,
    options.selections ?? [],
    options.companions ?? [],
  );
  const ids = new Map<string, string>();
  const filenames = new Map<string, string>();
  const assets: NormalizedAsset[] = [];
  for (const entry of archiveResult.svgs) {
    const identity = deriveAssetIdentity(entry.entryName, ctx);
    const previousId = ids.get(identity.id);
    const previousFilename = filenames.get(identity.filename);
    if (previousId !== undefined || previousFilename !== undefined) {
      fail(
        ctx,
        "ARCHIVE_COLLISION",
        `Entries '${previousId ?? previousFilename}' and '${entry.entryName}' derive the same asset id or filename.`,
        entry.entryName,
      );
    }
    ids.set(identity.id, entry.entryName);
    filenames.set(identity.filename, entry.entryName);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes);
    } catch {
      fail(ctx, "ARCHIVE_INVALID_UTF8", `Selected SVG '${entry.entryName}' is not valid UTF-8.`, entry.entryName);
    }
    assets.push({
      schemaVersion: 1,
      ...identity,
      svg: unwrap(parseSvg(text, entry.entryName)),
    });
  }
  assets.sort((left, right) => left.id.localeCompare(right.id, "en"));
  const project: NormalizedProject = {
    schemaVersion: 1,
    name: defaultProjectName(root),
    buildDirectory: "brand/dist" as ProjectRelativePath,
    installs: [],
    companions: [],
  };
  const files = new Map<string, string | Uint8Array>();
  const projectToml = serializeProjectToml(project);
  const reparsedProject = unwrap(parseProjectToml(projectToml, ".tfsb/project.toml"));
  if (!isDeepStrictEqual(reparsedProject, project)) throw new Error("Generated project TOML failed its invariant round-trip.");
  files.set(".tfsb/project.toml", projectToml);
  for (const asset of assets) {
    const relative = `.tfsb/assets/${asset.id}.toml`;
    const toml = serializeAssetToml(asset);
    const reparsed = unwrap(parseAssetToml(toml, relative));
    if (!isDeepStrictEqual(reparsed, asset)) throw new Error(`Generated asset TOML failed its invariant round-trip for '${asset.id}'.`);
    files.set(relative, toml);
  }
  for (const companion of archiveResult.companions) {
    const relative = `.tfsb/companions/${companion.filename}`;
    files.set(relative, companion.bytes);
  }
  return { root, archive: options.archive, project, assets, companions: archiveResult.companions, files };
}

async function durableWrite(path: string, contents: string | Uint8Array): Promise<void> {
  if (typeof contents === "string") {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } else {
    await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  }
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function executeImport(plan: ImportPlan): Promise<void> {
  const ctx = context(plan.archive);
  const target = join(plan.root, ".tfsb");
  try {
    await lstat(target);
    fail(ctx, "ROOT_ALREADY_INITIALIZED", "Import refuses an existing .tfsb directory.", ".tfsb");
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stage = join(plan.root, `.tfsb-stage-${randomUUID()}`);
  try {
    await mkdir(join(stage, "assets"), { recursive: true, mode: 0o700 });
    if (plan.companions.length > 0) {
      await mkdir(join(stage, "companions"), { recursive: true, mode: 0o700 });
    }
    for (const [relative, contents] of plan.files) {
      const inside = relative.replace(/^\.tfsb\//, "");
      const full = join(stage, inside);
      await mkdir(dirname(full), { recursive: true, mode: 0o700 });
      await durableWrite(full, contents);
    }
    await rename(stage, target);
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function importProject(options: ImportOptions): Promise<ImportPlan> {
  const plan = await planImport(options);
  if (!options.dryRun) await executeImport(plan);
  return plan;
}
