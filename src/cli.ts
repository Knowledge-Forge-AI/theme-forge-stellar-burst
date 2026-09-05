#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { buildProject } from "./build.js";
import { createAnalyzeEnvelope, executeCompleteAnalysis, renderAnalyzeHuman } from "./analyze.js";
import { planAnalyzeDetails, publishAnalyzeDetails } from "./analyze-details.js";
import { inspectAnalyzeInput } from "./analyze-source.js";
import { deriveBrandProject } from "./brand/derive.js";
import { bundleBrandProject } from "./brand/brand-bundle.js";
import { importBrandProject, inspectVerifiedBrandArchive } from "./brand/brand-import.js";
import { compareBrandSnapshots, createLoadedProjectBrandDiffSnapshot, projectBrandDiffHtml, projectBrandDiffMarkdown } from "./brand/brand-diff.js";
import { runLoadedBrandQaProfile } from "./brand/qa-semantic.js";
import { executeRasterExportPlan, planRasterExport } from "./brand/export-plan.js";
import { loadRasterCapability } from "./brand/raster-capability.js";
import { disposeConsumerPlan, inspectConsumerState, planConsumerAdoption, planConsumerInstall, planConsumerSync } from "./brand/consumer-plan.js";
import { executeConsumerAdoptionPlan, executeConsumerInstallPlan, executeConsumerSyncPlan } from "./brand/consumer-install.js";
import { projectBrandQaResultHtml, projectBrandQaResultMarkdown } from "./brand/qa-report.js";
import { bundleProject } from "./bundle.js";
import { checkProject } from "./check.js";
import { DiagnosticError } from "./diagnostics.js";
import { parseDesignEvidencePacket, summarizeDesignEvidencePacket } from "./design-evidence/index.js";
import { diffProject, type DiffBaseline, type DiffResult } from "./diff.js";
import { formatProject } from "./fmt.js";
import { readRegularFileSnapshot, sameFileIdentity } from "./filesystem.js";
import { importProject } from "./importer.js";
import { installProject } from "./install.js";
import { createJsonEnvelope, mapCheckJson, mapListJson, mapMachineDiagnostic, mapReconcileJson, serializeJsonEnvelope, type BundleJsonData, type DeriveJsonData, type ImportJsonData, type JsonCommand, type JsonExitCode, type JsonStatus, type ShardJsonData } from "./json.js";
import { listProject } from "./list.js";
import { loadCanonicalProject, verifyLoadedProjectSnapshot } from "./project.js";
import { migrateProject, type MigrationResult } from "./migration.js";
import { previewProject } from "./preview.js";
import { reconcileProject } from "./reconcile.js";
import { findProjectRoot } from "./root.js";
import { parseSourceMap } from "./source-map.js";
import { disposeShardManifestOutputPlan, planShard, planShardManifestOutput, publishShardManifest, type ShardManifestOutputPlan } from "./shard.js";
import type { Result } from "./types.js";
import { TOOL_VERSION } from "./version.js";
import { checkWorkspace } from "./workspace-check.js";
import { listWorkspace } from "./workspace-list.js";
import { previewWorkspace } from "./workspace-preview.js";

export const HUMAN_DISPLAY_THRESHOLD = 50;
const JSON_COMMANDS = new Set<JsonCommand>(["import", "check", "list", "reconcile", "diff", "bundle", "fmt", "preview", "analyze", "migrate", "shard", "derive", "qa", "consumer", "export"]);
const COMMANDS = ["import", "bundle", "reconcile", "build", "install", "check", "list", "diff", "fmt", "preview", "analyze", "migrate", "shard", "derive", "qa", "consumer", "export", "evidence"] as const;

const USAGE = `Usage:
  tfsb import <directory-or-archive> --root <project-root> [--brand-package] [--source-map <file> --collection <id> ...] [--shard-manifest <file> | --select <path> ...] [--schema 1|2] [--manifest] [--companion <path> ...] [--record-provenance] [--normalize exact-common] [--normalization-map <file>] [--dry-run] [--json]
  tfsb shard <directory> --source-map <file> --collection <id> --paths-file <utf8-lf-file> [--manifest-output <absent-file>] [--json]
  tfsb bundle [--root <path>] --output <project-relative.zip> [--brand-package] [--asset <asset-id> ...] [--companion <file> ...] [--force] [--dry-run] [--json]
  tfsb derive [--root <path>] (--all | --recipe <id> ...) [--dry-run] [--json]
  tfsb reconcile <directory-or-archive> [--root <path>] [--source-map <file> --collection <id> ...] [--shard-manifest <file>] [--dry-run | --apply] [--accept-source-map <sha256>] [--accept-source-kind-change archive=directory] [--accept-normalization-policy <sha256>] [--normalize exact-common] [--normalization-map <file>] [--select <entry> ...] [--companion <entry> ...] [--resolve <key>=source|canonical ...] [--rename <old-id>=<entry> ...] [--remove <asset-id> ...] [--json]
  tfsb diff [--root <path>] [--provenance | --archive <archive> | --brand-archive <verified-brand-bundle> | --build | --install] [--json | --report-format markdown|html]
  tfsb qa --profile <id> [--root <path>] [--json | --report-format markdown|html]
  tfsb export --profile <id> [--output <id> ...] [--root <path>] [--dry-run] [--json]
  tfsb fmt [--root <path>] [--check] [--json]
  tfsb preview [--root <path>] [--output <project-relative-directory>] [--open] [--json]
  tfsb preview --workspace <file> [--output <workspace-relative-directory>] [--json]
  tfsb build [--root <path>] [--dry-run]
  tfsb install [--root <path>] [--dry-run]
  tfsb check [--root <path>] [--json]
  tfsb check --workspace <file> [--json]
  tfsb list [--root <path>] [--json]
  tfsb list --workspace <file> [--page-size <1..128>] [--cursor <token>] [--json]
  tfsb analyze <directory-or-archive> [--json] [--details <output.ndjson>]
  tfsb migrate [--root <path>] [--check] [--json]
  tfsb consumer install --profile <package/profile> ... [--param <package/profile>:<parameter>=<value> ...] [--source-bundle <zip> ...] [--source-package <dir> ...] [--root <path>] [--dry-run] [--json]
  tfsb consumer sync [--profile <package/profile> ...] [--param ...] [--source-bundle <zip> ...] [--source-package <dir> ...] [--root <path>] [--dry-run] [--json]
  tfsb consumer check [--source-bundle <zip> ...] [--source-package <dir> ...] [--root <path>] [--json]
  tfsb consumer list [--root <path>] [--json]
  tfsb consumer adopt --profile <package/profile> ... [--param ...] [--source-bundle <zip> ...] [--source-package <dir> ...] [--root <path>] [--dry-run] [--json]
  tfsb evidence validate <packet> [--json]
  tfsb evidence inspect <packet> [--json]

Options:
  -h, --help            Show this help and exit
  -v, --version         Show the package version and exit
  --root <path>         Use an explicit project root
  --workspace <file>    Use the exact .tfsb-workspace.toml file
  --page-size <count>   Workspace list page size (default 64; maximum 128)
  --cursor <token>      Continue a workspace list from a closed cursor
  --json                Emit one versioned machine-result envelope
  --profile <id>        Select exactly one brand QA or raster-export profile
  --report-format <fmt> Emit a deterministic markdown or HTML projection
  --details <path>      Publish a transactional analyze details NDJSON report
  --check               Check formatting without writing
  --provenance          Compare with paired provenance checkpoints (default diff)
  --archive <archive>   Compare with a safely validated archive
  --brand-archive <zip> Compare a verified brand bundle with the current brand
  --build               Compare with the discoverable v3 build receipt
  --install             Compare configured install destinations
  --output <value>      Bundle/preview path, or repeatable raster output ID
  --open                Best-effort open after preview publication
  --force               Authorize guarded replacement of output target
  --manifest            Import bundle verifying closed root tfsb-manifest.json
  --brand-package       Bundle or import full brand package system
  --all                 Select all recipes in brand-recipes.toml for derivation
  --recipe <id>         Select specific recipe for derivation; repeatable
  --asset <id>          Select canonical asset id to bundle; repeatable
  --dry-run             Plan without writing (default for reconcile)
  --apply               Apply one complete reconciliation plan
  --record-provenance   Record aligned provenance during initial import
  --source-map <file>   Select directory source-map schema 1
  --shard-manifest <file>  Materialize reviewed shard evidence
  --paths-file <file>   Select exact collection-relative shard paths
  --manifest-output <file>  Publish a shard manifest to an absent file
  --collection <id>     Select a directory source-map collection; repeatable
  --schema <1|2>        Select schema for a new project (default: 2)
  --normalize <policy>  Authorize the exact-common normalization policy
  --normalization-map <file>  Supply explicit accessibility authority
  --select <entry>      Select an exact archive SVG entry; repeatable
  --companion <entry>   Select an opaque companion document; repeatable`;

