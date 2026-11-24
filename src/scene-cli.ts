import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { assertRasterSvgIsSelfContained, decodeStrictPng, loadRasterCapability, RASTER_MAX_SVG_BYTES } from "./brand/raster-capability.js";
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
  type SceneReviseJsonData,
  type SceneRasterizeJsonData,
  type SceneValidateJsonData,
  type SceneTracePngJsonData,
  type SceneTraceWebpJsonData,
  type SceneWebpJsonData,
} from "./json.js";
import {
  parseSceneFileBytes,
  publishSceneBytes,
  publishSceneJson,
  publishSceneSvg,
  readSceneFile,
  readSceneFileBytes,
  readReviewedSceneSvgBytes,
} from "./scene-files.js";
import {
  compileScene,
  inspectScene,
  sceneImportSvg,
  traceRasterScene,
  validateScene,
  type SceneImportResult,
} from "./scene/index.js";
import { canonicalJsonStringify } from "./scene/canonical.js";
import { validateCanonicalSceneSvg } from "./scene/import-svg.js";
import { reviseScene } from "./scene/path-edits.js";
import { MAX_TRACE_SOURCE_PIXELS } from "./scene/trace-raster.js";

export const SCENE_USAGE = `Usage:
  tfsb scene validate <json> [--json]
  tfsb scene inspect <json> [--compact-paths] [--json]
  tfsb scene compile <json> --output <absent.svg> [--palette <json>] [--compact-paths] [--illustration-source] [--dry-run] [--json]
  tfsb scene rasterize <reviewed.svg> --svg-source --expect-svg-digest <sha256> --output <absent.png> [--compact-paths] [--viewbox-size] [--json]
  tfsb scene rasterize <json> --output <absent.png> [--palette <json>] [--compact-paths] [--expect-svg-digest <sha256>] [--json]
  tfsb scene export-webp <reviewed.svg> --expect-svg-digest <sha256> --output <absent.webp> [--output-width <pixels>] [--quality <0-100>] [--sharp-chroma] [--compact-paths] [--viewbox-size] [--json]
  tfsb scene revise <json> --edits <json> --output <absent-scene.json> [--expect-scene-digest <sha256>] [--dry-run] [--json]
  tfsb scene trace-png <png> --output <absent-scene.json> [--regular | --high-detail | --native-detail] [--preserve-alpha | --exclude-detail <json>] [--fit-source-colors] [--json]
  tfsb scene trace-webp <webp> --output <absent-scene.json> [--regular | --high-detail | --native-detail] [--preserve-alpha | --exclude-detail <json>] [--fit-source-colors] [--json]
  tfsb scene import-svg <reviewed.svg> --svg-source --expect-svg-digest <sha256> --output <absent-scene.json> [--compact-paths] [--json]
  tfsb scene import-svg <svg> --output <absent-scene.json> [--json]

Options:
  --output <file>       Publish destination for SVG, PNG, WebP or scene JSON (absent target only)
  --palette <file>      Override declared scene color tokens for this compilation
  --edits <file>        Apply path replacements by ID or append or remove one named group
  --regular             Use the smaller regular trace for ordinary display sizes
  --high-detail         Trace sharp edges at finer resolution (default)
  --native-detail       Prioritize fine artwork at the raster export size
  --fit-source-colors  Fit fills to source pixels on a matching opaque native grid
  --preserve-alpha      Trace transparency as editable paths with fill opacity
  --exclude-detail <file>  Omit native detail cells inside a convex source-pixel polygon
  --compact-paths       Remove optional SVG path spacing when compiling
  --illustration-source  Limit compiled SVG for illustration export to 16,000,000 bytes
  --svg-source          Use exact reviewed canonical SVG bytes for render or import
  --viewbox-size        Rasterize reviewed SVG at its whole-pixel viewBox size
  --output-width        Set WebP width in pixels without changing the artboard ratio
  --quality <0-100>     Set WebP encoder quality (default 94)
  --sharp-chroma       Use the versioned sharp WebP color conversion
  --expect-svg-digest <sha256>  Require the SVG digest to match before rendering or importing
  --expect-scene-digest <sha256>  Match the input JSON digest reported by scene inspect
  --dry-run             Validate and plan compilation or revision without writing output
  --json                Emit one versioned machine-result envelope`;

