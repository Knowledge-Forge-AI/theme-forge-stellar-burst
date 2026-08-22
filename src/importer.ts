import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { readArchive, readManifestArchive, type ArchiveReadHooks, type SelectedArchiveCompanion } from "./archive.js";
import { computeAssetSemanticDigest, computeCompanionByteDigest, computeSha256 } from "./digests.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import { parseImportProvenance, serializeImportProvenance, unwrapProvenance, type ImportProvenanceV1 } from "./provenance.js";
import { defaultProjectName, resolveImportRoot } from "./root.js";
import { parseAssetToml, parseProjectToml } from "./toml.js";
import { serializeAssetToml, serializeProjectToml } from "./toml-writer.js";
import { parseSvg } from "./svg.js";
import {
  executeCanonicalTransaction,
  snapshotCanonicalTree,
  type CanonicalSnapshot,
  type TransactionHooks,
} from "./transaction.js";
import type {
  AssetId,
  NormalizedAsset,
  NormalizedProject,
  ProjectRelativePath,
  Result,
  SvgFilename,
} from "./types.js";
import { TOOL_VERSION } from "./version.js";

export interface ImportOptions {
  readonly archive: string;
  readonly root?: string;
  readonly selections?: readonly string[];
  readonly companions?: readonly string[];
  readonly dryRun?: boolean;
  readonly recordProvenance?: boolean;
  readonly manifest?: boolean;
}

export interface ImportPlan {
  readonly root: string;
  readonly archive: string;
  readonly project: NormalizedProject;
  readonly assets: readonly NormalizedAsset[];
  readonly companions: readonly SelectedArchiveCompanion[];
  readonly files: ReadonlyMap<string, string | Uint8Array>;
}

interface ProvenanceImportTransactionInternals {
  readonly canonicalSnapshot: CanonicalSnapshot;
  readonly archiveSnapshot: import("./archive.js").ArchiveSnapshot;
}

const provenanceImportInternals = new WeakMap<ImportPlan, ProvenanceImportTransactionInternals>();

