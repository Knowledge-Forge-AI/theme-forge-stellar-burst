import type {
  AssetId,
  Canvas,
  CompanionDeclaration,
  DefinitionGroup,
  DefinitionPath,
  GradientStop,
  HexColor,
  InstallDeclaration,
  LinearGradient,
  LocalId,
  PathData,
  ProjectRelativePath,
  SvgFilename,
} from "./types.js";

export interface NormalizedProjectV2 {
  readonly schemaVersion: 2;
  readonly name: string;
  readonly buildDirectory: ProjectRelativePath;
  readonly installs: readonly InstallDeclaration[];
  readonly companions: readonly CompanionDeclaration[];
}

export interface NormalizedAssetV2 {
  readonly schemaVersion: 2;
  readonly id: AssetId;
  readonly filename: SvgFilename;
  readonly svg: SvgDocumentV2;
}

export type AccessibilityV2 =
  | {
      readonly mode: "labelled";
      readonly title: string;
      readonly titleId: LocalId;
      readonly description?: string;
      readonly descriptionId?: LocalId;
      readonly focusable?: boolean;
    }
  | { readonly mode: "decorative"; readonly focusable?: boolean }
  | { readonly mode: "consumer_labelled"; readonly focusable?: boolean };

export type PaintV2 =
  | { readonly type: "none" }
  | { readonly type: "solid"; readonly color: HexColor }
  | { readonly type: "currentColor" }
  | {
      readonly type: "linear-gradient";
      readonly reference: LocalId;
      readonly fallback?: HexColor;
    };

/** Root/document presentation. Accessibility owns root aria-hidden. */
export interface PresentationV2 {
  readonly fill?: PaintV2;
  readonly stroke?: PaintV2;
  readonly strokeWidth?: number;
  readonly strokeLinecap?: "butt" | "round" | "square";
  readonly strokeLinejoin?: "miter" | "round" | "bevel";
  readonly strokeMiterlimit?: number;
  readonly opacity?: number;
  readonly fillOpacity?: number;
  readonly strokeOpacity?: number;
  readonly fillRule?: "nonzero" | "evenodd";
  readonly clipRule?: "nonzero" | "evenodd";
}

export interface ElementPresentationV2 extends PresentationV2 {
  readonly ariaHidden?: boolean;
}

export type TransformOperationV2 =
  | { readonly type: "translate"; readonly x: number; readonly y?: number }
  | { readonly type: "scale"; readonly x: number; readonly y?: number }
  | {
      readonly type: "rotate";
      readonly angle: number;
      readonly cx?: number;
      readonly cy?: number;
    };

export interface ElementBaseV2 extends ElementPresentationV2 {
  readonly id?: LocalId;
  readonly transforms?: readonly TransformOperationV2[];
}

export interface PathSpecV2 extends ElementBaseV2 {
  readonly type: "path";
  readonly d: PathData;
}

export interface UseSpecV2 extends ElementBaseV2 {
  readonly type: "use";
  readonly reference: LocalId;
  readonly x?: number;
  readonly y?: number;
}

export interface CircleSpecV2 extends ElementBaseV2 {
  readonly type: "circle";
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

export interface EllipseSpecV2 extends ElementBaseV2 {
  readonly type: "ellipse";
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}

export interface RectSpecV2 extends ElementBaseV2 {
  readonly type: "rect";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly cornerRadius?: number;
  readonly cornerRadii?: readonly [number, number];
}

export interface LineSpecV2 extends ElementBaseV2 {
  readonly type: "line";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface PolylineSpecV2 extends ElementBaseV2 {
  readonly type: "polyline";
  readonly points: readonly (readonly [number, number])[];
}

export interface PolygonSpecV2 extends ElementBaseV2 {
  readonly type: "polygon";
  readonly points: readonly (readonly [number, number])[];
}

export interface GroupSpecV2 extends ElementBaseV2 {
  readonly type: "group";
  readonly children: readonly ArtworkElementV2[];
}

export type ArtworkElementV2 =
  | PathSpecV2
  | UseSpecV2
  | CircleSpecV2
  | EllipseSpecV2
  | RectSpecV2
  | LineSpecV2
  | PolylineSpecV2
  | PolygonSpecV2
  | GroupSpecV2;

export type DefinitionPathV2 = PathSpecV2 & { readonly id: LocalId };
export type DefinitionGroupV2 = GroupSpecV2 & { readonly id: LocalId };
export type DefinitionCircleV2 = CircleSpecV2 & { readonly id: LocalId };
export type DefinitionEllipseV2 = EllipseSpecV2 & { readonly id: LocalId };
export type DefinitionRectV2 = RectSpecV2 & { readonly id: LocalId };
export type DefinitionLineV2 = LineSpecV2 & { readonly id: LocalId };
export type DefinitionPolylineV2 = PolylineSpecV2 & { readonly id: LocalId };
export type DefinitionPolygonV2 = PolygonSpecV2 & { readonly id: LocalId };

export interface DefinitionsV2 {
  readonly linearGradients: readonly LinearGradient[];
  readonly groups: readonly DefinitionGroupV2[];
  readonly paths: readonly DefinitionPathV2[];
  readonly circles: readonly DefinitionCircleV2[];
  readonly ellipses: readonly DefinitionEllipseV2[];
  readonly rects: readonly DefinitionRectV2[];
  readonly lines: readonly DefinitionLineV2[];
  readonly polylines: readonly DefinitionPolylineV2[];
  readonly polygons: readonly DefinitionPolygonV2[];
}

export interface SvgDocumentV2 {
  readonly canvas: Canvas;
  readonly accessibility: AccessibilityV2;
  readonly presentation: PresentationV2;
  readonly metadataText?: string;
  readonly definitions: DefinitionsV2;
  readonly elements: readonly ArtworkElementV2[];
}

export type SharedDefinitionV1 = DefinitionGroup | DefinitionPath | LinearGradient | GradientStop;
