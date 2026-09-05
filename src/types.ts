declare const validated: unique symbol;

export type AssetId = string & { readonly [validated]: "AssetId" };
export type LocalId = string & { readonly [validated]: "LocalId" };
export type ProjectRelativePath = string & {
  readonly [validated]: "ProjectRelativePath";
};
export type SvgFilename = string & { readonly [validated]: "SvgFilename" };
export type PathData = string & { readonly [validated]: "PathData" };
export type HexColor = string & { readonly [validated]: "HexColor" };

export type DiagnosticOperation =
  | "parse"
  | "validate"
  | "serialize"
  | "import"
  | "edit"
  | "build"
  | "install"
  | "check"
  | "list"
  | "reconcile"
  | "bundle"
  | "diff"
  | "fmt"
  | "preview"
  | "analyze"
  | "migrate"
  | "export"
  | "discover";
export type DiagnosticDomain =
  | "project-toml"
  | "asset-toml"
  | "svg"
  | "archive"
  | "project"
  | "filesystem"
  | "cli"
  | "provenance"
  | "transaction"
  | "manifest"
  | "analyze"
  | "source-map"
  | "source-identity"
  | "workspace"
  | "directory-snapshot"
  | "brand"
  | "brand-toml";

export interface Diagnostic {
  readonly code: string;
  readonly operation: DiagnosticOperation;
  readonly domain: DiagnosticDomain;
  readonly source?: string;
  readonly location?: string;
  readonly message: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface NormalizedProject {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly buildDirectory: ProjectRelativePath;
  readonly installs: readonly InstallDeclaration[];
  readonly companions: readonly CompanionDeclaration[];
}

export interface InstallDeclaration {
  readonly asset: AssetId;
  readonly destinations: readonly ProjectRelativePath[];
}

export interface CompanionDeclaration {
  readonly file: ProjectRelativePath;
  readonly destinations: readonly ProjectRelativePath[];
}

export interface NormalizedAsset {
  readonly schemaVersion: 1;
  readonly id: AssetId;
  readonly filename: SvgFilename;
  readonly svg: SvgDocument;
}

export interface SvgDocument {
  readonly canvas: Canvas;
  readonly accessibility: Accessibility;
  readonly metadataText?: string;
  readonly definitions: Definitions;
  readonly elements: readonly ArtworkElement[];
}

export interface Canvas {
  readonly width?: number;
  readonly height?: number;
  readonly viewBox: readonly [number, number, number, number];
  readonly shapeRendering?: ShapeRendering;
}

export type ShapeRendering =
  | "optimizeSpeed"
  | "crispEdges"
  | "geometricPrecision";

export interface Accessibility {
  readonly title: string;
  readonly titleId: LocalId;
  readonly description: string;
  readonly descriptionId: LocalId;
  readonly focusable?: boolean;
}

export interface Definitions {
  readonly linearGradients: readonly LinearGradient[];
  readonly groups: readonly DefinitionGroup[];
  readonly paths: readonly DefinitionPath[];
}

export interface LinearGradient {
  readonly id: LocalId;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly units?: "userSpaceOnUse";
  readonly stops: readonly GradientStop[];
}

export interface GradientStop {
  readonly offset: number;
  readonly color: HexColor;
  readonly opacity?: number;
}

export type Paint =
  | { readonly type: "none" }
  | { readonly type: "solid"; readonly color: HexColor }
  | {
      readonly type: "linear-gradient";
      readonly reference: LocalId;
      readonly fallback?: HexColor;
    };

export interface Presentation {
  readonly fill?: Paint;
  readonly stroke?: Paint;
  readonly strokeWidth?: number;
  readonly strokeLinecap?: "butt" | "round" | "square";
  readonly strokeLinejoin?: "miter" | "round" | "bevel";
  readonly strokeMiterlimit?: number;
  readonly opacity?: number;
  readonly ariaHidden?: boolean;
}

export type TransformOperation =
  | { readonly type: "translate"; readonly x: number; readonly y?: number }
  | { readonly type: "scale"; readonly x: number; readonly y?: number };

export interface PathSpec extends Presentation {
  readonly id?: LocalId;
  readonly d: PathData;
  readonly transform?: readonly TransformOperation[];
}

export type DefinitionPath = PathSpec & { readonly id: LocalId };

export interface UseSpec extends Presentation {
  readonly id?: LocalId;
  readonly href: LocalId;
  readonly x?: number;
  readonly y?: number;
  readonly transform?: readonly TransformOperation[];
}

export interface DefinitionGroup extends Presentation {
  readonly id: LocalId;
  readonly paths: readonly PathSpec[];
}

export type GroupBody =
  | { readonly type: "paths"; readonly paths: readonly PathSpec[] }
  | { readonly type: "uses"; readonly uses: readonly UseSpec[] };

export type ArtworkElement =
  | ({ readonly type: "path" } & PathSpec)
  | ({ readonly type: "use" } & UseSpec)
  | (Presentation & {
      readonly type: "group";
      readonly id?: LocalId;
      readonly transform?: readonly TransformOperation[];
      readonly body: GroupBody;
    });