interface CliIo { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void; }
function strings(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function parseCommandArgs(args: readonly string[], command: string) {
  const allowsSelect = command === "import" || command === "reconcile";
  const allowsDryRun = ["import", "build", "install", "reconcile", "bundle", "derive", "consumer", "export"].includes(command);
  const json = JSON_COMMANDS.has(command as JsonCommand);
  const options = {
    ...(command === "analyze" || command === "shard" ? {} : { root: { type: "string" as const } }),
    ...(json || command === "evidence" ? { json: { type: "boolean" as const } } : {}),
    workspace: { type: "string" as const },
    ...(allowsSelect ? { select: { type: "string" as const, multiple: true }, companion: { type: "string" as const, multiple: true } } : {}),
    ...(allowsDryRun ? { "dry-run": { type: "boolean" as const } } : {}),
    ...(command === "derive" ? { all: { type: "boolean" as const }, recipe: { type: "string" as const, multiple: true } } : {}),
    ...(command === "qa" ? { profile: { type: "string" as const }, "report-format": { type: "string" as const } } : {}),
    ...(command === "export" ? { profile: { type: "string" as const }, output: { type: "string" as const, multiple: true } } : {}),
    ...(command === "consumer" ? { profile: { type: "string" as const, multiple: true }, param: { type: "string" as const, multiple: true }, "source-bundle": { type: "string" as const, multiple: true }, "source-package": { type: "string" as const, multiple: true } } : {}),
    ...(command === "import" ? { "brand-package": { type: "boolean" as const }, "record-provenance": { type: "boolean" as const }, manifest: { type: "boolean" as const }, schema: { type: "string" as const }, normalize: { type: "string" as const }, "normalization-map": { type: "string" as const }, "source-map": { type: "string" as const }, collection: { type: "string" as const, multiple: true }, "shard-manifest": { type: "string" as const } } : {}),
    ...(command === "reconcile" ? { normalize: { type: "string" as const }, "normalization-map": { type: "string" as const }, "source-map": { type: "string" as const }, collection: { type: "string" as const, multiple: true }, "shard-manifest": { type: "string" as const }, "accept-source-map": { type: "string" as const }, "accept-source-kind-change": { type: "string" as const }, "accept-normalization-policy": { type: "string" as const } } : {}),
    ...(command === "bundle" ? { output: { type: "string" as const }, "brand-package": { type: "boolean" as const }, asset: { type: "string" as const, multiple: true }, companion: { type: "string" as const, multiple: true }, force: { type: "boolean" as const } } : {}),
    ...(command === "preview" ? { output: { type: "string" as const }, open: { type: "boolean" as const } } : {}),
    ...(command === "list" ? { "page-size": { type: "string" as const }, cursor: { type: "string" as const } } : {}),
    ...(command === "reconcile" ? { apply: { type: "boolean" as const }, resolve: { type: "string" as const, multiple: true }, rename: { type: "string" as const, multiple: true }, "rename-companion": { type: "string" as const, multiple: true }, remove: { type: "string" as const, multiple: true }, "remove-companion": { type: "string" as const, multiple: true } } : {}),
    ...(command === "diff" ? { provenance: { type: "boolean" as const }, archive: { type: "string" as const }, "brand-archive": { type: "string" as const }, build: { type: "boolean" as const }, install: { type: "boolean" as const }, "report-format": { type: "string" as const } } : {}),
    ...(command === "fmt" || command === "migrate" ? { check: { type: "boolean" as const } } : {}),
    ...(command === "analyze" ? { details: { type: "string" as const } } : {}),
    ...(command === "shard" ? { "source-map": { type: "string" as const }, collection: { type: "string" as const }, "paths-file": { type: "string" as const }, "manifest-output": { type: "string" as const } } : {}),
  };
  return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
}
function rootOption(values: Record<string, unknown>): string | undefined { return typeof values.root === "string" ? values.root : undefined; }
function displayProjectPath(root: string, path: string): string { return relative(root, path).split(sep).join("/"); }
function emitJson(io: CliIo, command: JsonCommand, status: JsonStatus, exitCode: JsonExitCode, summary: string, data: unknown, diagnostics = [] as readonly ReturnType<typeof mapMachineDiagnostic>[]): number { io.stdout(serializeJsonEnvelope(createJsonEnvelope(command, status, exitCode, summary, diagnostics, data))); return exitCode; }
function writeDrift(io: CliIo, layer: "build" | "install", groups: readonly { readonly name: string; readonly paths: readonly string[] }[]): void { if (groups.every((group) => group.paths.length === 0)) { io.stdout(`${layer}: clean\n`); return; } io.stdout(`${layer}: drift\n`); for (const group of groups) if (group.paths.length > 0) io.stdout(`  ${group.name}: ${group.paths.join(", ")}\n`); }
function displayBounded<T>(io: CliIo, values: readonly T[], render: (value: T) => string): void { const shown = values.slice(0, HUMAN_DISPLAY_THRESHOLD); for (const value of shown) io.stdout(render(value)); if (shown.length < values.length) io.stdout(`Summary: ${values.length} total, ${shown.length} displayed, ${values.length - shown.length} omitted; use --json for complete output.\n`); }
function diffHumanLines(result: DiffResult): readonly string[] { if (result.baseline === "provenance") return result.records.map((item) => `${item.key}: ${item.relation}\n`); if (result.baseline === "archive") return [...(result.sourceRelations ?? []).map((item) => `${item.key}: raw=${item.rawRelation} normalization=${item.normalizationRelation} semantic=${item.semanticComparison}\n`), ...result.changes.map((item) => `${item.key}: ${item.category} ${item.changeType} at ${item.location}\n`)]; if (result.baseline === "build") return [...result.canonicalSources.map((item) => `source: ${item.changeType} ${item.path}\n`), ...result.outputs.map((item) => `output: ${item.changeType} ${item.path}\n`), ...result.policyChanges.map((item) => `policy: ${item.kind} ${item.changeType} ${item.key}${item.destination === undefined ? "" : ` -> ${item.destination}`}\n`)]; return result.destinations.filter((item) => item.state !== "clean").map((item) => `${item.key}: ${item.state} ${item.destination}\n`); }
function migrationJsonData(result: MigrationResult): Omit<MigrationResult, "root"> { const { root: _root, ...data } = result; return data; }
function unwrapCli<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new DiagnosticError(result.diagnostics[0]!);
}

function consumerParameters(values: readonly string[]): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const result: Record<string, Record<string, string>> = {};
  for (const value of values) {
    const match = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*):([a-z][a-z0-9]*(?:-[a-z0-9]+)*)=([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(value);
    if (match === null) throw new DiagnosticError({ operation: "validate", domain: "cli", code: "USAGE_ERROR", message: "--param must be <package/profile>:<parameter>=<value>." });
    const [, profile, parameter, selected] = match;
    const map = result[profile!] ?? (result[profile!] = {});
    if (map[parameter!] !== undefined) throw new DiagnosticError({ operation: "validate", domain: "cli", code: "USAGE_ERROR", message: "A consumer parameter may be supplied only once." });
    map[parameter!] = selected!;
  }
  return result;
}

