import type { HexColor, LocalId } from "../types.js";
import type { Sha256Digest } from "../digests.js";

export type SceneSchema = "tfsb.vector-scene-v1";
export type SceneCompatibility = 1;
export type SceneCompilerLevel = 1;

export type SceneProfile =
  | "illustration"
  | "diagram"
  | "editorial"
  | "promotional"
  | "pattern";

export type ScenePresetName =
  | "hero"
  | "section"
  | "diagram"
  | "figure"
  | "social";

export interface Artboard {
  readonly width: number;
  readonly height: number;
  readonly viewBox: readonly [number, number, number, number];
  readonly policy?: "contain" | "pad";
}

export type Paint =
  | { readonly type: "none" }
  | { readonly type: "currentColor" }
  | { readonly type: "solid"; readonly color: HexColor }
  | { readonly type: "token"; readonly name: string }
  | { readonly type: "gradient"; readonly id: string; readonly fallback?: HexColor };

export interface Presentation {
  readonly fill?: Paint;
  readonly stroke?: Paint;
  readonly strokeWidth?: number;
  readonly strokeDasharray?: readonly number[];
  readonly strokeDashoffset?: number;
  readonly strokeLinecap?: "butt" | "round" | "square";
  readonly strokeLinejoin?: "miter" | "round" | "bevel";
  readonly strokeMiterlimit?: number;
  readonly opacity?: number;
  readonly fillOpacity?: number;
  readonly strokeOpacity?: number;
  readonly fillRule?: "nonzero" | "evenodd";
  readonly clipRule?: "nonzero" | "evenodd";
  readonly ariaHidden?: boolean;
}

export type TransformOperation =
  | { readonly type: "translate"; readonly x: number; readonly y?: number }
  | { readonly type: "scale"; readonly x: number; readonly y?: number }
  | { readonly type: "rotate"; readonly angle: number; readonly cx?: number; readonly cy?: number }
  | { readonly type: "matrix"; readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly e: number; readonly f: number };

export interface GradientStop {
  readonly offset: number;
  readonly color: Paint;
  readonly opacity?: number;
}

export interface LinearGradientDef {
  readonly id: string;
  readonly type: "linearGradient";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly gradientUnits?: "userSpaceOnUse" | "objectBoundingBox";
  readonly spreadMethod?: "pad";
  readonly stops: readonly GradientStop[];
}

export interface RadialGradientDef {
  readonly id: string;
  readonly type: "radialGradient";
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly fx?: number;
  readonly fy?: number;
  readonly gradientUnits?: "userSpaceOnUse" | "objectBoundingBox";
  readonly spreadMethod?: "pad";
  readonly stops: readonly GradientStop[];
}

export type GradientDef = LinearGradientDef | RadialGradientDef;

export interface SymbolDef {
  readonly id: string;
  readonly type: "symbol";
  readonly viewBox: readonly [number, number, number, number];
  readonly elements: readonly SceneElement[];
}

export interface SceneDefinitions {
  readonly gradients?: readonly GradientDef[];
  readonly symbols?: readonly SymbolDef[];
}

export type CardinalAnchor = "top" | "bottom" | "left" | "right" | "center";

export type ConnectorEndpoint =
  | { readonly x: number; readonly y: number }
  | { readonly elementId: string; readonly anchor: CardinalAnchor };

export type ArrowheadType = "none" | "triangle" | "chevron";

export type ElementBounds = readonly [number, number, number, number]; // [minX, minY, width, height]

export interface BaseElement {
  readonly id?: string;
  readonly presentation?: Presentation;
  readonly transform?: readonly TransformOperation[];
  readonly bounds?: ElementBounds;
}

export interface PathElement extends BaseElement {
  readonly type: "path";
  readonly d: string;
}

export interface RectElement extends BaseElement {
  readonly type: "rect";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rx?: number;
  readonly ry?: number;
}

