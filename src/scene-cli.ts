import { resolve } from "node:path";

import { DiagnosticError, diagnostic, type Diagnostic } from "./diagnostics.js";
import {
  createJsonEnvelope,
  mapMachineDiagnostic,
  serializeJsonEnvelope,
  type JsonExitCode,
  type JsonStatus,
  type SceneCompileJsonData,
  type SceneImportSvgJsonData,
  type SceneInspectJsonData,
  type SceneJsonData,
  type SceneValidateJsonData,
} from "./json.js";
import {
  publishSceneJson,
  publishSceneSvg,
  readSceneFile,
  readSceneFileBytes,
} from "./scene-files.js";
import {
  compileScene,
  inspectScene,
  sceneImportSvg,
  validateScene,
  type SceneImportResult,
} from "./scene/index.js";

export const SCENE_USAGE = `Usage:
  tfsb scene validate <json> [--json]
  tfsb scene inspect <json> [--json]
  tfsb scene compile <json> --output <absent.svg> [--dry-run] [--json]
  tfsb scene import-svg <svg> --output <absent-scene.json> [--json]

Options:
  --output <file>       Publish destination for SVG or scene JSON (absent target only)
  --dry-run             Validate and plan compilation without writing SVG output
  --json                Emit one versioned machine-result envelope`;

export interface SceneCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface ParsedSceneArgs {
  readonly action?: string | undefined;
  readonly positional?: string | undefined;
  readonly output?: string | undefined;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly error?: string | undefined;
}

function parseSceneArgs(argv: readonly string[]): ParsedSceneArgs {
  const jsonCount = argv.filter((a) => a === "--json" || a.startsWith("--json=")).length;
  if (jsonCount > 1) {
    return { dryRun: false, json: true, error: "--json cannot be repeated." };
  }
  const json = jsonCount === 1;

  if (argv.length === 0) {
    return { dryRun: false, json, error: "scene requires validate, inspect, or compile." };
  }

  const [rawAction, ...rest] = argv;
  if (!rawAction || rawAction.startsWith("-")) {
    return { dryRun: false, json, error: "scene requires validate, inspect, or compile." };
  }

  const action = rawAction;
  if (
    action !== "validate" &&
    action !== "inspect" &&
    action !== "compile" &&
    action !== "import-svg"
  ) {
    return {
      dryRun: false,
      json,
      error: `Unknown scene action '${action}'. Expected validate, inspect, or compile.`,
    };
  }

  // Reject force flag explicitly
  if (rest.some((a) => a === "--force" || a === "-f" || a.startsWith("--force="))) {
    return {
      action,
      dryRun: false,
      json,
      error: `--force is not supported by scene ${action}.`,
    };
  }

  let output: string | undefined;
  let dryRun = false;
  const positionals: string[] = [];
  let i = 0;

  while (i < rest.length) {
    const arg = rest[i]!;

    if (arg === "--json") {
      i += 1;
      continue;
    }

    if (arg.startsWith("--json=")) {
      return { action, dryRun, json: true, error: "--json does not take a value." };
    }

    if (arg === "--dry-run") {
      if (action !== "compile") {
        return { action, dryRun, json, error: `--dry-run is not supported by scene ${action}.` };
      }
      if (dryRun) {
        return { action, dryRun, json, error: "--dry-run cannot be repeated." };
      }
      dryRun = true;
      i += 1;
      continue;
    }

    if (arg === "--output") {
      if (action !== "compile" && action !== "import-svg") {
        return { action, dryRun, json, error: `--output is not supported by scene ${action}.` };
      }
      if (output !== undefined) {
        return { action, dryRun, json, error: "--output cannot be repeated." };
      }
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return { action, dryRun, json, error: `scene ${action} requires a valid output file path.` };
      }
      output = next;
      i += 2;
      continue;
    }

    if (arg.startsWith("--output=")) {
      if (action !== "compile" && action !== "import-svg") {
        return { action, dryRun, json, error: `--output is not supported by scene ${action}.` };
      }
      if (output !== undefined) {
        return { action, dryRun, json, error: "--output cannot be repeated." };
      }
      const val = arg.slice("--output=".length);
      if (val.length === 0) {
        return { action, dryRun, json, error: `scene ${action} requires a valid output file path.` };
      }
      output = val;
      i += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      return { action, dryRun, json, error: `Unknown option '${arg}'.` };
    }

    positionals.push(arg);
    i += 1;
  }

  if (positionals.length === 0) {
    return {
      action,
      dryRun,
      json,
      error:
        action === "import-svg"
          ? "scene import-svg requires exactly one input SVG file."
          : `scene ${action} requires exactly one scene JSON file.`,
    };
  }

  if (positionals.length > 1) {
    return {
      action,
      dryRun,
      json,
      error:
        action === "import-svg"
          ? "scene import-svg requires exactly one input SVG file."
          : `scene ${action} requires exactly one scene JSON file.`,
    };
  }

  if (action === "compile" && (output === undefined || output.length === 0)) {
    return {
      action,
      dryRun,
      json,
      error: "scene compile requires --output <absent.svg>.",
    };
  }

  if (action === "import-svg" && (output === undefined || output.length === 0)) {
    return {
      action,
      dryRun,
      json,
      error: "scene import-svg requires --output <absent-scene.json>.",
    };
  }

  return {
    action,
    positional: positionals[0],
    output,
    dryRun,
    json,
  };
}

