export {
  SCENE_COMPATIBILITY,
  SCENE_COMPILER_LEVEL,
  SCENE_LIMITS,
  SCENE_PRESETS,
  SCENE_PROFILES,
  SCENE_SCHEMA,
  resolvePreset,
} from "./constants.js";

export {
  formatCanonicalNumber,
} from "./canonical.js";

export {
  FORGE_GRID_BASELINE,
  FORGE_GRID_CATALOG,
  FORGE_GRID_CELL_HEIGHT,
  FORGE_GRID_CELL_WIDTH,
  FORGE_GRID_LABEL_V1_DIGEST,
  computeCatalogDigest,
  getGlyph,
  type GlyphMetric,
} from "./glyphs/catalog.js";

export { validateScene } from "./validate.js";

export {
  compileScene,
  canonicalizeScene,
  inspectScene,
} from "./compile.js";

export {
  sceneImportSvg,
} from "./import-svg.js";

export type {
  Scene,
  SceneImportClassification,
  SceneImportFeatures,
  SceneImportResult,
} from "./import-svg-types.js";

export type {
  ArrowheadType,
  Artboard,
  BaseElement,
  CardinalAnchor,
  CircleElement,
  ConnectorElement,
  ConnectorEndpoint,
  DiagramNodeElement,
  ElementBounds,
  EllipseElement,
  GradientDef,
  GradientStop,
  GroupElement,
  LabelElement,
  LayoutDirective,
  LineElement,
  LinearGradientDef,
  Paint,
  PathElement,
  PolygonElement,
  PolylineElement,
  Presentation,
  RadialGradientDef,
  RectElement,
  SceneAccessibility,
  SceneCompileOptions,
  SceneCompileResult,
  SceneDefinitions,
  SceneElement,
  SceneInspectionResult,
  SceneMetrics,
  ScenePresetName,
  SceneProfile,
  SceneProvenance,
  SceneReceipt,
  SceneSchema,
  SceneValidationResult,
  SymbolDef,
  TransformOperation,
  UseElement,
  VectorScene,
} from "./types.js";
