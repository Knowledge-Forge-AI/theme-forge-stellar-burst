#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { buildProject } from "./build.js";
import { bundleProject } from "./bundle.js";
import { checkProject } from "./check.js";
import { DiagnosticError } from "./diagnostics.js";
import { diffProject, type DiffBaseline, type DiffResult } from "./diff.js";
import { formatProject } from "./fmt.js";
import { importProject } from "./importer.js";
import { installProject } from "./install.js";
import { createJsonEnvelope, mapCheckJson, mapListJson, mapMachineDiagnostic, mapReconcileJson, serializeJsonEnvelope, type BundleJsonData, type JsonCommand, type JsonExitCode, type JsonStatus } from "./json.js";
import { listProject } from "./list.js";
import { previewProject } from "./preview.js";
import { reconcileProject } from "./reconcile.js";
import { findProjectRoot } from "./root.js";
import { TOOL_VERSION } from "./version.js";

export const HUMAN_DISPLAY_THRESHOLD = 50;
const JSON_COMMANDS = new Set<JsonCommand>(["check", "list", "reconcile", "diff", "bundle", "fmt", "preview"]);
const COMMANDS = ["import", "bundle", "reconcile", "build", "install", "check", "list", "diff", "fmt", "preview"] as const;

const USAGE = `Usage:
  tfsb import <archive> --root <project-root> [--manifest] [--select <entry> ...] [--companion <entry> ...] [--record-provenance] [--dry-run]
  tfsb bundle [--root <path>] --output <project-relative.zip> [--asset <asset-id> ...] [--companion <file> ...] [--force] [--dry-run] [--json]
  tfsb reconcile <archive> [--root <path>] [--dry-run | --apply] [--select <entry> ...] [--companion <entry> ...] [--resolve <key>=canonical|archive ...] [--rename <old-id>=<entry> ...] [--rename-companion <old-file>=<entry> ...] [--remove <asset-id> ...] [--remove-companion <file> ...] [--json]
  tfsb diff [--root <path>] [--provenance | --archive <archive> | --build | --install] [--json]
  tfsb fmt [--root <path>] [--check] [--json]
  tfsb preview [--root <path>] [--output <project-relative-directory>] [--open] [--json]
  tfsb build [--root <path>] [--dry-run]
  tfsb install [--root <path>] [--dry-run]
  tfsb check [--root <path>] [--json]
  tfsb list [--root <path>] [--json]

Options:
  -h, --help            Show this help and exit
  -v, --version         Show the package version and exit
  --root <path>         Use an explicit project root
  --json                Emit one versioned machine-result envelope
  --check               Check formatting without writing
  --provenance          Compare with paired provenance checkpoints (default diff)
  --archive <archive>   Compare with a safely validated archive
  --build               Compare with the discoverable v3 build receipt
  --install             Compare configured install destinations
  --output <path>       Bundle ZIP or preview directory (project-relative)
  --open                Best-effort open after preview publication
  --force               Authorize guarded replacement of output target
  --manifest            Import bundle verifying closed root tfsb-manifest.json
  --asset <id>          Select canonical asset id to bundle; repeatable
  --dry-run             Plan without writing (default for reconcile)
  --apply               Apply one complete reconciliation plan
  --record-provenance   Record aligned provenance during initial import
  --select <entry>      Select an exact archive SVG entry; repeatable
  --companion <entry>   Select an opaque companion document; repeatable`;