interface ImportPlanningHooks {
  readonly afterRootValidation?: () => void | Promise<void>;
  readonly archiveHooks?: ArchiveReadHooks;
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

export function deriveAssetIdentity(entryName: string, ctx: DiagnosticContext): { id: AssetId; filename: SvgFilename } {
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

async function planImportInternal(options: ImportOptions, hooks: ImportPlanningHooks): Promise<ImportPlan> {
  const root = await resolveImportRoot(options.root);
  let canonicalSnapshot: CanonicalSnapshot | undefined;
  if (options.recordProvenance === true) {
    await hooks.afterRootValidation?.();
    canonicalSnapshot = await snapshotCanonicalTree(root, true, "import");
    if (canonicalSnapshot.canonicalPresent) {
      fail(context(), "ROOT_ALREADY_INITIALIZED", "Import refuses an existing .tfsb directory.", ".tfsb");
    }
  }
  const ctx = context(options.archive);

  if (options.manifest === true) {
    const archiveResult = await readManifestArchive(
      options.archive,
      options.selections ?? [],
      options.companions ?? [],
      hooks.archiveHooks === undefined ? {} : { hooks: hooks.archiveHooks },
    );
    const ids = new Map<string, string>();
    const filenames = new Map<string, string>();
    const assets: NormalizedAsset[] = [];
    for (const entry of archiveResult.svgs) {
      const id = entry.assetId;
      const filename = entry.entryName as SvgFilename;
      const previousId = ids.get(id);
      const previousFilename = filenames.get(filename);
      if (previousId !== undefined || previousFilename !== undefined) {
        fail(
          ctx,
          "ARCHIVE_COLLISION",
          `Entries '${previousId ?? previousFilename}' and '${entry.entryName}' derive the same asset id or filename.`,
          entry.entryName,
        );
      }
      ids.set(id, entry.entryName);
      filenames.set(filename, entry.entryName);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes);
      } catch {
        fail(ctx, "ARCHIVE_INVALID_UTF8", `Selected SVG '${entry.entryName}' is not valid UTF-8.`, entry.entryName);
      }
      assets.push({
        schemaVersion: 1,
        id,
        filename,
        svg: unwrap(parseSvg(text, entry.entryName)),
      });
    }
    assets.sort((left, right) => left.id.localeCompare(right.id, "en"));
    const project: NormalizedProject = {
      schemaVersion: 1,
      name: archiveResult.manifest.projectName ?? defaultProjectName(root),
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
    if (options.recordProvenance === true) {
      const records: ImportProvenanceV1["records"] = [
        ...assets.map((asset) => {
          const entry = archiveResult.svgs.find((candidate) => candidate.assetId === asset.id);
          if (entry === undefined) throw new Error("Archive and parsed asset identities diverged.");
          const modelDigest = computeAssetSemanticDigest(asset);
          return {
            type: "asset" as const,
            assetId: asset.id,
            canonicalPath: `.tfsb/assets/${asset.id}.toml`,
            archiveDigest: archiveResult.archiveDigest,
            entryName: entry.entryName,
            entryDigest: computeSha256(entry.bytes),
            digestBasis: "tfsb-asset-toml-v1" as const,
            archiveModelDigest: modelDigest,
            canonicalState: "present" as const,
            canonicalModelDigest: modelDigest,
            resolution: "aligned" as const,
            toolVersion: TOOL_VERSION,
          };
        }),
        ...archiveResult.companions.map((companion) => {
          const byteDigest = computeCompanionByteDigest(companion.bytes);
          return {
            type: "companion" as const,
            canonicalPath: `.tfsb/companions/${companion.filename}`,
            archiveDigest: archiveResult.archiveDigest,
            entryName: companion.entryName,
            entryDigest: byteDigest,
            archiveByteDigest: byteDigest,
            canonicalState: "present" as const,
            canonicalByteDigest: byteDigest,
            resolution: "aligned" as const,
            toolVersion: TOOL_VERSION,
          };
        }),
      ];
      const provenance = serializeImportProvenance({ kind: "tfsb-import-provenance", schemaVersion: 1, records });
      unwrapProvenance(parseImportProvenance(provenance, ".tfsb/provenance.json"));
      files.set(".tfsb/provenance.json", provenance);
    }
    const plan: ImportPlan = { root, archive: options.archive, project, assets, companions: archiveResult.companions, files };
    if (canonicalSnapshot !== undefined) {
      provenanceImportInternals.set(plan, { canonicalSnapshot, archiveSnapshot: archiveResult.snapshot });
    }
    return plan;
  }

  const archiveResult = await readArchive(
    options.archive,
    options.selections ?? [],
    options.companions ?? [],
    hooks.archiveHooks === undefined ? {} : { hooks: hooks.archiveHooks },
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
  if (options.recordProvenance === true) {
    const records: ImportProvenanceV1["records"] = [
      ...assets.map((asset) => {
        const entry = archiveResult.svgs.find((candidate) => deriveAssetIdentity(candidate.entryName, ctx).id === asset.id);
        if (entry === undefined) throw new Error("Archive and parsed asset identities diverged.");
        const modelDigest = computeAssetSemanticDigest(asset);
        return {
          type: "asset" as const,
          assetId: asset.id,
          canonicalPath: `.tfsb/assets/${asset.id}.toml`,
          archiveDigest: archiveResult.archiveDigest,
          entryName: entry.entryName,
          entryDigest: computeSha256(entry.bytes),
          digestBasis: "tfsb-asset-toml-v1" as const,
          archiveModelDigest: modelDigest,
          canonicalState: "present" as const,
          canonicalModelDigest: modelDigest,
          resolution: "aligned" as const,
          toolVersion: TOOL_VERSION,
        };
      }),
      ...archiveResult.companions.map((companion) => {
        const byteDigest = computeCompanionByteDigest(companion.bytes);
        return {
          type: "companion" as const,
          canonicalPath: `.tfsb/companions/${companion.filename}`,
          archiveDigest: archiveResult.archiveDigest,
          entryName: companion.entryName,
          entryDigest: byteDigest,
          archiveByteDigest: byteDigest,
          canonicalState: "present" as const,
          canonicalByteDigest: byteDigest,
          resolution: "aligned" as const,
          toolVersion: TOOL_VERSION,
        };
      }),
    ];
    const provenance = serializeImportProvenance({ kind: "tfsb-import-provenance", schemaVersion: 1, records });
    unwrapProvenance(parseImportProvenance(provenance, ".tfsb/provenance.json"));
    files.set(".tfsb/provenance.json", provenance);
  }
  const plan: ImportPlan = { root, archive: options.archive, project, assets, companions: archiveResult.companions, files };
  if (canonicalSnapshot !== undefined) {
    provenanceImportInternals.set(plan, { canonicalSnapshot, archiveSnapshot: archiveResult.snapshot });
  }
  return plan;
}

export async function planImport(options: ImportOptions): Promise<ImportPlan> {
  return planImportInternal(options, {});
}

/** Internal deterministic seam for concurrency tests; not re-exported by the package root. */
export async function planImportWithHooks(options: ImportOptions, hooks: ImportPlanningHooks): Promise<ImportPlan> {
  return planImportInternal(options, hooks);
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

export async function executeImport(plan: ImportPlan, hooks?: TransactionHooks): Promise<void> {
  const transaction = provenanceImportInternals.get(plan);
  if (transaction !== undefined) {
    await executeCanonicalTransaction({
      root: plan.root,
      nextFiles: new Map([...plan.files].map(([path, value]) => [path, typeof value === "string" ? Buffer.from(value, "utf8") : value])),
      expectedSnapshot: transaction.canonicalSnapshot,
      archiveSnapshot: transaction.archiveSnapshot,
      ...(hooks === undefined ? {} : { hooks }),
      operation: "import",
    });
    return;
  }
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
