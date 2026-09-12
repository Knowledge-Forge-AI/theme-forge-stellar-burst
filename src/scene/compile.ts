import {
  DiagnosticError,
  diagnostic,
  fail,
  type DiagnosticContext,
} from "../diagnostics.js";
import { computeSha256 } from "../digests.js";
import type { Result } from "./types.js";
import {
  canonicalJsonStringify,
  computeCanonicalDigest,
} from "./canonical.js";
import {
  SCENE_COMPATIBILITY,
  SCENE_COMPILER_LEVEL,
  SCENE_LIMITS,
  SCENE_SCHEMA,
} from "./constants.js";
import { emitSvg } from "./emit.js";
import {
  computeElementBounds,
  lowerConnectorToElements,
  type ElementBounds,
} from "./geometry.js";
import {
  FORGE_GRID_LABEL_V1_DIGEST,
} from "./glyphs/catalog.js";
import {
  computeLabelMetrics,
  lowerLabelToPath,
} from "./glyphs/labels.js";
import { lowerLayout } from "./layout.js";
import type {
  DiagramNodeElement,
  RectElement,
  SceneCompileOptions,
  SceneCompileResult,
  SceneInspectionResult,
  SceneReceipt,
  SceneElement,
  SymbolDef,
  VectorScene,
} from "./types.js";
import { countTextPathSegments, validateScene } from "./validate.js";
import { canonicalPathData } from "./path-canonical.js";

function canonicalScenePaths(scene: VectorScene): VectorScene {
  let bytes = 0;
  const visit = (items: readonly SceneElement[]): SceneElement[] => items.map((item) => {
    if (item.type === "group") return { ...item, children: visit(item.children) };
    if (item.type !== "path") return item;
    const d = canonicalPathData(item.d);
    bytes += d.length;
    if (bytes > 16_777_216) throw new RangeError("Canonical scene paths exceed 16 MiB.");
    return { ...item, d };
  });
  return { ...scene, elements: visit(scene.elements), ...(scene.definitions ? { definitions: { ...scene.definitions, ...(scene.definitions.symbols ? { symbols: scene.definitions.symbols.map((symbol) => ({ ...symbol, elements: visit(symbol.elements) })) } : {}) } } : {}) };
}

function checkEmissionBudget(scene: VectorScene, ctx: DiagnosticContext): void {
  let bytes = 4096;
  const add = (n: number): void => {
    bytes += n;
    if (bytes > SCENE_LIMITS.maxOutputBytes) fail(ctx, "SCENE_OUTPUT_LIMIT", "Conservative SVG output estimate exceeds 32 MiB.");
  };
  const label = (text: string): void => add(countTextPathSegments(text) * 660 + text.length * 6);
  const visit = (items: readonly SceneElement[]): void => {
    for (const item of items) {
      add(2000);
      if (item.type === "path") add(item.d.length);
      else if (item.type === "label") label(item.text);
      else if (item.type === "diagramNode" && item.label !== undefined) label(item.label);
      else if (item.type === "group") visit(item.children);
      else if (item.type === "polygon" || item.type === "polyline") add(item.points.length * 660);
      else if (item.type === "connector") add(((item.waypoints?.length ?? 0) + 10) * 660);
    }
  };
  visit(scene.elements);
  for (const symbol of scene.definitions?.symbols ?? []) { add(2000); visit(symbol.elements); }
  for (const gradient of scene.definitions?.gradients ?? []) add(2000 + gradient.stops.length * 700);
}

function sceneWarnings(scene: VectorScene): string[] {
  const warnings: string[] = [];
  const visit = (items: readonly SceneElement[], path: string): void => {
    items.forEach((item, index) => {
      const location = `${path}[${index}]`;
      if ((item.type === "rect" || item.type === "diagramNode") && (item.width === 0 || item.height === 0) || item.type === "circle" && item.r === 0 || item.type === "ellipse" && (item.rx === 0 || item.ry === 0) || item.type === "line" && item.x1 === item.x2 && item.y1 === item.y2) warnings.push(`${item.type === "circle" ? "Zero-radius circle" : item.type === "ellipse" ? "Zero-radius ellipse" : item.type === "line" ? "Zero-length line" : "Zero-area rect"} at ${location}.`);
      if (item.type === "group") visit(item.children, `${location}.children`);
    });
  };
  visit(scene.elements, "elements");
  scene.definitions?.symbols?.forEach((symbol, index) => visit(symbol.elements, `definitions.symbols[${index}].elements`));
  return warnings;
}