interface CliIo { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void; }
function strings(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function parseCommandArgs(args: readonly string[], command: string) {
  const allowsSelect = command === "import" || command === "reconcile";
  const allowsDryRun = ["import", "build", "install", "reconcile", "bundle"].includes(command);
  const json = JSON_COMMANDS.has(command as JsonCommand);
  const options = {
    root: { type: "string" as const },
    ...(json ? { json: { type: "boolean" as const } } : {}),
    ...(allowsSelect ? { select: { type: "string" as const, multiple: true }, companion: { type: "string" as const, multiple: true } } : {}),
    ...(allowsDryRun ? { "dry-run": { type: "boolean" as const } } : {}),
    ...(command === "import" ? { "record-provenance": { type: "boolean" as const }, manifest: { type: "boolean" as const } } : {}),
    ...(command === "bundle" ? { output: { type: "string" as const }, asset: { type: "string" as const, multiple: true }, companion: { type: "string" as const, multiple: true }, force: { type: "boolean" as const } } : {}),
    ...(command === "preview" ? { output: { type: "string" as const }, open: { type: "boolean" as const } } : {}),
    ...(command === "reconcile" ? { apply: { type: "boolean" as const }, resolve: { type: "string" as const, multiple: true }, rename: { type: "string" as const, multiple: true }, "rename-companion": { type: "string" as const, multiple: true }, remove: { type: "string" as const, multiple: true }, "remove-companion": { type: "string" as const, multiple: true } } : {}),
    ...(command === "diff" ? { provenance: { type: "boolean" as const }, archive: { type: "string" as const }, build: { type: "boolean" as const }, install: { type: "boolean" as const } } : {}),
    ...(command === "fmt" ? { check: { type: "boolean" as const } } : {}),
  };
  return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
}
function rootOption(values: Record<string, unknown>): string | undefined { return typeof values.root === "string" ? values.root : undefined; }
function displayProjectPath(root: string, path: string): string { return relative(root, path).split(sep).join("/"); }
function emitJson(io: CliIo, command: JsonCommand, status: JsonStatus, exitCode: JsonExitCode, summary: string, data: unknown, diagnostics = [] as readonly ReturnType<typeof mapMachineDiagnostic>[]): number { io.stdout(serializeJsonEnvelope(createJsonEnvelope(command, status, exitCode, summary, diagnostics, data))); return exitCode; }
function writeDrift(io: CliIo, layer: "build" | "install", groups: readonly { readonly name: string; readonly paths: readonly string[] }[]): void { if (groups.every((group) => group.paths.length === 0)) { io.stdout(`${layer}: clean\n`); return; } io.stdout(`${layer}: drift\n`); for (const group of groups) if (group.paths.length > 0) io.stdout(`  ${group.name}: ${group.paths.join(", ")}\n`); }
function displayBounded<T>(io: CliIo, values: readonly T[], render: (value: T) => string): void { const shown = values.slice(0, HUMAN_DISPLAY_THRESHOLD); for (const value of shown) io.stdout(render(value)); if (shown.length < values.length) io.stdout(`Summary: ${values.length} total, ${shown.length} displayed, ${values.length - shown.length} omitted; use --json for complete output.\n`); }
function diffHumanLines(result: DiffResult): readonly string[] { if (result.baseline === "provenance") return result.records.map((item) => `${item.key}: ${item.relation}\n`); if (result.baseline === "archive") return result.changes.map((item) => `${item.key}: ${item.category} ${item.changeType} at ${item.location}\n`); if (result.baseline === "build") return [...result.canonicalSources.map((item) => `source: ${item.changeType} ${item.path}\n`), ...result.outputs.map((item) => `output: ${item.changeType} ${item.path}\n`), ...result.policyChanges.map((item) => `policy: ${item.kind} ${item.changeType} ${item.key}${item.destination === undefined ? "" : ` -> ${item.destination}`}\n`)]; return result.destinations.filter((item) => item.state !== "clean").map((item) => `${item.key}: ${item.state} ${item.destination}\n`); }

export async function runCli(argv: readonly string[], cwd = process.cwd(), io: CliIo = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) }): Promise<number> {
  const [command, ...rest] = argv;
  if ((command === "--help" || command === "-h") && rest.length === 0) { io.stdout(`${USAGE}\n`); return 0; }
  if ((command === "--version" || command === "-v") && rest.length === 0) { io.stdout(`${TOOL_VERSION}\n`); return 0; }
  if (!command) { io.stderr(`USAGE_ERROR: Command required.\n${USAGE}\n`); return 1; }
  if (!(COMMANDS as readonly string[]).includes(command)) { io.stderr(`USAGE_ERROR: Unknown command '${command}'.\n${USAGE}\n`); return 1; }
  let jsonMode = false;
  try {
    let parsed: ReturnType<typeof parseCommandArgs>;
    try { parsed = parseCommandArgs(rest, command); } catch { io.stderr(`USAGE_ERROR: Invalid command arguments.\n${USAGE}\n`); return 1; }
    jsonMode = parsed.values.json === true;
    const rootValue = rootOption(parsed.values); const dryRun = parsed.values["dry-run"] === true;
    const usage = (message: string): number => jsonMode && JSON_COMMANDS.has(command as JsonCommand)
      ? emitJson(io, command as JsonCommand, "error", 1, "Invalid command arguments.", null, [{ code: "USAGE_ERROR", severity: "error", operation: command, domain: "cli", message }])
      : (io.stderr(`USAGE_ERROR: ${message}\n${USAGE}\n`), 1);
    if (command === "import") {
      if (parsed.positionals.length !== 1) return usage("import requires exactly one archive path.");
      const plan = await importProject({ archive: parsed.positionals[0] ?? "", ...(rootValue === undefined ? {} : { root: rootValue }), selections: strings(parsed.values.select), companions: strings(parsed.values.companion), dryRun, recordProvenance: parsed.values["record-provenance"] === true, manifest: parsed.values.manifest === true });
      io.stdout(`${dryRun ? "Import dry-run" : "Imported"}: ${plan.assets.length} asset(s)${plan.companions.length > 0 ? `, ${plan.companions.length} companion(s)` : ""}\n`); for (const name of plan.files.keys()) io.stdout(`  ${name}\n`); return 0;
    }
    if (command === "bundle") {
      if (parsed.positionals.length !== 0) return usage("bundle does not accept positional arguments.");
      const result = await bundleProject({ output: typeof parsed.values.output === "string" ? parsed.values.output : "", ...(rootValue === undefined ? {} : { root: rootValue }), ...(Array.isArray(parsed.values.asset) ? { assets: strings(parsed.values.asset) } : {}), ...(Array.isArray(parsed.values.companion) ? { companions: strings(parsed.values.companion) } : {}), force: parsed.values.force === true, dryRun });
      if (jsonMode) { const data: BundleJsonData = { output: result.projectRelativeOutputPath, dryRun, written: result.written, replaced: result.replaced, archiveBytes: result.totalBytes, assetCount: result.assetCount, companionCount: result.companionCount, entries: result.entries.map((entry) => ({ type: entry.type, name: entry.name, ...(entry.assetId === undefined ? {} : { assetId: entry.assetId }), size: entry.size, sha256: entry.sha256 })) }; return emitJson(io, "bundle", "ok", 0, dryRun ? "Bundle plan is valid." : "Bundle was written.", data); }
      const label = dryRun ? "Bundle dry-run" : result.replaced ? "Bundled (replaced existing)" : "Bundled"; io.stdout(`${label}: ${result.projectRelativeOutputPath} (${result.entries.length} entries: ${result.assetCount} asset(s), ${result.companionCount} companion(s), ${result.totalBytes} B total)\n`); displayBounded(io, result.entries, (entry) => `  ${entry.name} (${entry.size} B, sha256: ${entry.sha256})\n`); return 0;
    }
    if (command === "reconcile") {
      if (parsed.positionals.length !== 1) return usage("reconcile requires exactly one archive path.");
      const apply = parsed.values.apply === true; if (apply && dryRun) return usage("--dry-run and --apply conflict.");
      const result = await reconcileProject({ archive: parsed.positionals[0] ?? "", ...(rootValue === undefined ? {} : { root: rootValue }), selections: strings(parsed.values.select), companions: strings(parsed.values.companion), resolutions: strings(parsed.values.resolve), renames: strings(parsed.values.rename), companionRenames: strings(parsed.values["rename-companion"]), removals: strings(parsed.values.remove), companionRemovals: strings(parsed.values["remove-companion"]), apply });
      const exit: JsonExitCode = apply ? (result.blocked ? 2 : 0) : (result.pending ? 2 : 0); const status: JsonStatus = result.blocked ? "conflict" : exit === 2 ? "drift" : "ok";
      if (jsonMode) return emitJson(io, "reconcile", status, exit, result.applied ? "Reconciliation was applied." : result.blocked ? "Reconciliation has unresolved conflicts." : result.pending ? "Reconciliation has pending changes." : "Reconciliation is clean.", mapReconcileJson(result));
      displayBounded(io, result.records, (item) => `${item.key}: ${item.classification} - ${item.action}\n`); io.stdout(`Reconciliation status: ${result.records.length} active, ${result.records.filter((item) => item.blocker).length} blocker(s), mutation ${result.applied ? "applied" : "none"}\n`); return exit;
    }
    if (command === "preview") {
      if (parsed.positionals.length !== 0) return usage("preview does not accept positional arguments.");
      const result = await previewProject({ ...(rootValue === undefined ? {} : { root: rootValue }), ...(typeof parsed.values.output === "string" ? { output: parsed.values.output } : {}), open: parsed.values.open === true });
      if (jsonMode) return emitJson(io, "preview", "ok", 0, "Static preview was written.", result);
      io.stdout(`Preview: ${result.outputDirectory} (${result.assetCount} asset(s), ${result.companionCount} companion(s))\n`);
      io.stdout(`  ${result.files.index}\n  ${result.files.stylesheet}\n  ${result.files.marker}\n`);
      displayBounded(io, result.files.assets, (path) => `  ${path}\n`);
      if (result.opened.requested) io.stdout(`Open: ${result.opened.status}\n`);
      return 0;
    }
    if (parsed.positionals.length !== 0) return usage(`${command} does not accept positional arguments.`);
    if (command === "diff") {
      const selected: { baseline: DiffBaseline; archive?: string }[] = [];
      if (parsed.values.provenance === true) selected.push({ baseline: "provenance" });
      if (typeof parsed.values.archive === "string") selected.push({ baseline: "archive", archive: parsed.values.archive });
      if (parsed.values.build === true) selected.push({ baseline: "build" }); if (parsed.values.install === true) selected.push({ baseline: "install" });
      if (selected.length > 1) return usage("diff accepts exactly one baseline."); const choice = selected[0] ?? { baseline: "provenance" as const };
      const result = await diffProject({ ...(rootValue === undefined ? {} : { root: rootValue }), baseline: choice.baseline, ...(choice.archive === undefined ? {} : { archive: choice.archive }) }); const exit: JsonExitCode = result.different ? 2 : 0;
      if (jsonMode) return emitJson(io, "diff", result.different ? "drift" : "ok", exit, result.different ? `${result.baseline} baseline differs.` : `${result.baseline} baseline is equal.`, result);
      io.stdout(`diff ${result.baseline}: ${result.different ? "different" : "equal"}\n`); displayBounded(io, diffHumanLines(result), (line) => line); return exit;
    }
    if (command === "fmt") {
      const result = await formatProject({ ...(rootValue === undefined ? {} : { root: rootValue }), check: parsed.values.check === true }); const exit: JsonExitCode = result.check && result.changed ? 2 : 0;
      if (jsonMode) return emitJson(io, "fmt", exit === 2 ? "drift" : "ok", exit, result.changed ? result.check ? "Canonical TOML requires formatting." : "Canonical TOML was formatted." : "Canonical TOML is formatted.", result);
      io.stdout(result.changed ? result.check ? `Formatting required: ${result.paths.length} file(s)\n` : `Formatted: ${result.paths.length} file(s)\n` : "Formatting clean.\n"); for (const path of result.paths) io.stdout(`  ${path}\n`); return exit;
    }
    const root = await findProjectRoot(rootValue ?? cwd, command as "build" | "install" | "check" | "list", rootValue !== undefined);
    if (command === "build") { const plan = await buildProject(root, dryRun); io.stdout(`${dryRun ? "Build dry-run" : "Built"}: ${plan.outputs.length} SVG(s)\n`); for (const output of plan.outputs) io.stdout(`  ${plan.buildDirectory}/${output.filename}\n`); return 0; }
    if (command === "install") { const plan = await installProject(root, dryRun); io.stdout(`${dryRun ? "Install dry-run" : "Installed"}: ${plan.items.length} destination(s)\n`); for (const item of plan.items) io.stdout(`  ${item.assetId} -> ${item.configuredDestination}\n`); return 0; }
    if (command === "check") { const result = await checkProject(root); const exit: JsonExitCode = result.drift ? 2 : 0; if (jsonMode) return emitJson(io, "check", result.drift ? "drift" : "ok", exit, result.drift ? "Canonical, build, or install state has drift." : "Canonical, build, and install state are clean.", mapCheckJson(result, (path) => displayProjectPath(root, path))); io.stdout("canonical: valid\n"); io.stdout(`source: ${result.sourceChanged ? "changed" : "clean"}\n`); writeDrift(io, "build", [{ name: "missing", paths: result.build.missing }, { name: "extra", paths: result.build.extra }, { name: "different", paths: result.build.different }]); writeDrift(io, "install", [{ name: "missing", paths: result.install.missing.map((path) => displayProjectPath(root, path)) }, { name: "different", paths: result.install.different.map((path) => displayProjectPath(root, path)) }]); return exit; }
    const inventory = await listProject(root); if (jsonMode) return emitJson(io, "list", "ok", 0, "Project inventory loaded.", mapListJson(inventory));
    const lines = [...inventory.assets.map((item) => `${item.id}\n  build: ${item.buildPath}\n${item.destinations.length === 0 ? "  install: (none)\n" : item.destinations.map((destination) => `  install: ${destination}\n`).join("")}`), ...inventory.companions.map((item) => `companion: ${item.file}\n${item.destinations.length === 0 ? "  install: (none)\n" : item.destinations.map((destination) => `  install: ${destination}\n`).join("")}`)]; displayBounded(io, lines, (line) => line); return 0;
  } catch (error) {
    if (jsonMode && JSON_COMMANDS.has(command as JsonCommand)) { if (error instanceof DiagnosticError) return emitJson(io, command as JsonCommand, "error", 1, "The operation failed.", null, [mapMachineDiagnostic(error.diagnostic)]); return emitJson(io, command as JsonCommand, "error", 1, "Unexpected internal failure.", null, [{ code: "INTERNAL_ERROR", severity: "error", operation: command, domain: "cli", message: "Unexpected internal failure." }]); }
    if (error instanceof DiagnosticError) { io.stderr(`${error.diagnostic.code}: ${error.diagnostic.message}${error.diagnostic.location === undefined ? "" : ` (${error.diagnostic.location})`}\n`); return 1; }
    io.stderr("INTERNAL_ERROR: Unexpected internal failure.\n"); return 1;
  }
}

function isDirectExecution(): boolean { if (process.argv[1] === undefined) return false; try { const rawUrl = pathToFileURL(process.argv[1]).href; if (import.meta.url === rawUrl) return true; return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } }
if (isDirectExecution()) process.exitCode = await runCli(process.argv.slice(2));