export interface CircleElement extends BaseElement {
  readonly type: "circle";
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

export interface EllipseElement extends BaseElement {
  readonly type: "ellipse";
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}

export interface LineElement extends BaseElement {
  readonly type: "line";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface PolylineElement extends BaseElement {
  readonly type: "polyline";
  readonly points: readonly (readonly [number, number])[];
}

export interface PolygonElement extends BaseElement {
  readonly type: "polygon";
  readonly points: readonly (readonly [number, number])[];
}

export interface GroupElement extends BaseElement {
  readonly type: "group";
  readonly children: readonly SceneElement[];
}

export interface UseElement extends BaseElement {
  readonly type: "use";
  readonly href: string;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface DiagramNodeElement extends BaseElement {
  readonly type: "diagramNode";
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rx?: number;
  readonly ry?: number;
  readonly label?: string;
  readonly labelColor?: Paint;
  readonly labelScale?: number;
}

export interface ConnectorElement extends BaseElement {
  readonly type: "connector";
  readonly routing: "straight" | "orthogonal";
  readonly from: ConnectorEndpoint;
  readonly to: ConnectorEndpoint;
  readonly waypoints?: readonly (readonly [number, number])[];
  readonly startArrowhead?: ArrowheadType;
  readonly endArrowhead?: ArrowheadType;
  readonly arrowheadSize?: number;
}

export interface LabelElement extends BaseElement {
  readonly type: "label";
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly scale?: number;
  readonly color?: Paint;
  readonly lineSpacing?: number;
  readonly align?: "left" | "center" | "right";
}

export type SceneElement =
  | PathElement
  | RectElement
  | CircleElement
  | EllipseElement
  | LineElement
  | PolylineElement
  | PolygonElement
  | GroupElement
  | UseElement
  | DiagramNodeElement
  | ConnectorElement
  | LabelElement;

export type LayoutDirective =
  | {
      readonly type: "align";
      readonly alignment: "left" | "center" | "right" | "top" | "middle" | "bottom";
      readonly targets: readonly string[];
      readonly relativeTo?: string;
    }
  | {
      readonly type: "distribute";
      readonly axis: "horizontal" | "vertical";
      readonly targets: readonly string[];
      readonly spacing?: number;
    }
  | {
      readonly type: "grid";
      readonly targets: readonly string[];
      readonly columns: number;
      readonly columnGap?: number;
      readonly rowGap?: number;
      readonly startX?: number;
      readonly startY?: number;
    }
  | {
      readonly type: "anchor";
      readonly target: string;
      readonly targetAnchor: CardinalAnchor;
      readonly relativeTo: string;
      readonly relativeToAnchor: CardinalAnchor;
      readonly offsetX?: number;
      readonly offsetY?: number;
    };

export type SceneAccessibility =
  | {
      readonly mode: "labelled";
      readonly title: string;
      readonly desc?: string;
      readonly focusable?: boolean;
    }
  | {
      readonly mode: "decorative";
      readonly focusable?: boolean;
    };

export interface SceneProvenance {
  readonly author?: string;
  readonly license?: string;
  readonly sourceDigest?: string;
  readonly created?: string;
  readonly note?: string;
}

export interface VectorScene {
  readonly schema: SceneSchema;
  readonly compatibility: SceneCompatibility;
  /** Minimum semantic compiler level required; saved documents retain this value. */
  readonly compilerLevel: SceneCompilerLevel;
  readonly profile: SceneProfile;
  readonly artboard: Artboard;
  readonly accessibility: SceneAccessibility;
  readonly elements: readonly SceneElement[];
  readonly definitions?: SceneDefinitions;
  readonly tokenBindings?: Readonly<Record<string, HexColor>>;
  readonly layout?: readonly LayoutDirective[];
  readonly provenance?: SceneProvenance;
}

export interface SceneMetrics {
  readonly expandedElementCount: number;
  readonly authoredElementCount: number;
  readonly pathSegmentCount: number;
  readonly glyphCount: number;
  readonly maxNestingDepth: number;
  readonly gradientStopCount: number;
}

export interface SceneReceipt {
  readonly schema: "tfsb.scene-compile-receipt-v1";
  readonly limits: typeof import("./constants.js").SCENE_LIMITS;
  readonly diagnostics: readonly string[];
  readonly sourceSnapshotDigest: Sha256Digest;
  readonly sceneSchema: SceneSchema;
  readonly sceneCompatibility: SceneCompatibility;
  readonly sceneCompilerLevel: SceneCompilerLevel;
  readonly sourceDigest: Sha256Digest;
  readonly svgDigest: Sha256Digest;
  readonly profile: SceneProfile;
  readonly artboard: Artboard;
  readonly glyphCatalogDigest: Sha256Digest;
  readonly tokenDigest: Sha256Digest;
  readonly metrics: SceneMetrics;
}

export interface SceneCompileOptions {
  readonly dryRun?: boolean;
}

export type SceneDiagnostic = import("../diagnostics.js").Diagnostic;

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostics: readonly SceneDiagnostic[] };

export type SceneValidationResult = Result<{
  readonly scene: VectorScene;
  readonly metrics: SceneMetrics;
}>;

export type SceneInspectionResult = Result<{
  readonly scene: VectorScene;
  readonly metrics: SceneMetrics;
  readonly receipt: SceneReceipt;
  readonly warnings: readonly string[];
}>;

export type SceneCompileResult = Result<{
  readonly svg: string;
  readonly receipt: SceneReceipt;
  readonly metrics: SceneMetrics;
}>;