export function canonicalizeScene(input: unknown): Result<string> {
  const result = validateScene(input);
  if (!result.ok) return result;
  try { return { ok: true, value: canonicalJsonStringify(canonicalScenePaths(result.value.scene)) }; }
  catch { return { ok: false, diagnostics: [diagnostic({ operation: "validate", domain: "scene" }, "SCENE_CANONICAL_LIMIT", "Scene cannot be represented within canonical output limits.")] }; }
}

/**
 * Lower all diagramNodes, connectors, and labels to basic SVG shapes/paths.
 */
function lowerHighLevelElements(
  elements: readonly SceneElement[],
  boundsMap: ReadonlyMap<string, ElementBounds>,
  symbolsById: ReadonlyMap<string, SymbolDef>,
  ctx: DiagnosticContext,
): readonly SceneElement[] {
  const result: SceneElement[] = [];

  for (let i = 0; i < elements.length; i += 1) {
    const el = elements[i]!;
    const loc = `elements[${i}]`;

    switch (el.type) {
      case "diagramNode": {
        // Lower to rect + optional centered label path
        const rect: RectElement = {
          type: "rect",
          x: el.x,
          y: el.y,
          width: el.width,
          height: el.height,
          ...(el.rx !== undefined ? { rx: el.rx } : {}),
          ...(el.ry !== undefined ? { ry: el.ry } : {}),
          bounds: [el.x, el.y, el.width, el.height],
        };
        const children: SceneElement[] = [rect];

        if (el.label !== undefined && el.label.trim() !== "") {
          const scale = el.labelScale ?? 1;
          const lm = computeLabelMetrics(el.label, scale, 10, 0, 0, "left");
          const labelX = el.x + (el.width - lm.width) / 2;
          const labelY = el.y + (el.height - lm.height) / 2;

          const labelPath = lowerLabelToPath(
            {
              type: "label",
              text: el.label,
              x: labelX,
              y: labelY,
              scale,
              ...(el.labelColor !== undefined ? { color: el.labelColor } : {}),
            },
            ctx,
            `${loc}.label`,
          );
          const accessibleLabelPath: SceneElement = (el.presentation?.ariaHidden === true)
            ? labelPath
            : ({ ...labelPath, ariaLabel: el.label } as unknown as SceneElement);
          children.push(accessibleLabelPath);
        }
        result.push({ type: "group", id: el.id, children, ...(el.transform ? { transform: el.transform } : {}), ...(el.presentation ? { presentation: el.presentation } : {}) });
        break;
      }

      case "connector": {
        const loweredPaths = lowerConnectorToElements(el, boundsMap, ctx, loc);
        const children = loweredPaths.map(({ id: _id, transform: _transform, presentation, ...path }) => {
          const { opacity: _opacity, ariaHidden: _ariaHidden, ...paint } = presentation ?? {};
          return { ...path, presentation: paint };
        });
        result.push({ type: "group", ...(el.id ? { id: el.id } : {}), children, ...(el.transform ? { transform: el.transform } : {}), ...(el.presentation ? { presentation: el.presentation } : {}) });
        break;
      }

      case "label": {
        const lowered = lowerLabelToPath(el, ctx, loc);
        const accessibleLowered: SceneElement = (el.presentation?.ariaHidden === true)
          ? lowered
          : ({ ...lowered, ariaLabel: el.text } as unknown as SceneElement);
        result.push(accessibleLowered);
        break;
      }

      case "group": {
        const localBounds = new Map<string, ElementBounds>();
        for (const child of el.children) {
          const bounds = computeElementBounds(child, symbolsById);
          if (child.id !== undefined && bounds !== undefined) localBounds.set(child.id, bounds);
        }
        const loweredChildren = lowerHighLevelElements(
          el.children,
          localBounds,
          symbolsById,
          ctx,
        );
        result.push({
          ...el,
          children: loweredChildren,
        });
        break;
      }

      case "use": {
        const symbol = symbolsById.get(el.href.slice(1))!;
        result.push({ ...el, width: el.width ?? symbol.viewBox[2], height: el.height ?? symbol.viewBox[3] });
        break;
      }
      default: {
        result.push(el);
        break;
      }
    }
  }

  return result;
}

/**
 * Lowers a complete VectorScene into emitted-ready SVG geometry.
 */
