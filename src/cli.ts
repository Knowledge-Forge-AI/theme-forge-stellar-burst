#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { buildProject } from "./build.js";
import { checkProject } from "./check.js";
import { DiagnosticError } from "./diagnostics.js";
import { importProject } from "./importer.js";
import { installProject } from "./install.js";
import { listProject } from "./list.js";
import { findProjectRoot } from "./root.js";
import { TOOL_VERSION } from "./version.js";

const USAGE = `Usage:
  tfsb import <archive> --root <project-root> [--select <entry> ...] [--companion <entry> ...] [--dry-run]
  tfsb build [--root <path>] [--dry-run]
  tfsb install [--root <path>] [--dry-run]
  tfsb check [--root <path>]
  tfsb list [--root <path>]

Options:
  -h, --help            Show this help and exit
  -v, --version         Show the package version and exit
  --root <path>         Use an explicit project root
  --dry-run             Plan import, build, or install without writing
  --select <entry>      Select an exact archive SVG entry; repeatable for import
  --companion <entry>   Select an opaque companion document; repeatable for import`;

interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

function parseCommandArgs(
  args: readonly string[],
  command: string,
): { readonly values: Record<string, unknown>; readonly positionals: readonly string[] } {
  const allowsSelect = command === "import";
  const allowsDryRun = command === "import" || command === "build" || command === "install";
  const options = {
    root: { type: "string" as const },
    ...(allowsSelect
      ? {
          select: { type: "string" as const, multiple: true },
          companion: { type: "string" as const, multiple: true },
        }
      : {}),
    ...(allowsDryRun ? { "dry-run": { type: "boolean" as const } } : {}),
  };
  return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
}

function rootOption(values: Record<string, unknown>): string | undefined {
  return typeof values.root === "string" ? values.root : undefined;
}

function displayProjectPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function writeDrift(
  io: CliIo,
  layer: "build" | "install",
  groups: readonly { readonly name: string; readonly paths: readonly string[] }[],
): void {
  if (groups.every((group) => group.paths.length === 0)) {
    io.stdout(`${layer}: clean\n`);
    return;
  }
  io.stdout(`${layer}: drift\n`);
  for (const group of groups) {
    if (group.paths.length > 0) io.stdout(`  ${group.name}: ${group.paths.join(", ")}\n`);
  }
}

export async function runCli(
  argv: readonly string[],
  cwd = process.cwd(),
  io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  const [command, ...rest] = argv;
  if ((command === "--help" || command === "-h") && rest.length === 0) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if ((command === "--version" || command === "-v") && rest.length === 0) {
    io.stdout(`${TOOL_VERSION}\n`);
    return 0;
  }
  if (!command) {
    io.stderr(`USAGE_ERROR: Command required.\n${USAGE}\n`);
    return 1;
  }
  if (!["import", "build", "install", "check", "list"].includes(command)) {
    io.stderr(`USAGE_ERROR: Unknown command '${command}'.\n${USAGE}\n`);
    return 1;
  }
  try {
    let parsed: ReturnType<typeof parseCommandArgs>;
    try {
      parsed = parseCommandArgs(rest, command);
    } catch {
      io.stderr(`USAGE_ERROR: Invalid command arguments.\n${USAGE}\n`);
      return 1;
    }
    const rootValue = rootOption(parsed.values);
    const dryRun = parsed.values["dry-run"] === true;
    if (command === "import") {
      if (parsed.positionals.length !== 1) {
        io.stderr(`USAGE_ERROR: import requires exactly one archive path.\n${USAGE}\n`);
        return 1;
      }
      const plan = await importProject({
        archive: parsed.positionals[0] ?? "",
        ...(rootValue === undefined ? {} : { root: rootValue }),
        selections: Array.isArray(parsed.values.select)
          ? parsed.values.select.filter((value): value is string => typeof value === "string")
          : [],
        companions: Array.isArray(parsed.values.companion)
          ? parsed.values.companion.filter((value): value is string => typeof value === "string")
          : [],
        dryRun,
      });
      io.stdout(
        `${dryRun ? "Import dry-run" : "Imported"}: ${plan.assets.length} asset(s)${
          plan.companions.length > 0 ? `, ${plan.companions.length} companion(s)` : ""
        }\n`,
      );
      for (const name of plan.files.keys()) io.stdout(`  ${name}\n`);
      return 0;
    }
    if (parsed.positionals.length !== 0) {
      io.stderr(`USAGE_ERROR: ${command} does not accept positional arguments.\n${USAGE}\n`);
      return 1;
    }
    const root = await findProjectRoot(
      rootValue ?? cwd,
      command as "build" | "install" | "check" | "list",
      rootValue !== undefined,
    );
    if (command === "build") {
      const plan = await buildProject(root, dryRun);
      io.stdout(`${dryRun ? "Build dry-run" : "Built"}: ${plan.project.outputs.size} SVG(s)\n`);
      for (const name of plan.project.outputs.keys()) io.stdout(`  ${plan.project.project.buildDirectory}/${name}\n`);
      return 0;
    }
    if (command === "install") {
      const plan = await installProject(root, dryRun);
      io.stdout(`${dryRun ? "Install dry-run" : "Installed"}: ${plan.items.length} destination(s)\n`);
      for (const item of plan.items) io.stdout(`  ${item.assetId} -> ${item.configuredDestination}\n`);
      return 0;
    }
    if (command === "check") {
      const result = await checkProject(root);
      io.stdout("canonical: valid\n");
      io.stdout(`source: ${result.sourceChanged ? "changed" : "clean"}\n`);
      writeDrift(io, "build", [
        { name: "missing", paths: result.build.missing },
        { name: "extra", paths: result.build.extra },
        { name: "different", paths: result.build.different },
      ]);
      writeDrift(io, "install", [
        { name: "missing", paths: result.install.missing.map((path) => displayProjectPath(root, path)) },
        { name: "different", paths: result.install.different.map((path) => displayProjectPath(root, path)) },
      ]);
      return result.drift ? 2 : 0;
    }
    const inventory = await listProject(root);
    for (const item of inventory.assets) {
      io.stdout(`${item.id}\n  build: ${item.buildPath}\n`);
      if (item.destinations.length === 0) io.stdout("  install: (none)\n");
      else for (const destination of item.destinations) io.stdout(`  install: ${destination}\n`);
    }
    for (const item of inventory.companions) {
      io.stdout(`companion: ${item.file}\n`);
      if (item.destinations.length === 0) io.stdout("  install: (none)\n");
      else for (const destination of item.destinations) io.stdout(`  install: ${destination}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof DiagnosticError) {
      io.stderr(
        `${error.diagnostic.code}: ${error.diagnostic.message}${
          error.diagnostic.location === undefined ? "" : ` (${error.diagnostic.location})`
        }\n`,
      );
      return 1;
    }
    io.stderr("INTERNAL_ERROR: Unexpected internal failure.\n");
    return 1;
  }
}

function isDirectExecution(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    const rawUrl = pathToFileURL(process.argv[1]).href;
    if (import.meta.url === rawUrl) return true;
    const realUrl = pathToFileURL(realpathSync(process.argv[1])).href;
    return import.meta.url === realUrl;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