function shardPaths(bytes: Uint8Array): readonly string[] {
  let text: string;
  try { text = new TextDecoder("utf8", { fatal: true }).decode(bytes); }
  catch {
    throw new DiagnosticError({ operation: "discover", domain: "manifest", code: "SHARD_PATHS_INVALID_UTF8", message: "Shard paths file must be valid UTF-8." });
  }
  if (text.includes("\r") || !text.endsWith("\n")) {
    throw new DiagnosticError({ operation: "discover", domain: "manifest", code: "SHARD_PATHS_INVALID_FORMAT", message: "Shard paths file must use LF lines and a final LF." });
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line === "")) {
    throw new DiagnosticError({ operation: "discover", domain: "manifest", code: "SHARD_PATHS_INVALID_FORMAT", message: "Shard paths file does not allow blank lines." });
  }
  if (new Set(lines).size !== lines.length) {
    throw new DiagnosticError({ operation: "discover", domain: "manifest", code: "SHARD_DUPLICATE_SOURCE_PATH", message: "Shard paths file contains a duplicate path." });
  }
  return lines;
}

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
    if (command === "evidence") {
      if (parsed.positionals.length !== 2 || !["validate", "inspect"].includes(parsed.positionals[0]!)) return usage("evidence requires validate or inspect and one packet file.");
      if (rest.filter((item) => item === "--json" || item.startsWith("--json=")).length > 1) return usage("--json cannot be repeated.");
      try {
        const packetPath = resolve(cwd, parsed.positionals[1]!);
        const read = await readRegularFileSnapshot(packetPath, { operation: "validate", domain: "cli" }, "DESIGN_EVIDENCE_FILE_UNSAFE", "Design evidence input must be one stable regular non-symlink file.", 16_777_216);
        const packet = parseDesignEvidencePacket(read.bytes);
        const summary = summarizeDesignEvidencePacket(packet);
        if (jsonMode) io.stdout(`${JSON.stringify({ valid: true, ...summary }, null, 2)}\n`);
        else if (parsed.positionals[0] === "validate") io.stdout(`valid ${summary.kind} ${summary.packetDigest}\n`);
        else io.stdout(`${summary.kind} v${summary.schemaVersion} ${summary.packetDigest}\nbrief=${summary.briefDigest ?? "(packet)"} candidates=${summary.candidateCount} visuals=${summary.visualEvidenceCount} visualBytes=${summary.visualByteTotal} annotations=${summary.annotationCount} dispositions=${summary.dispositionCount} provenance=${summary.provenanceKinds.join(",") || "none"}${summary.proposalKind === undefined ? "" : ` proposal=${summary.proposalKind}`}\n`);
        return 0;
      } catch {
        if (jsonMode) io.stdout("{\n  \"valid\": false\n}\n"); else io.stderr("DESIGN_EVIDENCE_INVALID: Packet validation failed.\n");
        return 1;
      }
    }
    const workspaceValue = typeof parsed.values.workspace === "string" ? parsed.values.workspace : undefined;
    if (rest.filter((item) => item === "--workspace" || item.startsWith("--workspace=")).length > 1) return usage("--workspace cannot be repeated.");
    if (workspaceValue !== undefined && command !== "list" && command !== "check" && command !== "preview") return usage(`--workspace is not supported by ${command}.`);
    if (workspaceValue !== undefined && rootValue !== undefined) return usage("--workspace and --root are mutually exclusive.");
    if (workspaceValue !== undefined && parsed.positionals.length !== 0) return usage(`${command} --workspace does not accept positional arguments.`);
    if (workspaceValue !== undefined && command === "preview" && parsed.values.open === true) return usage("--open is not supported by workspace preview.");
    if (workspaceValue !== undefined && command === "list") {
      for (const option of ["--workspace", "--page-size", "--cursor", "--json"]) if (rest.filter((item) => item === option || item.startsWith(`${option}=`)).length > 1) return usage(`${option} cannot be repeated.`);
      const rawPageSize = parsed.values["page-size"];
      if (rawPageSize !== undefined && (typeof rawPageSize !== "string" || !/^[0-9]+$/.test(rawPageSize))) return usage("--page-size must be an integer from 1 through 128.");
      const result = await listWorkspace({ workspaceFile: resolve(cwd, workspaceValue), ...(rawPageSize === undefined ? {} : { pageSize: Number(rawPageSize) }), ...(typeof parsed.values.cursor === "string" ? { cursor: parsed.values.cursor } : {}) });
      if (jsonMode) return emitJson(io, "list", "ok", 0, result.diagnostics.length === 0 ? "Workspace inventory page loaded." : "Workspace inventory page loaded with collision diagnostics.", result, result.diagnostics.map(mapMachineDiagnostic));
      io.stdout(`Workspace: ${result.workspace.name} (${result.workspace.id})\nManifest: ${result.workspace.digest}\nPage size: ${result.page.size}\nPage records: ${result.page.recordCount}\nProjects: ${result.workspace.projectCount}\nRecords: ${result.workspace.recordCount}\n`);
      for (const record of result.page.records) io.stdout(`${record.qualifiedIdentity}\n  ${record.kind === "asset" ? "build" : "canonical"}: ${record.path}\n  collections: ${record.collections.join(", ") || "(none)"}\n  destinations: ${record.destinations.join(", ") || "(none)"}\n`);
      for (const item of result.diagnostics) io.stdout(`Diagnostic: ${item.code}: ${item.message}\n`);
      if (result.page.nextCursor !== null) io.stdout(`Next cursor: ${result.page.nextCursor}\n`);
      return 0;
    }
    if (workspaceValue !== undefined && command === "check") {
      const result = await checkWorkspace({ workspaceFile: resolve(cwd, workspaceValue) });
      const exit: JsonExitCode = result.status === "ok" ? 0 : result.status === "drift" ? 2 : 1;
      if (jsonMode) return emitJson(io, "check", result.status, exit, result.status === "ok" ? "Workspace is clean." : result.status === "drift" ? "Workspace has drift." : "Workspace check failed.", result, result.diagnostics.map(mapMachineDiagnostic));
      io.stdout(`Workspace check: ${result.status}\nProjects: total=${result.projects.total} checked=${result.projects.checked} clean=${result.projects.clean} drifted=${result.projects.drifted} failed=${result.projects.failed}\nDrift: source=${result.drift.sourceChangedProjects} build-missing=${result.drift.buildMissing} build-extra=${result.drift.buildExtra} build-different=${result.drift.buildDifferent} install-missing=${result.drift.installMissing} install-different=${result.drift.installDifferent}\n`);
      for (const child of result.children) io.stdout(`  ${child.projectId} (${child.projectPath}): ${child.status}${child.diagnostic === undefined ? "" : ` ${child.diagnostic.code}`}\n`);
      return exit;
    }
    if (workspaceValue !== undefined && command === "preview") {
      const result = await previewWorkspace({ workspaceFile: resolve(cwd, workspaceValue), ...(typeof parsed.values.output === "string" ? { output: parsed.values.output } : {}) });
      if (jsonMode) return emitJson(io, "preview", "ok", 0, "Workspace preview was written.", result);
      io.stdout(`Workspace preview: ${result.outputDirectory} (${result.projectCount} project(s), ${result.assetCount} asset(s), ${result.pageCount} page(s))\n  index.html\n  styles.css\n  ${result.marker}\n`);
      return 0;
    }
    if (workspaceValue === undefined && command === "list" && (parsed.values["page-size"] !== undefined || parsed.values.cursor !== undefined)) return usage("--page-size and --cursor require --workspace.");
    if (command === "consumer") {
      if (workspaceValue !== undefined) return usage("consumer commands do not support --workspace.");
      if (parsed.positionals.length !== 1 || !["install", "sync", "check", "list", "adopt"].includes(parsed.positionals[0]!)) return usage("consumer requires exactly one of install, sync, check, list, or adopt.");
      const subcommand = parsed.positionals[0] as "install" | "sync" | "check" | "list" | "adopt";
      for (const option of ["--root", "--json", "--dry-run"]) if (rest.filter((item) => item === option || item.startsWith(`${option}=`)).length > 1) return usage(`${option} cannot be repeated.`);
      const profiles = strings(parsed.values.profile), params = strings(parsed.values.param), bundleValues = strings(parsed.values["source-bundle"]), packageValues = strings(parsed.values["source-package"]);
      const sourceBundles = bundleValues.map((value) => resolve(cwd, value)), sourcePackages = packageValues.map((value) => resolve(cwd, value));
      const sourceCount = sourceBundles.length + sourcePackages.length;
      if ((subcommand === "install" || subcommand === "adopt") && (sourceCount === 0 || profiles.length === 0)) return usage(`consumer ${subcommand} requires at least one source and --profile.`);
      if (subcommand === "sync" && sourceCount === 0) return usage("consumer sync requires at least one source.");
      if ((subcommand === "check" || subcommand === "list") && (profiles.length > 0 || params.length > 0 || dryRun)) return usage(`consumer ${subcommand} does not accept profile, parameter, or dry-run options.`);
      if (subcommand === "list" && sourceCount > 0) return usage("consumer list does not accept source options.");
      const root = await findProjectRoot(rootValue ?? cwd, subcommand === "check" || subcommand === "list" ? "check" : "install", rootValue !== undefined);
      if (subcommand === "check" || subcommand === "list") {
        const inspection = await inspectConsumerState({ root, ...(sourceBundles.length === 0 ? {} : { sourceBundles }), ...(sourcePackages.length === 0 ? {} : { sourcePackages }) });
        const status: JsonStatus = inspection.status === "ok" ? "ok" : inspection.status === "source-unavailable" ? "unavailable" : inspection.status === "collision" ? "conflict" : inspection.status === "invalid" ? "error" : "drift";
        if (jsonMode) return emitJson(io, "consumer", status, inspection.exitCode, `Consumer ${subcommand}: ${inspection.status}.`, { subcommand, ...inspection });
        io.stdout(`Consumer ${subcommand}: ${inspection.status}\n`);
        if (inspection.lockDigest !== undefined) io.stdout(`Lock: ${inspection.lockDigest}\nConsumer project: ${inspection.consumerProjectDigest}\n`);
        for (const pkg of inspection.packages) io.stdout(`Package: ${pkg.packageId}@${pkg.brandVersion} (${pkg.sourceKind})\n`);
        for (const mapping of inspection.mappings) io.stdout(`  ${mapping.kind}:${mapping.sourceId} -> ${mapping.destination} [${mapping.current}]\n`);
        for (const profile of inspection.localProfiles) io.stdout(`Local profile: ${profile}\n`);
        return inspection.exitCode;
      }
      let parameters: ReturnType<typeof consumerParameters>;
      try { parameters = consumerParameters(params); } catch (error) { if (error instanceof DiagnosticError && error.diagnostic.code === "USAGE_ERROR") return usage(error.message); throw error; }
      const options = { root, sourceBundles, sourcePackages, ...(profiles.length === 0 ? {} : { profiles }), ...(params.length === 0 ? {} : { parameters }), dryRun };
      const plan = subcommand === "install" ? await planConsumerInstall(options) : subcommand === "sync" ? await planConsumerSync(options) : await planConsumerAdoption(options);
      if (dryRun) {
        try {
          if (jsonMode) return emitJson(io, "consumer", "ok", 0, `Consumer ${subcommand} plan is valid.`, { subcommand, dryRun: true, ...plan });
          io.stdout(`Consumer ${subcommand} plan: ${plan.outputs.length} output(s), lock ${plan.lockDigest}\n`); return 0;
        } finally { await disposeConsumerPlan(plan); }
      }
      const applied = subcommand === "install" ? await executeConsumerInstallPlan(plan) : subcommand === "sync" ? await executeConsumerSyncPlan(plan) : await executeConsumerAdoptionPlan(plan);
      if (jsonMode) return emitJson(io, "consumer", "ok", 0, `Consumer ${subcommand} completed.`, { subcommand, dryRun: false, ...applied });
      io.stdout(`Consumer ${subcommand}: ${applied.writtenOutputs} output(s), lock ${applied.lockDigest}\n`); return 0;
    }
    if (command === "analyze") {
      if (parsed.positionals.length !== 1) return usage("analyze requires exactly one directory or ZIP path.");
      for (const option of ["--json", "--details"]) if (rest.filter((item) => item === option || item.startsWith(`${option}=`)).length > 1) return usage(`${option} cannot be repeated.`);
      const inputPlan = await inspectAnalyzeInput(parsed.positionals[0] ?? "", cwd);
      const result = await executeCompleteAnalysis(inputPlan);
      if (typeof parsed.values.details === "string") await publishAnalyzeDetails(await planAnalyzeDetails(inputPlan, parsed.values.details), result);
      if (jsonMode) { io.stdout(serializeJsonEnvelope(createAnalyzeEnvelope(result))); return result.exitCode; }
      io.stdout(renderAnalyzeHuman(result)); return result.exitCode;
    }
    if (command === "shard") {
      if (parsed.positionals.length !== 1) return usage("shard requires exactly one directory path.");
      if (typeof parsed.values["source-map"] !== "string" || typeof parsed.values.collection !== "string" || typeof parsed.values["paths-file"] !== "string") {
        return usage("shard requires --source-map, --collection, and --paths-file exactly once.");
      }
      for (const option of ["--source-map", "--collection", "--paths-file", "--manifest-output", "--json"]) {
        if (rest.filter((item) => item === option || item.startsWith(`${option}=`)).length > 1) return usage(`${option} cannot be repeated.`);
      }
      const sourceRoot = resolve(cwd, parsed.positionals[0] ?? "");
      const sourceStat = await lstat(sourceRoot);
      if (!sourceStat.isDirectory()) return usage("shard input must be a directory.");
      const sourceMapPath = resolve(cwd, parsed.values["source-map"]);
      const pathsPath = resolve(cwd, parsed.values["paths-file"]);
      const shardContext = { operation: "discover" as const, domain: "manifest" as const };
      const sourceMapRead = await readRegularFileSnapshot(sourceMapPath, shardContext, "SOURCE_MAP_UNSAFE", "Source map must be a stable regular non-symlink file.", 1024 * 1024);
      let sourceMapText: string;
      try { sourceMapText = new TextDecoder("utf8", { fatal: true }).decode(sourceMapRead.bytes); }
      catch { throw new DiagnosticError({ ...shardContext, code: "SOURCE_MAP_INVALID_UTF8", message: "Source map must be valid UTF-8." }); }
      const map = unwrapCli(parseSourceMap(sourceMapText, "source-map.toml"));
      const pathsRead = await readRegularFileSnapshot(pathsPath, shardContext, "SHARD_PATHS_UNSAFE", "Shard paths file must be a stable regular non-symlink file.", 1024 * 1024);
      const manifest = unwrapCli(await planShard(sourceRoot, map, parsed.values.collection, shardPaths(pathsRead.bytes)));
      for (const [path, expected] of [[sourceMapPath, sourceMapRead.snapshot], [pathsPath, pathsRead.snapshot]] as const) {
        const current = await readRegularFileSnapshot(path, shardContext, "SHARD_INPUT_CHANGED", "Shard planning authority changed during planning.", 1024 * 1024);
        if (!sameFileIdentity(expected, current.snapshot) || expected.sha256 !== current.snapshot.sha256) {
          throw new DiagnosticError({ ...shardContext, code: "SHARD_INPUT_CHANGED", message: "Shard planning authority changed during planning." });
        }
      }
      const manifestOutputRaw = parsed.values["manifest-output"];
      let output: ShardManifestOutputPlan | undefined;
      let manifestWritten = false;
      try {
        if (typeof manifestOutputRaw === "string") {
          output = await planShardManifestOutput(manifest, resolve(cwd, manifestOutputRaw), sourceRoot);
          await publishShardManifest(output);
          manifestWritten = true;
          output = undefined;
        }
      } finally {
        if (output !== undefined) {
          await disposeShardManifestOutputPlan(output).catch(() => undefined);
        }
      }
      if (jsonMode) {
        const data: ShardJsonData = {
          planOnly: !manifestWritten,
          manifestWritten,
          collectionId: manifest.collectionId,
          sourceMapDigest: manifest.sourceMapDigest,
          sourceSnapshotDigest: manifest.sourceSnapshotDigest,
          membershipDigest: manifest.membershipDigest,
          assetCount: manifest.assetCount,
          selectedBytes: manifest.selectedBytes,
          directlyImportable: manifest.directlyImportable,
          normalizationRequired: manifest.normalizationRequired,
          assets: manifest.assets,
        };
        return emitJson(io, "shard", "ok", 0, manifestWritten ? "Shard manifest was written." : "Shard plan is valid; no manifest was written.", data);
      }
      io.stdout(`${manifestWritten ? "Shard manifest written" : "Shard plan only"}: ${manifest.collectionId}; ${manifest.assetCount} asset(s), ${manifest.selectedBytes} B; membership ${manifest.membershipDigest}\n`);
      return 0;
    }
    if (command === "migrate") {
      if (parsed.positionals.length !== 0) return usage("migrate does not accept positional arguments.");
      const check = parsed.values.check === true;
      const result = await migrateProject({ ...(rootValue === undefined ? {} : { root: rootValue }), check });
      const exit: JsonExitCode = check && result.migrationNeeded ? 2 : 0;
      const status: JsonStatus = exit === 2 ? "drift" : "ok";
      const summary = result.migrationNeeded ? check ? "A valid schema-2 migration is available." : "Schema migration was applied." : "Project is already schema 2.";
      if (jsonMode) return emitJson(io, "migrate", status, exit, summary, migrationJsonData(result));
      io.stdout(`${result.migrationNeeded ? check ? "Migration required" : "Migrated" : "Migration not required"}: schema ${result.fromSchemaVersion} -> ${result.toSchemaVersion}; ${result.assetCount} asset(s), ${result.companionCount} companion(s), ${result.svgEquivalentCount} SVG-equivalent.\n`);
      displayBounded(io, result.files, (file) => `  ${file.path}: ${file.beforeBasis} -> ${file.afterBasis}; ${file.svgOutputDigest}\n`);
      return exit;
    }
    if (command === "import") {
      if (parsed.positionals.length !== 1) return usage("import requires exactly one directory or archive path.");
      const input = resolve(cwd, parsed.positionals[0] ?? "");
      const inputStat = await lstat(input);
      const inputKind = inputStat.isDirectory() ? "directory" as const : "archive" as const;

      if (parsed.values["brand-package"] === true) {
        if (inputKind !== "archive") return usage("--brand-package is only supported for archive import.");
        if (parsed.values.manifest !== true) return usage("Brand package import requires --manifest.");
        const plan = await importBrandProject({
          archive: input,
          root: rootValue ?? cwd,
          dryRun,
        });
        if (jsonMode) {
          const data: ImportJsonData = {
            input: { kind: "archive" },
            schemaVersion: 2,
            assetCount: plan.assets.length,
            companionCount: plan.companions.length,
            brand: {
              packageId: plan.packageModel.packageId,
              name: plan.packageModel.name,
              brandVersion: plan.packageModel.brandVersion,
              brandPackageDigest: plan.brandManifest.brandPackageDigest,
              brandSystemDigest: plan.brandManifest.brandSystemDigest,
              brandManifestDigest: plan.brandManifest.brandManifestDigest,
            },
          };
          return emitJson(io, "import", "ok", 0, dryRun ? "Brand import plan is valid." : "Brand import completed.", data);
        }
        io.stdout(`${dryRun ? "Brand import dry-run" : "Brand imported"}: ${plan.packageModel.packageId} (v${plan.packageModel.brandVersion})\n`);
        io.stdout(`  name: ${plan.packageModel.name}\n`);
        io.stdout(`  brand manifest: ${plan.brandManifest.brandManifestDigest}\n`);
        io.stdout(`  assets: ${plan.assets.length}\n`);
        io.stdout(`  companions: ${plan.companions.length}\n`);
        for (const name of plan.files.keys()) io.stdout(`  ${name}\n`);
        return 0;
      }

      const rawSchema = parsed.values.schema;
      if (rawSchema !== undefined && rawSchema !== "1" && rawSchema !== "2") return usage("--schema must be 1 or 2.");
      if (parsed.values.normalize !== undefined && parsed.values.normalize !== "exact-common") return usage("--normalize must be exact-common.");
      if (typeof parsed.values["shard-manifest"] === "string" && strings(parsed.values.select).length > 0) return usage("--shard-manifest and --select are mutually exclusive.");
      if (inputKind === "directory" && rawSchema === "1") return usage("--schema 1 is not supported for directory import.");
      if (inputKind === "directory" && parsed.values.manifest === true) return usage("--manifest is not supported for directory import.");
      const plan = await importProject({ source: { kind: inputKind, path: input }, ...(rootValue === undefined ? {} : { root: rootValue }), ...(typeof parsed.values["source-map"] === "string" ? { sourceMap: resolve(cwd, parsed.values["source-map"]) } : {}), collections: strings(parsed.values.collection), selections: strings(parsed.values.select), companions: strings(parsed.values.companion), dryRun, recordProvenance: parsed.values["record-provenance"] === true, manifest: parsed.values.manifest === true, ...(typeof parsed.values["shard-manifest"] === "string" ? { shardManifest: resolve(cwd, parsed.values["shard-manifest"]) } : {}), ...(rawSchema === undefined ? {} : { schema: Number(rawSchema) as 1 | 2 }), ...(parsed.values.normalize === "exact-common" ? { normalize: "exact-common" as const } : {}), ...(typeof parsed.values["normalization-map"] === "string" ? { normalizationMap: resolve(cwd, parsed.values["normalization-map"]) } : {}) });
      if (jsonMode) {
        const data: ImportJsonData = { input: { kind: plan.sourceKind }, schemaVersion: plan.project.schemaVersion, assetCount: plan.assets.length, companionCount: plan.companions.length, ...(plan.provenanceSchemaVersion === undefined ? {} : { provenanceSchemaVersion: plan.provenanceSchemaVersion, sourceMapDigest: plan.sourceMapDigest!, snapshotDigest: plan.snapshotDigest!, collections: plan.collections! }), ...(plan.normalizationPolicy === undefined ? {} : { normalization: { policyDigest: plan.normalizationPolicy.policyDigest } }) };
        return emitJson(io, "import", "ok", 0, dryRun ? "Import plan is valid." : "Import completed.", data);
      }
      if (plan.sourceKind === "directory") {
        io.stdout(`${dryRun ? "Import dry-run" : "Imported"}\nInput: directory\nSource map: ${plan.sourceMapDescription} (${plan.sourceMapDigest})\nCollections: ${plan.collections?.join(", ")}\nSelected assets: ${plan.assets.length}\nCompanions: ${plan.companions.length}\nSchema: 2\nProvenance: schema 3\nNormalization: ${plan.normalizationPolicy === undefined ? "direct" : "exact-common"}\n`);
      } else {
        io.stdout(`${dryRun ? "Import dry-run" : "Imported"}: ${plan.assets.length} asset(s)${plan.companions.length > 0 ? `, ${plan.companions.length} companion(s)` : ""} (schema ${plan.project.schemaVersion})\n`);
      }
      for (const name of plan.files.keys()) io.stdout(`  ${name}\n`); if (plan.normalizationLedger !== undefined) displayBounded(io, plan.normalizationLedger.entries, (item) => `${item.source}: normalization=${item.disposition}; operations=${item.operations.join(",") || "none"}; policy=${item.policyDigest}\n`); return 0;
    }
    if (command === "bundle") {
      if (parsed.positionals.length !== 0) return usage("bundle does not accept positional arguments.");
      if (parsed.values["brand-package"] === true) {
        const result = await bundleBrandProject({
          output: typeof parsed.values.output === "string" ? parsed.values.output : "",
          root: rootValue ?? cwd,
          ...(Array.isArray(parsed.values.asset) ? { assets: strings(parsed.values.asset) } : {}),
          ...(Array.isArray(parsed.values.companion) ? { companions: strings(parsed.values.companion) } : {}),
          force: parsed.values.force === true,
          dryRun,
        });
        if (jsonMode) {
          const data: BundleJsonData = {
            output: result.projectRelativeOutputPath,
            dryRun,
            written: result.written,
            replaced: result.replaced,
            archiveBytes: result.totalBytes,
            assetCount: result.assetCount,
            companionCount: result.companionCount,
            domainCount: result.domainCount,
            packageId: result.packageId,
            brandVersion: result.brandVersion,
            genericManifestByteDigest: result.genericManifestByteDigest,
            brandPackageDigest: result.brandPackageDigest,
            brandSystemDigest: result.brandSystemDigest,
            brandManifestDigest: result.brandManifestDigest,
            entries: result.entries.map((entry) => ({
              type: entry.type,
              name: entry.name,
              ...(entry.assetId === undefined ? {} : { assetId: entry.assetId }),
              size: entry.size,
              sha256: entry.sha256,
            })),
          };
          return emitJson(io, "bundle", "ok", 0, dryRun ? "Brand bundle plan is valid." : "Brand bundle was written.", data);
        }
        const label = dryRun ? "Brand bundle dry-run" : result.replaced ? "Brand bundled (replaced existing)" : "Brand bundled";
        io.stdout(`${label}: ${result.projectRelativeOutputPath} (${result.entries.length} entries: ${result.assetCount} asset(s), ${result.companionCount} companion(s), ${result.domainCount} domain(s), ${result.totalBytes} B total)\n`);
        io.stdout(`  package: ${result.packageId} (v${result.brandVersion})\n`);
        io.stdout(`  brand manifest: ${result.brandManifestDigest}\n`);
        displayBounded(io, result.entries, (entry) => `  ${entry.name} (${entry.size} B, sha256: ${entry.sha256})\n`);
        return 0;
      }
      const result = await bundleProject({ output: typeof parsed.values.output === "string" ? parsed.values.output : "", ...(rootValue === undefined ? {} : { root: rootValue }), ...(Array.isArray(parsed.values.asset) ? { assets: strings(parsed.values.asset) } : {}), ...(Array.isArray(parsed.values.companion) ? { companions: strings(parsed.values.companion) } : {}), force: parsed.values.force === true, dryRun });
      if (jsonMode) { const data: BundleJsonData = { output: result.projectRelativeOutputPath, dryRun, written: result.written, replaced: result.replaced, archiveBytes: result.totalBytes, assetCount: result.assetCount, companionCount: result.companionCount, entries: result.entries.map((entry) => ({ type: entry.type, name: entry.name, ...(entry.assetId === undefined ? {} : { assetId: entry.assetId }), size: entry.size, sha256: entry.sha256 })) }; return emitJson(io, "bundle", "ok", 0, dryRun ? "Bundle plan is valid." : "Bundle was written.", data); }
      const label = dryRun ? "Bundle dry-run" : result.replaced ? "Bundled (replaced existing)" : "Bundled"; io.stdout(`${label}: ${result.projectRelativeOutputPath} (${result.entries.length} entries: ${result.assetCount} asset(s), ${result.companionCount} companion(s), ${result.totalBytes} B total)\n`); displayBounded(io, result.entries, (entry) => `  ${entry.name} (${entry.size} B, sha256: ${entry.sha256})\n`); return 0;
    }
    if (command === "reconcile") {
      if (parsed.positionals.length !== 1) return usage("reconcile requires exactly one directory or archive path.");
      const apply = parsed.values.apply === true; if (apply && dryRun) return usage("--dry-run and --apply conflict.");
      if (parsed.values.normalize !== undefined && parsed.values.normalize !== "exact-common") return usage("--normalize must be exact-common.");
      const input = resolve(cwd, parsed.positionals[0] ?? "");
      const inputKind = (await lstat(input)).isDirectory() ? "directory" as const : "archive" as const;
      const directoryOnlyPresent = parsed.values["source-map"] !== undefined
        || parsed.values["shard-manifest"] !== undefined
        || parsed.values["accept-source-map"] !== undefined
        || parsed.values["accept-source-kind-change"] !== undefined
        || parsed.values["accept-normalization-policy"] !== undefined
        || strings(parsed.values.collection).length > 0;
      if (inputKind === "archive" && directoryOnlyPresent) return usage("Directory reconcile authority flags cannot be used with archive reconcile.");
      if (inputKind === "directory" && strings(parsed.values.select).length > 0) return usage("Directory reconcile membership is selected by collections or --shard-manifest, not --select.");
      if (inputKind === "directory" && (strings(parsed.values["rename-companion"]).length > 0 || strings(parsed.values["remove-companion"]).length > 0)) return usage("Directory reconcile does not support companion rename/remove directives.");
      const result = inputKind === "directory"
        ? await reconcileProject({
          directory: input,
          ...(rootValue === undefined ? {} : { root: rootValue }),
          ...(typeof parsed.values["source-map"] === "string" ? { sourceMap: resolve(cwd, parsed.values["source-map"]) } : {}),
          collections: strings(parsed.values.collection),
          ...(typeof parsed.values["shard-manifest"] === "string" ? { shardManifest: resolve(cwd, parsed.values["shard-manifest"]) } : {}),
          companions: strings(parsed.values.companion),
          resolutions: strings(parsed.values.resolve),
          renames: strings(parsed.values.rename),
          removals: strings(parsed.values.remove),
          apply,
          ...(parsed.values.normalize === "exact-common" ? { normalize: "exact-common" as const } : {}),
          ...(typeof parsed.values["normalization-map"] === "string" ? { normalizationMap: resolve(cwd, parsed.values["normalization-map"]) } : {}),
          ...(typeof parsed.values["accept-source-map"] === "string" ? { acceptSourceMap: parsed.values["accept-source-map"] } : {}),
          ...(typeof parsed.values["accept-source-kind-change"] === "string" ? { acceptSourceKindChange: parsed.values["accept-source-kind-change"] } : {}),
          ...(typeof parsed.values["accept-normalization-policy"] === "string" ? { acceptNormalizationPolicy: parsed.values["accept-normalization-policy"] } : {}),
        })
        : await reconcileProject({ archive: parsed.positionals[0] ?? "", ...(rootValue === undefined ? {} : { root: rootValue }), selections: strings(parsed.values.select), companions: strings(parsed.values.companion), resolutions: strings(parsed.values.resolve), renames: strings(parsed.values.rename), companionRenames: strings(parsed.values["rename-companion"]), removals: strings(parsed.values.remove), companionRemovals: strings(parsed.values["remove-companion"]), apply, ...(parsed.values.normalize === "exact-common" ? { normalize: "exact-common" as const } : {}), ...(typeof parsed.values["normalization-map"] === "string" ? { normalizationMap: parsed.values["normalization-map"] } : {}) });
      const exit: JsonExitCode = apply ? (result.blocked ? 2 : 0) : (result.pending ? 2 : 0); const status: JsonStatus = result.blocked ? "conflict" : exit === 2 ? "drift" : "ok";
      if (jsonMode) return emitJson(io, "reconcile", status, exit, result.applied ? "Reconciliation was applied." : result.blocked ? "Reconciliation has unresolved conflicts." : result.pending ? "Reconciliation has pending changes." : "Reconciliation is clean.", mapReconcileJson(result));
      for (const item of result.records.slice(0, HUMAN_DISPLAY_THRESHOLD)) io.stdout(`${item.key}: ${item.classification} - ${item.action}\n`);
      if (result.records.length > HUMAN_DISPLAY_THRESHOLD) io.stdout(`Summary: ${result.records.length} total, ${HUMAN_DISPLAY_THRESHOLD} displayed, ${result.records.length - HUMAN_DISPLAY_THRESHOLD} omitted; use --json for complete output.\n`);
      if (result.normalizationLedger !== undefined) displayBounded(io, result.normalizationLedger.entries, (item) => `${item.source}: normalization=${item.disposition}; operations=${item.operations.join(",") || "none"}; policy=${item.policyDigest}\n`); io.stdout(`Reconciliation status: ${result.records.length} active, ${result.records.filter((item) => item.blocker).length} blocker(s), mutation ${result.applied ? "applied" : "none"}\n`); return exit;
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
    if (command === "qa") {
      const profileId = typeof parsed.values.profile === "string" ? parsed.values.profile : undefined;
      if (profileId === undefined) return usage("qa requires exactly one --profile <id>.");
      const reportFormat = typeof parsed.values["report-format"] === "string" ? parsed.values["report-format"] : undefined;
      if (jsonMode && reportFormat !== undefined) return usage("--json and --report-format are mutually exclusive.");
      if (reportFormat !== undefined && reportFormat !== "markdown" && reportFormat !== "html") return usage("--report-format must be markdown or html.");
      const qaRoot = await findProjectRoot(rootValue ?? cwd, "check", rootValue !== undefined);
      const project = await loadCanonicalProject(qaRoot, "check");
      const profile = project.brand?.qaModel?.profiles.find((entry) => entry.id === profileId);
      if (project.brand?.qaModel === undefined || profile === undefined) return usage(`Unknown or unavailable QA profile '${profileId}'.`);
      if (jsonMode && !profile.formats.includes("json")) return usage(`QA profile '${profileId}' does not permit JSON output.`);
      if (reportFormat !== undefined && !profile.formats.includes(reportFormat)) return usage(`QA profile '${profileId}' does not permit ${reportFormat} output.`);
      const rasterCapability = await loadRasterCapability();
      const result = await runLoadedBrandQaProfile(project, profileId, rasterCapability.available ? rasterCapability.qa : undefined);
      const exit = result.exitCode;
      if (jsonMode) return emitJson(io, "qa", exit === 0 ? "ok" : exit === 3 ? "unavailable" : exit === 2 ? "drift" : "error", exit, `Brand QA profile '${profileId}' ${result.status}.`, result);
      if (reportFormat === "markdown") io.stdout(projectBrandQaResultMarkdown(result));
      else if (reportFormat === "html") io.stdout(projectBrandQaResultHtml(result));
      else {
        io.stdout(`brand qa ${profileId}: ${result.status} (exit ${result.exitCode})\n`);
        io.stdout(`  cases: ${result.results.length}; evaluations: ${result.results.reduce((sum, entry) => sum + entry.evaluations.length, 0)}; pass: ${result.counts.pass}; fail: ${result.counts.fail}; unavailable: ${result.counts.unavailable}; error: ${result.counts.error}\n`);
        io.stdout(`  qa digest: ${result.qaDigest}\n  result digest: ${result.resultDigest}\n`);
      }
      return exit;
    }
    if (command === "export") {
      const profileId = typeof parsed.values.profile === "string" ? parsed.values.profile : undefined;
      if (profileId === undefined) return usage("export requires exactly one --profile <id>.");
      for (const option of ["--root", "--profile", "--dry-run", "--json"]) if (rest.filter((item) => item === option || item.startsWith(`${option}=`)).length > 1) return usage(`${option} cannot be repeated.`);
      const outputIds = strings(parsed.values.output);
      if (new Set(outputIds).size !== outputIds.length) return usage("--output IDs must be unique.");
      const exportRoot = await findProjectRoot(rootValue ?? cwd, "export", rootValue !== undefined);
      const plan = await planRasterExport(exportRoot, { profileId, ...(outputIds.length === 0 ? {} : { outputIds }) });
      const result = await executeRasterExportPlan(plan, { dryRun });
      const data = { plan, result };
      if (jsonMode) return emitJson(io, "export", "ok", 0, dryRun ? "Raster export plan is valid." : result.writtenOutputs === 0 ? "Raster exports are unchanged." : "Raster exports were written.", data);
      io.stdout(`${dryRun ? "Raster export dry-run" : result.writtenOutputs === 0 ? "Raster export clean" : "Raster exported"}: ${plan.counts.create} create, ${plan.counts.update} update, ${plan.counts.unchanged} unchanged\n`);
      for (const output of plan.outputs) io.stdout(`  ${output.profileId}/${output.outputId}: ${output.state} -> ${output.destination}\n`);
      return 0;
    }
    if (command === "diff") {
      const brandArchive = typeof parsed.values["brand-archive"] === "string" ? parsed.values["brand-archive"] : undefined;
      const reportFormat = typeof parsed.values["report-format"] === "string" ? parsed.values["report-format"] : undefined;
      if (jsonMode && reportFormat !== undefined) return usage("--json and --report-format are mutually exclusive.");
      if (reportFormat !== undefined && reportFormat !== "markdown" && reportFormat !== "html") return usage("--report-format must be markdown or html.");
      const selected: { baseline: DiffBaseline | "brand-archive"; archive?: string }[] = [];
      if (parsed.values.provenance === true) selected.push({ baseline: "provenance" });
      if (typeof parsed.values.archive === "string") selected.push({ baseline: "archive", archive: parsed.values.archive });
      if (brandArchive !== undefined) selected.push({ baseline: "brand-archive", archive: brandArchive });
      if (parsed.values.build === true) selected.push({ baseline: "build" }); if (parsed.values.install === true) selected.push({ baseline: "install" });
      if (selected.length > 1) return usage("diff accepts exactly one baseline."); const choice = selected[0] ?? { baseline: "provenance" as const };
      if (choice.baseline === "brand-archive") {
        const diffRoot = await findProjectRoot(rootValue ?? cwd, "diff", rootValue !== undefined);
        const current = await loadCanonicalProject(diffRoot, "diff");
        const before = await inspectVerifiedBrandArchive({ archive: choice.archive!, root: diffRoot });
        const after = createLoadedProjectBrandDiffSnapshot(current);
        const result = compareBrandSnapshots(before, after);
        await verifyLoadedProjectSnapshot(current, "diff");
        const exit: JsonExitCode = result.status === "changed" ? 2 : 0;
        if (jsonMode) return emitJson(io, "diff", exit === 2 ? "drift" : "ok", exit, `Brand archive is ${result.status}.`, result);
        if (reportFormat === "markdown") io.stdout(projectBrandDiffMarkdown(result));
        else if (reportFormat === "html") io.stdout(projectBrandDiffHtml(result));
        else {
          io.stdout(`diff brand-archive: ${result.status}\n`);
          io.stdout(`  before: ${result.beforeDigest}\n  after: ${result.afterDigest}\n  result: ${result.resultDigest}\n`);
          for (const section of ["inventory", "bindings", "tokens", "recipes", "derived", "geometry", "qaImpact", "packageAndLegal", "consumerProfiles", "exports"] as const) io.stdout(`  ${section}: ${JSON.stringify(result[section]).length} byte projection\n`);
        }
        return exit;
      }
      if (reportFormat !== undefined) return usage("--report-format is supported only with --brand-archive.");
      const result = await diffProject({ ...(rootValue === undefined ? {} : { root: rootValue }), baseline: choice.baseline, ...(choice.archive === undefined ? {} : { archive: choice.archive }) }); const exit: JsonExitCode = result.different ? 2 : 0;
      if (jsonMode) return emitJson(io, "diff", result.different ? "drift" : "ok", exit, result.different ? `${result.baseline} baseline differs.` : `${result.baseline} baseline is equal.`, result);
      io.stdout(`diff ${result.baseline}: ${result.different ? "different" : "equal"}\n`); displayBounded(io, diffHumanLines(result), (line) => line); return exit;
    }
    if (command === "derive") {
      if (parsed.positionals.length !== 0) return usage("derive does not accept positional arguments.");
      const all = parsed.values.all === true;
      const recipes = strings(parsed.values.recipe);
      if (!all && recipes.length === 0) return usage("derive requires either --all or --recipe <id>.");
      if (all && recipes.length > 0) return usage("--all and --recipe cannot be used together.");
      const result = await deriveBrandProject({
        root: rootValue ?? cwd,
        all,
        recipes,
        dryRun,
      });
      if (jsonMode) {
        const data: DeriveJsonData = {
          dryRun,
          written: result.written,
          createdCount: result.createdCount,
          updatedCount: result.updatedCount,
          unchangedCount: result.unchangedCount,
          tokenDigest: result.tokenDigest,
          recipeDigest: result.recipeDigest,
          selectedRecipes: result.selectedRecipes,
          transitiveRecipes: result.transitiveRecipes,
          affectedTargets: result.affectedTargets,
          targets: result.targetStates.map((st) => ({
            targetAssetId: st.targetAssetId,
            recipeId: st.recipeId,
            state: st.state,
            ...(st.oldDigest === undefined ? {} : { oldDigest: st.oldDigest }),
            newDigest: st.newDigest,
            newSvgDigest: st.newSvgDigest,
          })),
          warnings: result.warnings,
        };
        return emitJson(
          io,
          "derive",
          "ok",
          0,
          dryRun
            ? "Brand derivation plan is valid."
            : result.written
            ? "Brand derivation was applied."
            : "Brand derivation is clean.",
          data,
        );
      }
      const label = dryRun
        ? "Brand derivation dry-run"
        : result.written
        ? "Brand derived"
        : "Brand derivation clean";
      io.stdout(
        `${label}: ${result.createdCount} created, ${result.updatedCount} updated, ${result.unchangedCount} unchanged\n`,
      );
      for (const st of result.targetStates) {
        io.stdout(`  ${st.targetAssetId} (${st.recipeId}): ${st.state} -> ${st.newDigest}\n`);
      }
      for (const w of result.warnings) {
        io.stdout(`Warning: ${w}\n`);
      }
      return 0;
    }
    if (command === "fmt") {
      const result = await formatProject({ ...(rootValue === undefined ? {} : { root: rootValue }), check: parsed.values.check === true }); const exit: JsonExitCode = result.check && result.changed ? 2 : 0;
      if (jsonMode) return emitJson(io, "fmt", exit === 2 ? "drift" : "ok", exit, result.changed ? result.check ? "Canonical TOML requires formatting." : "Canonical TOML was formatted." : "Canonical TOML is formatted.", result);
      io.stdout(result.changed ? result.check ? `Formatting required: ${result.paths.length} file(s)\n` : `Formatted: ${result.paths.length} file(s)\n` : "Formatting clean.\n"); for (const path of result.paths) io.stdout(`  ${path}\n`); return exit;
    }
    const root = await findProjectRoot(rootValue ?? cwd, command as "build" | "install" | "check" | "list", rootValue !== undefined);
    if (command === "build") { const plan = await buildProject(root, dryRun); io.stdout(`${dryRun ? "Build dry-run" : "Built"}: ${plan.outputs.length} SVG(s)\n`); for (const output of plan.outputs) io.stdout(`  ${plan.buildDirectory}/${output.filename}\n`); return 0; }
    if (command === "install") { const plan = await installProject(root, dryRun); io.stdout(`${dryRun ? "Install dry-run" : "Installed"}: ${plan.items.length} destination(s)\n`); for (const item of plan.items) io.stdout(`  ${item.assetId} -> ${item.configuredDestination}\n`); return 0; }
    if (command === "check") {
      const result = await checkProject(root);
      const exit: JsonExitCode = result.drift ? 2 : 0;
      if (jsonMode) return emitJson(io, "check", result.drift ? "drift" : "ok", exit, result.drift ? "Canonical, build, or install state has drift." : "Canonical, build, and install state are clean.", mapCheckJson(result, (path) => displayProjectPath(root, path)));
      io.stdout("canonical: valid\n");
      io.stdout(`source: ${result.sourceChanged ? "changed" : "clean"}\n`);
      writeDrift(io, "build", [{ name: "missing", paths: result.build.missing }, { name: "extra", paths: result.build.extra }, { name: "different", paths: result.build.different }]);
      writeDrift(io, "install", [{ name: "missing", paths: result.install.missing.map((path) => displayProjectPath(root, path)) }, { name: "different", paths: result.install.different.map((path) => displayProjectPath(root, path)) }]);
      if (result.brand !== undefined) {
        io.stdout("brand: valid\n");
        io.stdout(`brand digest: ${result.brand.brandDigest}\n`);
        if (result.brand.brandSystemDigest !== undefined) {
          io.stdout(`brand system digest: ${result.brand.brandSystemDigest}\n`);
        }
        io.stdout(`brand completeness: ${result.brand.completenessSatisfied ? "satisfied" : "unsatisfied"}\n`);
        for (const d of result.brand.domains) {
          io.stdout(`brand domain: ${d.domain} (${d.state})\n`);
        }
        for (const f of result.brand.files) {
          io.stdout(`brand file: ${f.canonicalPath} (${f.present ? "present" : "absent"})\n`);
        }
        if (result.brand.qa !== undefined) {
          const qa = result.brand.qa;
          io.stdout(`brand qa: ${qa.profiles} profile(s), ${qa.cases} case(s), ${qa.semanticPass} semantic pass, ${qa.semanticFail} fail, ${qa.semanticError} error\n`);
          io.stdout(`brand qa visual: ${qa.visualCases} case(s), ${qa.capabilityRequired} required-capability profile(s)\n`);
          io.stdout(`brand qa baselines: ${qa.baselines.present} present, ${qa.baselines.missing} missing, ${qa.baselines.drift} drift\n`);
          io.stdout(`brand qa digest: ${qa.qaDigest}\n`);
        }
      }
      if (result.rasterExports !== undefined) {
        io.stdout(`raster capability: ${result.rasterExports.capability.available ? "available" : "unavailable"}\n`);
        for (const entry of result.rasterExports.entries) io.stdout(`raster export: ${entry.profileId}/${entry.outputId} (${entry.state}) -> ${entry.destination}\n`);
      }
      return exit;
    }
    const inventory = await listProject(root);
    if (jsonMode) return emitJson(io, "list", "ok", 0, "Project inventory loaded.", mapListJson(inventory));
    const lines = [
      ...inventory.assets.map((item) => `${item.id}\n  build: ${item.buildPath}\n${item.destinations.length === 0 ? "  install: (none)\n" : item.destinations.map((destination) => `  install: ${destination}\n`).join("")}`),
      ...inventory.companions.map((item) => `companion: ${item.file}\n${item.destinations.length === 0 ? "  install: (none)\n" : item.destinations.map((destination) => `  install: ${destination}\n`).join("")}`),
    ];
    if (inventory.brand !== undefined) {
      lines.push(`brand: schema ${inventory.brand.schemaVersion}; digest ${inventory.brand.brandDigest}\n`);
      if (inventory.brand.brandSystemDigest !== undefined) {
        lines.push(`brand-system: digest ${inventory.brand.brandSystemDigest}\n`);
      }
      for (const d of inventory.brand.domains) {
        lines.push(`domain: ${d.domain} (${d.state})\n`);
      }
      for (const f of inventory.brand.families) {
        lines.push(`family: ${f.id} (${f.name})\n`);
        if (f.requiredRoles.length > 0) lines.push(`  required: ${f.requiredRoles.join(", ")}\n`);
        if (f.optionalRoles.length > 0) lines.push(`  optional: ${f.optionalRoles.join(", ")}\n`);
      }
      for (const v of inventory.brand.variants) {
        lines.push(`variant: ${v.family}:${v.id} [${v.backgrounds.join(",")}] ${v.colorMode} ${v.scale} ${v.status}\n`);
      }
      for (const b of inventory.brand.bindings) {
        lines.push(`binding: ${b.family}:${b.role}:${b.variant} -> ${b.asset} (${b.authority})\n`);
      }
      lines.push(`completeness: ${inventory.brand.completeness.satisfied ? "satisfied" : "unsatisfied"} (${inventory.brand.completeness.familyCount} families, ${inventory.brand.completeness.variantCount} variants, ${inventory.brand.completeness.bindingCount} bindings, ${inventory.brand.completeness.requirementCount} requirements)\n`);
    }
    if (inventory.rasterExports !== undefined) {
      lines.push(`raster-capability: ${inventory.rasterExports.capability.available ? "available" : "unavailable"}\n`);
      for (const entry of inventory.rasterExports.entries) lines.push(`raster-export: ${entry.profileId}/${entry.outputId} (${entry.state}) -> ${entry.destination}\n`);
    }
    displayBounded(io, lines, (line) => line);
    return 0;
  } catch (error) {
const RASTER_CONFLICT_CODES = new Set(["RASTER_OUTPUT_DRIFT", "RASTER_OUTPUT_OWNED_BY_HUMAN", "RASTER_OUTPUT_MISSING", "RASTER_RECEIPT_INVALID", "RASTER_OWNERSHIP_CONFLICT"]);
    if (jsonMode && JSON_COMMANDS.has(command as JsonCommand)) { if (error instanceof DiagnosticError) { const exit: JsonExitCode = error.diagnostic.code === "EXPORT_CAPABILITY_UNAVAILABLE" ? 3 : RASTER_CONFLICT_CODES.has(error.diagnostic.code) ? 2 : 1; return emitJson(io, command as JsonCommand, exit === 3 ? "unavailable" : exit === 2 ? "conflict" : "error", exit, "The operation failed.", null, [mapMachineDiagnostic(error.diagnostic)]); } return emitJson(io, command as JsonCommand, "error", 1, "Unexpected internal failure.", null, [{ code: "INTERNAL_ERROR", severity: "error", operation: command, domain: "cli", message: "Unexpected internal failure." }]); }
    if (error instanceof DiagnosticError) { io.stderr(`${error.diagnostic.code}: ${error.diagnostic.message}${error.diagnostic.location === undefined ? "" : ` (${error.diagnostic.location})`}\n`); return error.diagnostic.code === "EXPORT_CAPABILITY_UNAVAILABLE" ? 3 : RASTER_CONFLICT_CODES.has(error.diagnostic.code) ? 2 : 1; }
    io.stderr("INTERNAL_ERROR: Unexpected internal failure.\n"); return 1;
  }
}

function isDirectExecution(): boolean { if (process.argv[1] === undefined) return false; try { const rawUrl = pathToFileURL(process.argv[1]).href; if (import.meta.url === rawUrl) return true; return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } }
if (isDirectExecution()) process.exitCode = await runCli(process.argv.slice(2));