export function lowerScene(
  scene: VectorScene,
  ctx: DiagnosticContext,
): VectorScene {
  const symbolsById = new Map<string, SymbolDef>();
  if (scene.definitions?.symbols !== undefined) {
    for (const s of scene.definitions.symbols) {
      symbolsById.set(s.id, s);
    }
  }

  // 1. Lower layout directives
  const postLayoutElements = lowerLayout(
    scene.elements,
    scene.layout,
    symbolsById,
    ctx,
    "$.layout",
  );

  // 2. Compute bounds map of elements with IDs for connectors
  const boundsMap = new Map<string, ElementBounds>();
  function registerBounds(items: readonly SceneElement[]): void {
    for (const item of items) {
      if (item.id !== undefined) {
        const b = computeElementBounds(item, symbolsById);
        if (b !== undefined) {
          boundsMap.set(item.id, b);
        }
      }
    }
  }
  registerBounds(postLayoutElements);

  // 3. Lower diagramNodes, connectors, and labels
  const fullyLoweredElements = lowerHighLevelElements(
    postLayoutElements,
    boundsMap,
    symbolsById,
    ctx,
  );

  // Lower symbol elements too
  let loweredSymbols: SymbolDef[] | undefined;
  if (scene.definitions?.symbols !== undefined) {
    loweredSymbols = scene.definitions.symbols.map((sym) => {
      const local = new Map<string, ElementBounds>();
      for (const element of sym.elements) {
        const bounds = computeElementBounds(element, symbolsById);
        if (element.id !== undefined && bounds !== undefined) local.set(element.id, bounds);
      }
      return { ...sym, elements: lowerHighLevelElements(sym.elements, local, symbolsById, ctx) };
    });
  }

  return {
    ...scene,
    elements: fullyLoweredElements,
    ...(loweredSymbols !== undefined
      ? {
          definitions: {
            ...scene.definitions,
            symbols: loweredSymbols,
          },
        }
      : {}),
  };
}

/**
 * Compile a VectorScene to deterministic SVG string and execution receipt.
 * Accepts `unknown` input.
 */
export function compileScene(
  input: unknown,
  options?: SceneCompileOptions,
): SceneCompileResult {
  const ctx: DiagnosticContext = {
    operation: "build",
    domain: "scene" as any,
  };

  try {
    const valResult = validateScene(input);
    if (!valResult.ok) {
      return { ok: false, diagnostics: valResult.diagnostics };
    }

    const { metrics } = valResult.value;
    const scene = canonicalScenePaths(valResult.value.scene);
    checkEmissionBudget(scene, ctx);
    const sourceDigest = computeCanonicalDigest(scene);

    const lowered = lowerScene(scene, ctx);
    const svg = emitSvg(lowered, ctx);
    const svgDigest = computeSha256(Buffer.from(svg, "utf8"));

    const tokenDigest =
      scene.tokenBindings !== undefined
        ? computeCanonicalDigest(scene.tokenBindings)
        : computeCanonicalDigest({});

    const receipt: SceneReceipt = {
      schema: "tfsb.scene-compile-receipt-v1",
      limits: SCENE_LIMITS,
      diagnostics: sceneWarnings(scene),
      sourceSnapshotDigest: computeCanonicalDigest(scene.provenance ?? {}),
      sceneSchema: SCENE_SCHEMA,
      sceneCompatibility: SCENE_COMPATIBILITY,
      sceneCompilerLevel: SCENE_COMPILER_LEVEL,
      sourceDigest,
      svgDigest,
      profile: scene.profile,
      artboard: scene.artboard,
      glyphCatalogDigest: FORGE_GRID_LABEL_V1_DIGEST,
      tokenDigest,
      metrics,
    };

    if (options?.dryRun) {
      return {
        ok: true,
        value: {
          svg: "",
          receipt,
          metrics,
        },
      };
    }

    return {
      ok: true,
      value: {
        svg,
        receipt,
        metrics,
      },
    };
  } catch (error) {
    if (error instanceof DiagnosticError) {
      return { ok: false, diagnostics: [error.diagnostic] };
    }
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          ctx,
          "SCENE_COMPILE_ERROR",
          "Scene could not be compiled within the supported geometry and output limits.",
        ),
      ],
    };
  }
}

/**
 * Inspect a VectorScene, returning parsed scene, metrics, receipt, and warnings.
 * Accepts `unknown` input.
 */
export function inspectScene(input: unknown): SceneInspectionResult {
  const ctx: DiagnosticContext = {
    operation: "check",
    domain: "scene" as any,
  };

  try {
    const compileRes = compileScene(input);
    if (!compileRes.ok) {
      return { ok: false, diagnostics: compileRes.diagnostics };
    }

    const valResult = validateScene(input);
    if (!valResult.ok) {
      return { ok: false, diagnostics: valResult.diagnostics };
    }

    const { scene, metrics } = valResult.value;
    const warnings = [...compileRes.value.receipt.diagnostics];

    return {
      ok: true,
      value: {
        scene,
        metrics,
        receipt: compileRes.value.receipt,
        warnings,
      },
    };
  } catch (error) {
    if (error instanceof DiagnosticError) {
      return { ok: false, diagnostics: [error.diagnostic] };
    }
    throw error;
  }
}