function emitJson<D>(
  io: SceneCliIo,
  status: JsonStatus,
  exitCode: JsonExitCode,
  summary: string,
  diagnostics: readonly ReturnType<typeof mapMachineDiagnostic>[],
  data: D | null,
): number {
  io.stdout(
    serializeJsonEnvelope(
      createJsonEnvelope("scene", status, exitCode, summary, diagnostics, data),
    ),
  );
  return exitCode;
}

export async function runSceneCli(
  argv: readonly string[],
  cwd = process.cwd(),
  io: SceneCliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  const parsed = parseSceneArgs(argv);

  const usage = (message: string): number => {
    if (parsed.json) {
      return emitJson(
        io,
        "error",
        1,
        "Invalid command arguments.",
        [
          {
            code: "USAGE_ERROR",
            severity: "error",
            operation: parsed.action ?? "validate",
            domain: "cli",
            message,
          },
        ],
        null,
      );
    }
    io.stderr(`USAGE_ERROR: ${message}\n${SCENE_USAGE}\n`);
    return 1;
  };

  if (parsed.error !== undefined) {
    return usage(parsed.error);
  }

  const { action, positional, output, dryRun, json: jsonMode } = parsed;

  try {
    const inputPath = resolve(cwd, positional!);

    if (action === "import-svg") {
      const rawBytes = await readSceneFileBytes(inputPath);
      const result: SceneImportResult = sceneImportSvg(rawBytes);

      if (result.classification !== "SUPPORTED_IMPORT") {
        const data: SceneImportSvgJsonData = {
          schema: "tfsb.scene-result-v1",
          action: "import-svg",
          valid: false,
          classification: result.classification,
          reasons: result.reasonCodes,
          reasonCodes: result.reasonCodes,
          sourceSha256: result.sourceSha256,
          normalizations: result.normalizations ?? [],
          written: false,
          output: output!,
        };

        const diagnostics = result.reasonCodes.map((code) => ({
          code,
          severity: "error" as const,
          operation: "import",
          domain: "scene",
          message: `SVG import denied (${result.classification}): ${code}.`,
        }));
        if (diagnostics.length === 0) {
          diagnostics.push({
            code: result.classification,
            severity: "error" as const,
            operation: "import",
            domain: "scene",
            message: `SVG import denied: ${result.classification}.`,
          });
        }

        if (jsonMode) {
          return emitJson(
            io,
            "error",
            1,
            `Scene SVG import rejected (${result.classification}).`,
            diagnostics,
            data,
          );
        }

        io.stderr(`IMPORT_REJECTED: ${result.classification}\n`);
        for (const code of result.reasonCodes) {
          io.stderr(`  ${code}\n`);
        }
        return 1;
      }

      if (!result.scene || result.canonicalScene === undefined) {
        throw new DiagnosticError(
          diagnostic(
            { operation: "import", domain: "scene" },
            "IMPORT_FAILED",
            "Importer reported SUPPORTED_IMPORT without its scene and canonical JSON.",
          ),
        );
      }

      const validation = validateScene(result.scene);
      if (!validation.ok) {
        if (jsonMode) {
          const data: SceneImportSvgJsonData = {
            schema: "tfsb.scene-result-v1",
            action: "import-svg",
            valid: false,
            classification: result.classification,
            reasons: result.reasonCodes,
            reasonCodes: result.reasonCodes,
            sourceSha256: result.sourceSha256,
            normalizations: result.normalizations ?? [],
            written: false,
            output: output!,
          };
          return emitJson(
            io,
            "error",
            1,
            "Imported scene validation failed.",
            validation.diagnostics.map(mapMachineDiagnostic),
            data,
          );
        }
        for (const diag of validation.diagnostics) {
          io.stderr(
            `${diag.code}: ${diag.message}${diag.location !== undefined ? ` (${diag.location})` : ""}\n`,
          );
        }
        return 1;
      }

      const canonicalScene = result.canonicalScene;
      const resolvedOutput = resolve(cwd, output!);
      const published = await publishSceneJson(
        resolvedOutput,
        canonicalScene,
        false,
        {},
      );

      if (jsonMode) {
        const data: SceneImportSvgJsonData = {
          schema: "tfsb.scene-result-v1",
          action: "import-svg",
          valid: true,
          classification: result.classification,
          reasons: result.reasonCodes,
          reasonCodes: result.reasonCodes,
          sourceSha256: result.sourceSha256,
          normalizations: result.normalizations ?? [],
          written: published.published,
          output: output!,
          metrics: validation.value.metrics,
        };
        return emitJson(io, "ok", 0, "Scene SVG imported.", [], data);
      }

      const jsonBytes = Buffer.byteLength(canonicalScene, "utf8");
      io.stdout(`Imported scene: ${output} (${jsonBytes} B)\n`);
      io.stdout(`  source sha256: ${result.sourceSha256}\n`);
      for (const normalization of result.normalizations ?? []) {
        io.stdout(`  normalization: ${normalization}\n`);
      }
      return 0;
    }

    const raw = await readSceneFile(inputPath);

    if (action === "validate") {
      const result = validateScene(raw);
      if (!result.ok) {
        if (jsonMode) {
          return emitJson(
            io,
            "error",
            1,
            "Scene validation failed.",
            result.diagnostics.map(mapMachineDiagnostic),
            null,
          );
        }
        for (const diag of result.diagnostics) {
          io.stderr(
            `${diag.code}: ${diag.message}${diag.location !== undefined ? ` (${diag.location})` : ""}\n`,
          );
        }
        return 1;
      }

      if (jsonMode) {
        const data: SceneValidateJsonData = {
          schema: "tfsb.scene-result-v1",
          action: "validate",
          valid: true,
          metrics: result.value.metrics,
          scene: result.value.scene,
        };
        return emitJson(io, "ok", 0, "Scene is valid.", [], data);
      }

      io.stdout(
        `valid scene ${result.value.scene.profile} (${result.value.metrics.expandedElementCount} elements, ${result.value.metrics.pathSegmentCount} path segments)\n`,
      );
      return 0;
    }

    if (action === "inspect") {
      const result = inspectScene(raw);
      if (!result.ok) {
        if (jsonMode) {
          return emitJson(
            io,
            "error",
            1,
            "Scene inspection failed.",
            result.diagnostics.map(mapMachineDiagnostic),
            null,
          );
        }
        for (const diag of result.diagnostics) {
          io.stderr(
            `${diag.code}: ${diag.message}${diag.location !== undefined ? ` (${diag.location})` : ""}\n`,
          );
        }
        return 1;
      }

      if (jsonMode) {
        const data: SceneInspectJsonData = {
          schema: "tfsb.scene-result-v1",
          action: "inspect",
          valid: true,
          metrics: result.value.metrics,
          receipt: result.value.receipt,
          warnings: result.value.warnings,
          scene: result.value.scene,
        };
        return emitJson(io, "ok", 0, "Scene inspection completed.", [], data);
      }

      const r = result.value.receipt;
      const m = result.value.metrics;
      io.stdout(`scene: ${r.profile} (${r.sceneSchema})\n`);
      io.stdout(`  source digest: ${r.sourceDigest}\n`);
      io.stdout(`  svg digest: ${r.svgDigest}\n`);
      io.stdout(
        `  artboard: ${r.artboard.width}x${r.artboard.height} [${r.artboard.viewBox.join(",")}]\n`,
      );
      io.stdout(
        `  metrics: ${m.authoredElementCount} authored, ${m.expandedElementCount} expanded, ${m.pathSegmentCount} path segments, ${m.glyphCount} glyphs\n`,
      );
      for (const warning of result.value.warnings) {
        io.stdout(`  warning: ${warning}\n`);
      }
      return 0;
    }

    if (action === "compile") {
      const result = compileScene(raw);
      if (!result.ok) {
        if (jsonMode) {
          return emitJson(
            io,
            "error",
            1,
            "Scene compilation failed.",
            result.diagnostics.map(mapMachineDiagnostic),
            null,
          );
        }
        for (const diag of result.diagnostics) {
          io.stderr(
            `${diag.code}: ${diag.message}${diag.location !== undefined ? ` (${diag.location})` : ""}\n`,
          );
        }
        return 1;
      }

      const resolvedOutput = resolve(cwd, output!);
      const published = await publishSceneSvg(resolvedOutput, result.value.svg, dryRun);

      if (jsonMode) {
        const data: SceneCompileJsonData = {
          schema: "tfsb.scene-result-v1",
          action: "compile",
          valid: true,
          output: output!,
          dryRun: published.dryRun,
          written: published.published,
          cleanupResidue: published.cleanupResidue,
          receipt: result.value.receipt,
          metrics: result.value.metrics,
        };
        return emitJson(
          io,
          "ok",
          0,
          dryRun ? "Scene compile plan is valid." : "Scene SVG published.",
          [],
          data,
        );
      }

      const label = dryRun ? "Compiled scene (dry-run)" : "Compiled scene";
      const svgBytes = Buffer.byteLength(result.value.svg, "utf8");
      io.stdout(`${label}: ${output} (${svgBytes} B)\n`);
      io.stdout(`  svg digest: ${result.value.receipt.svgDigest}\n`);
      return 0;
    }

    return usage("scene requires validate, inspect, or compile.");
  } catch (error: unknown) {
    if (error instanceof DiagnosticError) {
      if (jsonMode) {
        return emitJson(
          io,
          "error",
          1,
          "The operation failed.",
          [mapMachineDiagnostic(error.diagnostic)],
          null,
        );
      }
      io.stderr(
        `${error.diagnostic.code}: ${error.diagnostic.message}${error.diagnostic.location !== undefined ? ` (${error.diagnostic.location})` : ""}\n`,
      );
      return 1;
    }

    if (jsonMode) {
      return emitJson(
        io,
        "error",
        1,
        "Unexpected internal failure.",
        [
          {
            code: "INTERNAL_ERROR",
            severity: "error",
            operation: action ?? "validate",
            domain: "cli",
            message: "Unexpected internal failure.",
          },
        ],
        null,
      );
    }

    io.stderr("INTERNAL_ERROR: Unexpected internal failure.\n");
    return 1;
  }
}