export interface SceneCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface ParsedSceneArgs {
  readonly action?: string | undefined;
  readonly positional?: string | undefined;
  readonly output?: string | undefined;
  readonly palette?: string | undefined;
  readonly edits?: string | undefined;
  readonly compactPaths?: boolean;
  readonly illustrationSource?: boolean;
  readonly svgSource?: boolean;
  readonly viewBoxSize?: boolean;
  readonly outputWidth?: number;
  readonly quality?: number;
  readonly sharpChroma?: boolean;
  readonly expectedSvgDigest?: string;
  readonly expectedSceneDigest?: string;
  readonly excludeDetail?: string;
  readonly preserveAlpha?: boolean;
  readonly fitSourceColors?: boolean;
  readonly traceMode?: "regular" | "high-detail" | "native-detail";
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
    action !== "rasterize" &&
    action !== "export-webp" &&
    action !== "revise" &&
    action !== "import-svg" &&
    action !== "trace-png" &&
    action !== "trace-webp"
  ) {
    return {
      dryRun: false,
      json,
      error: `Unknown scene action '${action}'. Expected validate, inspect, compile, rasterize, export-webp, revise, import-svg, trace-png, or trace-webp.`,
    };
  }
  const trace = action === "trace-png" || action === "trace-webp";

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
  let palette: string | undefined;
  let svgSource = false;
  let viewBoxSize = false;
  let outputWidth: number | undefined;
  let quality: number | undefined;
  let sharpChroma = false;
  let expectedSvgDigest: string | undefined;
  let expectedSceneDigest: string | undefined;
  let edits: string | undefined;
  let dryRun = false;
  let compactPaths = false;
  let illustrationSource = false;
  let excludeDetail: string | undefined;
  let preserveAlpha = false;
  let fitSourceColors = false;
  let traceMode: ParsedSceneArgs["traceMode"];
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
      if (action !== "compile" && action !== "revise") {
        return { action, dryRun, json, error: `--dry-run is not supported by scene ${action}.` };
      }
      if (dryRun) {
        return { action, dryRun, json, error: "--dry-run cannot be repeated." };
      }
      dryRun = true;
      i += 1;
      continue;
    }

    if (arg === "--illustration-source") {
      if (action !== "compile" || illustrationSource) {
        return { action, dryRun, json, error: "Use --illustration-source once with scene compile." };
      }
      illustrationSource = true;
      i += 1;
      continue;
    }

    if (arg === "--regular" || arg === "--high-detail" || arg === "--native-detail") {
      if (!trace || traceMode !== undefined) {
        return { action, dryRun, json, error: "Use one detail option with scene trace-png or trace-webp." };
      }
      traceMode = arg === "--regular" ? "regular" : arg === "--high-detail" ? "high-detail" : "native-detail";
      i += 1;
      continue;
    }

    if (arg === "--fit-source-colors") {
      if (!trace || fitSourceColors) {
        return { action, dryRun, json, error: "Use --fit-source-colors once with scene trace-png or trace-webp." };
      }
      fitSourceColors = true;
      i += 1;
      continue;
    }

    if (arg === "--preserve-alpha") {
      if (!trace || preserveAlpha) {
        return { action, dryRun, json, error: "Use --preserve-alpha once with scene trace-png or trace-webp." };
      }
      preserveAlpha = true;
      i += 1;
      continue;
    }

    if (arg === "--compact-paths") {
      if ((action !== "inspect" && action !== "compile" && action !== "rasterize"
          && action !== "import-svg" && action !== "export-webp") || compactPaths) {
        return { action, dryRun, json, error: "Use --compact-paths once with scene inspect, compile, rasterize, export-webp, or reviewed import." };
      }
      compactPaths = true;
      i += 1;
      continue;
    }

    if (arg === "--svg-source") {
      if ((action !== "rasterize" && action !== "import-svg") || svgSource) {
        return { action, dryRun, json, error: "Use --svg-source once with scene rasterize or import-svg." };
      }
      svgSource = true;
      i += 1;
      continue;
    }

    if (arg === "--viewbox-size") {
      if ((action !== "rasterize" && action !== "export-webp") || viewBoxSize) {
        return { action, dryRun, json, error: "Use --viewbox-size once with direct SVG rasterization." };
      }
      viewBoxSize = true;
      i += 1;
      continue;
    }

    if (arg === "--output-width") {
      const next = rest[i + 1];
      if (action !== "export-webp" || outputWidth !== undefined || next === undefined
          || !/^[1-9][0-9]*$/.test(next) || !Number.isSafeInteger(Number(next))) {
        return { action, dryRun, json, error: "Use --output-width <positive integer> once with scene export-webp." };
      }
      outputWidth = Number(next);
      i += 2;
      continue;
    }

    if (arg === "--sharp-chroma") {
      if (action !== "export-webp" || sharpChroma) {
        return { action, dryRun, json, error: "Use --sharp-chroma once with scene export-webp." };
      }
      sharpChroma = true;
      i += 1;
      continue;
    }
    if (arg === "--quality") {
      const next = rest[i + 1];
      if (action !== "export-webp" || quality !== undefined || next === undefined
          || !/^(0|[1-9][0-9]?|100)$/.test(next)) {
        return { action, dryRun, json, error: "Use --quality <integer from 0 to 100> once with scene export-webp." };
      }
      quality = Number(next);
      i += 2;
      continue;
    }

    if (arg === "--expect-svg-digest") {
      const next = rest[i + 1];
      if ((action !== "rasterize" && action !== "import-svg" && action !== "export-webp") || expectedSvgDigest !== undefined || next?.length !== 71 || !/^sha256:[0-9a-f]{64}$/.test(next)) {
        return { action, dryRun, json, error: "Use --expect-svg-digest <sha256:hex> once with scene rasterize, export-webp, or reviewed import." };
      }
      expectedSvgDigest = next;
      i += 2;
      continue;
    }

    if (arg === "--expect-scene-digest") {
      const next = rest[i + 1];
      if (action !== "revise" || expectedSceneDigest !== undefined || next?.length !== 71 || !/^sha256:[0-9a-f]{64}$/.test(next)) {
        return { action, dryRun, json, error: "Use --expect-scene-digest <sha256:hex> once with scene revise." };
      }
      expectedSceneDigest = next;
      i += 2;
      continue;
    }

    if (arg === "--palette") {
      const next = rest[i + 1];
      if ((action !== "compile" && action !== "rasterize") || palette !== undefined || !next || next.startsWith("-")) {
        return { action, dryRun, json, error: "Use --palette <json> once with scene compile or rasterize." };
      }
      palette = next;
      i += 2;
      continue;
    }

    if (arg === "--exclude-detail") {
      const next = rest[i + 1];
      if (!trace || excludeDetail !== undefined || !next || next.startsWith("-")) {
        return { action, dryRun, json, error: "Use --exclude-detail <json> once with scene trace-png or trace-webp." };
      }
      excludeDetail = next;
      i += 2;
      continue;
    }

    if (arg === "--edits") {
      const next = rest[i + 1];
      if (action !== "revise" || edits !== undefined || !next || next.startsWith("-")) {
        return { action, dryRun, json, error: "Use --edits <json> once with scene revise." };
      }
      edits = next;
      i += 2;
      continue;
    }

    if (arg === "--output") {
      if (action !== "compile" && action !== "rasterize" && action !== "export-webp" && action !== "import-svg" && action !== "revise" && !trace) {
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
      if (action !== "compile" && action !== "rasterize" && action !== "export-webp" && action !== "import-svg" && action !== "revise" && !trace) {
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

  if (positionals.length !== 1) {
    return {
      action,
      dryRun,
      json,
      error:
        action === "import-svg" || action === "export-webp"
          ? `scene ${action} requires exactly one input SVG file.`
          : action === "trace-png" ? "scene trace-png requires exactly one input PNG file."
          : action === "trace-webp" ? "scene trace-webp requires exactly one input WebP file."
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

  if (action === "rasterize" && output === undefined) {
    return { action, dryRun, json, error: "scene rasterize requires --output <absent.png>." };
  }

  if (action === "export-webp" && (output === undefined || expectedSvgDigest === undefined)) {
    return { action, dryRun, json, error: "scene export-webp requires --output <absent.webp> and --expect-svg-digest." };
  }

  if (action === "import-svg" && (output === undefined || output.length === 0)) {
    return {
      action,
      dryRun,
      json,
      error: "scene import-svg requires --output <absent-scene.json>.",
    };
  }

  if (trace && output === undefined) {
    return { action, dryRun, json, error: `scene ${action} requires --output <absent-scene.json>.` };
  }

  if (action === "revise" && (edits === undefined || output === undefined)) {
    return { action, dryRun, json, error: "scene revise requires --edits <json> and --output <absent-scene.json>." };
  }

  if (action === "import-svg" && !svgSource && (compactPaths || expectedSvgDigest !== undefined)) {
    return { action, dryRun, json, error: "Import requires --svg-source to use --compact-paths or --expect-svg-digest." };
  }

  if (svgSource && (expectedSvgDigest === undefined || palette !== undefined)) {
    return { action, dryRun, json, error: "--svg-source requires --expect-svg-digest and cannot be used with --palette." };
  }
  if (viewBoxSize && !svgSource && action !== "export-webp") {
    return { action, dryRun, json, error: "--viewbox-size requires --svg-source." };
  }

  if (fitSourceColors && (traceMode !== "native-detail" || preserveAlpha)) {
    return { action, dryRun, json, error: "--fit-source-colors requires --native-detail and an opaque raster." };
  }
  if (excludeDetail !== undefined && traceMode !== "native-detail") {
    return { action, dryRun, json, error: "--exclude-detail requires --native-detail." };
  }
  if (excludeDetail !== undefined && preserveAlpha) {
    return { action, dryRun, json, error: "--exclude-detail cannot be combined with --preserve-alpha." };
  }

  return {
    action,
    positional: positionals[0],
    output,
    palette,
    edits,
    compactPaths,
    illustrationSource,
    svgSource,
    viewBoxSize,
    ...(outputWidth === undefined ? {} : { outputWidth }),
    ...(quality === undefined ? {} : { quality }),
    ...(sharpChroma ? { sharpChroma } : {}),
    ...(expectedSvgDigest === undefined ? {} : { expectedSvgDigest }),
    ...(expectedSceneDigest === undefined ? {} : { expectedSceneDigest }),
    ...(excludeDetail === undefined ? {} : { excludeDetail }),
    ...(traceMode === undefined ? {} : { traceMode }),
    preserveAlpha,
    fitSourceColors,
    dryRun,
    json,
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withScenePalette(scene: unknown, palette: unknown): unknown {
  if (!isJsonRecord(scene) || !isJsonRecord(scene["tokenBindings"]) || !isJsonRecord(palette)) {
    throw new DiagnosticError(diagnostic(
      { operation: "build", domain: "scene" },
      "SCENE_INVALID_PALETTE",
      "A palette must be a JSON object and the scene must declare tokenBindings.",
    ));
  }
  const tokens = scene["tokenBindings"];
  for (const [name, color] of Object.entries(palette)) {
    if (!Object.hasOwn(tokens, name) || typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) {
      throw new DiagnosticError(diagnostic(
        { operation: "build", domain: "scene" },
        "SCENE_INVALID_PALETTE",
        "Palette entries must name existing scene tokens and use six-digit #RRGGBB colors.",
      ));
    }
  }
  return { ...scene, tokenBindings: { ...tokens, ...palette } };
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

  const { action, positional, output, palette, edits, compactPaths = false, illustrationSource, svgSource, viewBoxSize, outputWidth, quality, sharpChroma, expectedSvgDigest, expectedSceneDigest, traceMode, excludeDetail, preserveAlpha = false, fitSourceColors = false, dryRun, json: jsonMode } = parsed;

  const ctx = { operation: "build", domain: "scene" } as const;
  function assertExpectedSvg(svgDigest: string): void {
    if (expectedSvgDigest !== undefined && svgDigest !== expectedSvgDigest) {
      const code = action === "import-svg" ? "SCENE_IMPORT_SVG_DIGEST_MISMATCH" : "SCENE_RASTER_SVG_DIGEST_MISMATCH";
      throw new DiagnosticError(diagnostic(ctx, code, "The SVG does not match the expected digest."));
    }
  }

  async function renderSvgPng(svgBytes: Uint8Array, width: number, height: number) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width > 16_384 || height > 16_384
        || width * height > 16_777_216) {
      throw new DiagnosticError(diagnostic(ctx, "SCENE_RASTER_SIZE_INVALID", "Rasterization requires bounded whole-pixel artboard dimensions."));
    }
    const capability = await loadRasterCapability();
    if (!capability.available) {
      throw new DiagnosticError(diagnostic(ctx, capability.code, "Scene rasterization requires the qualified TFSB resvg companion."));
    }
    let pngBytes: Uint8Array;
    try {
      assertRasterSvgIsSelfContained(svgBytes);
      ({ pngBytes } = await capability.adapter.renderSvg({
        canonicalSvgBytes: svgBytes, width, height, backgroundRgba: null,
        alpha: "straight", fit: "contain-pad", colorSpace: "srgb",
      }));
    } catch {
      throw new DiagnosticError(diagnostic(ctx, "SCENE_RASTERIZE_FAILED", "The SVG could not be rasterized within the supported limits."));
    }
    return {
      pngBytes,
      pngDigest: `sha256:${createHash("sha256").update(pngBytes).digest("hex")}`,
      rendererBuildDigest: capability.adapter.descriptor.rendererBuildDigest,
    };
  }

  async function rasterizeSvg(svgBytes: Uint8Array, svgDigest: string, width: number, height: number): Promise<number> {
    const { pngBytes, pngDigest, rendererBuildDigest } = await renderSvgPng(svgBytes, width, height);
    const published = await publishSceneBytes(resolve(cwd, output!), pngBytes);
    const data: SceneRasterizeJsonData = {
      schema: "tfsb.scene-result-v1", action: "rasterize", valid: true, output: output!,
      written: published.published, cleanupResidue: published.cleanupResidue,
      width, height, svgDigest,
      pngDigest, rendererBuildDigest,
    };
    if (jsonMode) return emitJson(io, "ok", 0, "Scene PNG published.", [], data);
    io.stdout(`Rasterized scene: ${output} (${pngBytes.length} B)\n  SVG digest: ${data.svgDigest}\n  PNG digest: ${data.pngDigest}\n`);
    return 0;
  }

  try {
    const inputPath = resolve(cwd, positional!);
    if ((svgSource && action === "rasterize") || action === "export-webp") {
      const bytes = await readReviewedSceneSvgBytes(inputPath);
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      assertExpectedSvg(digest);
      const validation = validateCanonicalSceneSvg(bytes, compactPaths || undefined);
      if (validation.classification !== "SUPPORTED_IMPORT" || validation.scene === undefined) {
        throw new DiagnosticError(diagnostic(
          ctx, "SCENE_RASTER_SVG_REJECTED", "Direct rasterization requires exact canonical SVG emitted by this compiler.",
        ));
      }
      const { width, height, viewBox: [, , gridWidth, gridHeight] } = validation.scene.artboard;
      if (viewBoxSize && gridWidth * height !== gridHeight * width) {
        throw new DiagnosticError(diagnostic(
          ctx, "SCENE_RASTER_SIZE_INVALID", "The viewBox aspect ratio must match the artboard for grid-sized rasterization.",
        ));
      }
      const rasterWidth = viewBoxSize ? gridWidth : width;
      const rasterHeight = viewBoxSize ? gridHeight : height;
      if (action === "rasterize") return await rasterizeSvg(bytes, digest, rasterWidth, rasterHeight);
      const derivativeWidth = outputWidth ?? width;
      const derivativeHeight = outputWidth === undefined ? height : (height * outputWidth) / width;
      if (outputWidth !== undefined && (outputWidth > width || !Number.isSafeInteger(derivativeHeight))) {
        throw new DiagnosticError(diagnostic(
          ctx, "SCENE_WEBP_SIZE_INVALID", "The WebP width must fit the artboard and preserve its aspect ratio at a whole-pixel height.",
        ));
      }
      const { pngBytes, pngDigest, rendererBuildDigest } = await renderSvgPng(bytes, rasterWidth, rasterHeight);
      const { exportSceneWebp } = await import("./illustration/derivative-cli.js");
      const derivative = await exportSceneWebp(pngBytes, derivativeWidth, derivativeHeight, output!, cwd, quality, sharpChroma);
      if (!derivative.ok) {
        throw new DiagnosticError(diagnostic(ctx, `SCENE_WEBP_${derivative.code}`, "Scene WebP export refused."));
      }
      const result: SceneWebpJsonData = {
        schema: "tfsb.scene-result-v1", action, valid: true, output: output!, written: true,
        svgDigest: digest, pngDigest, rendererBuildDigest, rasterWidth, rasterHeight,
        recipe: derivative.recipe, receipt: derivative.receipt,
      };
      if (jsonMode) return emitJson(io, "ok", 0, "Scene WebP published.", [], result);
      io.stdout(`Exported WebP: ${output} (${result.receipt.byteLength} B)\n  SVG digest: ${digest}\n  WebP digest: ${result.receipt.outputSha256}\n`);
      return 0;
    }

    if (action === "import-svg") {
      const rawBytes = svgSource ? await readReviewedSceneSvgBytes(inputPath) : await readSceneFileBytes(inputPath);
      if (svgSource) assertExpectedSvg(`sha256:${createHash("sha256").update(rawBytes).digest("hex")}`);
      const result: SceneImportResult = svgSource
        ? validateCanonicalSceneSvg(rawBytes, compactPaths || undefined)
        : sceneImportSvg(rawBytes);

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

      if (!result.scene || (!svgSource && result.canonicalScene === undefined)) {
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

      // The reviewed projection already contains compact paths. Keep them
      // compact so dense sources remain within the editable JSON limits.
      const canonicalScene = result.canonicalScene ?? canonicalJsonStringify(validation.value.scene);
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

    if (action === "trace-png" || action === "trace-webp") {
      const bytes = await readSceneFileBytes(inputPath);
      const polygon = excludeDetail === undefined ? undefined : await readSceneFile(resolve(cwd, excludeDetail));
      const format = action === "trace-png" ? "PNG" : "WebP";
      const traceSource = action === "trace-png" ? "8-bit RGB or RGBA PNG" : "WebP";
      let decodedWebp;
      if (action === "trace-webp") {
        const { decodeWebpForTrace, RasterDerivativeError } = await import("./illustration/derivative.js");
        try {
          decodedWebp = await decodeWebpForTrace(bytes, MAX_TRACE_SOURCE_PIXELS);
        } catch (error) {
          if (!(error instanceof RasterDerivativeError)) throw error;
          throw new DiagnosticError(diagnostic(
            { operation: "import", domain: "scene" },
            `SCENE_TRACE_WEBP_${error.code}`,
            "The bounded static WebP could not be decoded for tracing.",
          ));
        }
      }
      let scene;
      let pixels: ReturnType<typeof decodeStrictPng> | undefined;
      try {
        pixels = decodeStrictPng(decodedWebp?.bytes ?? bytes);
        scene = traceRasterScene(pixels, {
          highDetail: traceMode !== "regular", nativeDetail: traceMode === "native-detail", excludeDetail: polygon, preserveAlpha, fitSourceColors,
        });
      } catch {
        const requiresAlphaOptIn = !preserveAlpha && !fitSourceColors && excludeDetail === undefined
          && pixels?.rgba8.some((channel, index) => index % 4 === 3 && channel !== 255);
        throw new DiagnosticError(diagnostic(
          { operation: "import", domain: "scene" },
          "SCENE_RASTER_TRACE_REJECTED",
          requiresAlphaOptIn
            ? `The ${format} contains transparent or translucent pixels; use --preserve-alpha to trace them.`
            : fitSourceColors
            ? "Source color fitting requires an opaque native trace at the source grid within scene limits."
            : excludeDetail !== undefined
              ? `Detail exclusion requires a bounded opaque ${format}, a matching native grid, and a valid polygon within trace limits.`
              : preserveAlpha
                  ? `Transparent trace requires a bounded ${traceSource} and contours within scene limits.`
                  : `Trace requires a bounded opaque ${traceSource} and contours within scene limits.`,
        ));
      }
      const validation = validateScene(scene);
      if (!validation.ok) throw new DiagnosticError(validation.diagnostics[0]!);
      const json = JSON.stringify(scene);
      const published = await publishSceneJson(resolve(cwd, output!), json, false);
      const common = {
        schema: "tfsb.scene-result-v1", valid: true, output: output!,
        written: published.published, cleanupResidue: published.cleanupResidue,
        sourceSha256: createHash("sha256").update(bytes).digest("hex"),
        outputSha256: createHash("sha256").update(json).digest("hex"),
        ...(fitSourceColors ? { colorFit: "source-pixel-median-v1" as const } : {}),
        metrics: validation.value.metrics,
      } as const;
      const data: SceneTracePngJsonData | SceneTraceWebpJsonData = decodedWebp === undefined
        ? { ...common, action: "trace-png" }
        : {
          ...common, action: "trace-webp",
          decodedPngSha256: decodedWebp.sha256,
          decodeRecipeDigest: decodedWebp.recipeDigest,
        };
      if (jsonMode) return emitJson(io, "ok", 0, `${format} traced into an editable scene.`, [], data);
      io.stdout(`Traced scene: ${output}\n`);
      return 0;
    }

    const inputBytes = await readSceneFileBytes(inputPath);
    if (expectedSceneDigest !== undefined
        && `sha256:${createHash("sha256").update(inputBytes).digest("hex")}` !== expectedSceneDigest) {
      throw new DiagnosticError(diagnostic(ctx, "SCENE_REVISION_DIGEST_MISMATCH", "The scene JSON does not match the expected digest."));
    }
    const raw = parseSceneFileBytes(inputBytes);

    if (action === "revise") {
      const result = reviseScene(raw, await readSceneFile(resolve(cwd, edits!)));
      if (!result.ok) {
        if (jsonMode) {
          return emitJson(io, "error", 1, "Scene revision failed.", result.diagnostics.map(mapMachineDiagnostic), null);
        }
        for (const diag of result.diagnostics) {
          io.stderr(`${diag.code}: ${diag.message}${diag.location === undefined ? "" : ` (${diag.location})`}\n`);
        }
        return 1;
      }
      const published = await publishSceneJson(resolve(cwd, output!), result.value, dryRun);
      const data: SceneReviseJsonData = {
        schema: "tfsb.scene-result-v1", action, valid: true, output: output!,
        dryRun: published.dryRun, written: published.published, cleanupResidue: published.cleanupResidue,
        outputSha256: createHash("sha256").update(result.value).digest("hex"),
      };
      const summary = dryRun ? "Scene revision planned." : "Scene revised.";
      if (jsonMode) return emitJson(io, "ok", 0, summary, [], data);
      io.stdout(`${summary} ${output}\n`);
      return 0;
    }

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
      const result = inspectScene(raw, { compactPaths });
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

      const inputSceneDigest = `sha256:${createHash("sha256").update(inputBytes).digest("hex")}`;
      if (jsonMode) {
        const data: SceneInspectJsonData = {
          schema: "tfsb.scene-result-v1",
          action: "inspect",
          valid: true,
          inputSceneDigest,
          svgBytes: result.value.svgBytes,
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
      io.stdout(`  input JSON digest: ${inputSceneDigest}\n`);
      io.stdout(`  svg digest: ${r.svgDigest}\n`);
      io.stdout(`  svg bytes: ${result.value.svgBytes}\n`);
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

    if (action === "compile" || action === "rasterize") {
      const sourceValidation = palette === undefined ? undefined : validateScene(raw);
      const result = sourceValidation?.ok === false
        ? sourceValidation
        : compileScene(palette === undefined
          ? raw
          : withScenePalette(raw, await readSceneFile(resolve(cwd, palette))), { compactPaths });
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
      if (action === "rasterize") {
        const { receipt, svg } = result.value;
        assertExpectedSvg(receipt.svgDigest);
        return await rasterizeSvg(Buffer.from(svg, "utf8"), receipt.svgDigest, receipt.artboard.width, receipt.artboard.height);
      }
      if (illustrationSource && Buffer.byteLength(result.value.svg, "utf8") > RASTER_MAX_SVG_BYTES) {
        throw new DiagnosticError(diagnostic(
          ctx,
          "SCENE_ILLUSTRATION_SVG_LIMIT",
          "Illustration SVG exceeds the 16,000,000-byte source limit.",
        ));
      }
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
