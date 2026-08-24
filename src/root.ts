import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { fail, type DiagnosticContext } from "./diagnostics.js";
import type { NormalizedProject, ProjectRelativePath } from "./types.js";

const PROTECTED_TREES = [".git", ".tfsb", ".tfsb-preview", "docs", "test", "src", "node_modules"] as const;

function context(operation: DiagnosticContext["operation"]): DiagnosticContext {
  return { operation, domain: "project" };
}

async function existingStat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function recoveryResidue(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.name.startsWith(".tfsb-stage-") || entry.name.startsWith(".tfsb-backup-"))
    .map((entry) => entry.name)
    .sort();
}

export async function resolveImportRoot(value: string | undefined): Promise<string> {
  const ctx = context("import");
  if (value === undefined) fail(ctx, "ROOT_REQUIRED", "Import requires --root <project-root>.");
  const candidate = resolve(value);
  const stat = await existingStat(candidate);
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail(ctx, "ROOT_INVALID", "Import root must be an existing non-symlink directory.", value);
  }
  const root = await realpath(candidate);
  if ((await existingStat(join(root, ".tfsb"))) !== undefined) {
    fail(ctx, "ROOT_ALREADY_INITIALIZED", "Import refuses an existing .tfsb directory.", ".tfsb");
  }
  return root;
}

export async function findProjectRoot(
  start: string | undefined,
  operation: DiagnosticContext["operation"],
  explicit = false,
): Promise<string> {
  const ctx = context(operation);
  let current = resolve(start ?? process.cwd());
  const stat = await existingStat(current);
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail(ctx, "ROOT_INVALID", "Project-root search must start at an existing non-symlink directory.");
  }
  current = await realpath(current);
  while (true) {
    const canonical = await existingStat(join(current, ".tfsb"));
    const marker = await existingStat(join(current, ".tfsb", "project.toml"));
    const residue = await recoveryResidue(current);
    if (marker === undefined && residue.length > 0) {
      fail(
        ctx,
        "TFSB_RECOVERY_REQUIRED",
        `Transaction residue requires manual inspection before project discovery: ${residue.join(", ")}.`,
        residue[0],
      );
    }
    if (
      canonical?.isDirectory() &&
      !canonical.isSymbolicLink() &&
      marker?.isFile() &&
      !marker.isSymbolicLink()
    ) {
      return current;
    }
    if (explicit) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fail(ctx, "ROOT_NOT_FOUND", "No .tfsb/project.toml project root was found.");
}

function containsPath(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function overlaps(first: string, second: string): boolean {
  return containsPath(first, second) || containsPath(second, first);
}

export function validateProjectPathLayout(
  project: Pick<NormalizedProject, "buildDirectory" | "installs" | "companions">,
): void {
  const ctx = context("validate");
  const build = project.buildDirectory;
  for (const protectedTree of PROTECTED_TREES) {
    if (overlaps(build, protectedTree)) {
      fail(
        ctx,
        "ROOT_UNSAFE_BUILD_DIRECTORY",
        `Build directory '${build}' overlaps protected tree '${protectedTree}'.`,
        "build.directory",
      );
    }
  }
  const allDestinations: ProjectRelativePath[] = [];
  for (const install of project.installs) {
    for (const destination of install.destinations) {
      if (overlaps(destination, ".tfsb") || overlaps(destination, ".tfsb-preview") || overlaps(destination, build)) {
        fail(
          ctx,
          "ROOT_PATH_OVERLAP",
          `Install destination '${destination}' overlaps canonical or build state.`,
          destination,
        );
      }
      allDestinations.push(destination);
    }
  }
  for (const companion of project.companions ?? []) {
    for (const destination of companion.destinations) {
      if (overlaps(destination, ".tfsb") || overlaps(destination, ".tfsb-preview") || overlaps(destination, build)) {
        fail(
          ctx,
          "ROOT_PATH_OVERLAP",
          `Companion destination '${destination}' overlaps canonical or build state.`,
          destination,
        );
      }
      allDestinations.push(destination);
    }
  }
  for (let index = 0; index < allDestinations.length; index += 1) {
    for (let other = index + 1; other < allDestinations.length; other += 1) {
      const first = allDestinations[index];
      const second = allDestinations[other];
      if (first !== undefined && second !== undefined && overlaps(first, second)) {
        fail(
          ctx,
          "ROOT_PATH_OVERLAP",
          `Install destinations '${first}' and '${second}' overlap.`,
          second,
        );
      }
    }
  }
}

export function validatePreviewOutputLayout(
  project: Pick<NormalizedProject, "buildDirectory" | "installs" | "companions">,
  output: string,
): void {
  const ctx = context("preview");
  for (const protectedTree of PROTECTED_TREES) {
    if (protectedTree === ".tfsb-preview" && output === ".tfsb-preview") continue;
    if (overlaps(output, protectedTree)) {
      fail(ctx, "PREVIEW_UNSAFE_OUTPUT", `Preview output '${output}' overlaps protected tree '${protectedTree}'.`, output);
    }
  }
  if (overlaps(output, project.buildDirectory)) {
    fail(ctx, "PREVIEW_UNSAFE_OUTPUT", `Preview output '${output}' overlaps the build directory.`, output);
  }
  for (const install of project.installs) {
    for (const destination of install.destinations) {
      if (overlaps(output, destination)) fail(ctx, "PREVIEW_UNSAFE_OUTPUT", `Preview output '${output}' overlaps an install destination.`, output);
    }
  }
  for (const companion of project.companions) {
    for (const destination of companion.destinations) {
      if (overlaps(output, destination)) fail(ctx, "PREVIEW_UNSAFE_OUTPUT", `Preview output '${output}' overlaps a companion destination.`, output);
    }
  }
}

export async function resolveConfinedPath(
  root: string,
  configured: ProjectRelativePath | string,
  operation: DiagnosticContext["operation"],
  options: { readonly allowFinalSymlink?: boolean } = {},
): Promise<string> {
  const ctx = context(operation);
  if (isAbsolute(configured) || configured.includes("\\") || configured.includes("\0")) {
    fail(ctx, "ROOT_PATH_ESCAPE", "Configured path is not a safe project-relative path.", configured);
  }
  const target = resolve(root, configured);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    fail(ctx, "ROOT_PATH_ESCAPE", `Configured path '${configured}' escapes or equals the project root.`, configured);
  }
  let cursor = root;
  const segments = configured.split("/");
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment);
    const stat = await existingStat(cursor);
    if (stat === undefined) continue;
    if (stat.isSymbolicLink() && !(options.allowFinalSymlink === true && index === segments.length - 1)) {
      fail(ctx, "ROOT_SYMLINK_ESCAPE", `Configured path '${configured}' traverses a symlink.`, configured);
    }
  }
  return target;
}

export function defaultProjectName(root: string): string {
  return basename(root) || "TFSB Project";
}
