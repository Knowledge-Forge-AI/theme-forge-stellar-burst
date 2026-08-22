/** Proposed TOML-facing schema-1 types. Runtime decoding must validate every field. */

export type SchemaVersion = 1;

export interface ProjectToml {
  readonly schema_version: SchemaVersion;
  readonly name: string;
  readonly build: BuildToml;
  readonly install?: readonly InstallToml[];
}

export interface BuildToml {
  readonly directory: string; // Validated project-relative path.
}

export interface InstallToml {
  readonly asset: string;
  readonly destinations: readonly string[]; // Validated project-relative paths.
}

export interface AssetToml {
  readonly schema_version: SchemaVersion;
  readonly id: string;
  readonly filename: string;
  readonly metadata_text?: string;
  readonly canvas: CanvasToml;
  readonly accessibility: AccessibilityToml;
  readonly definitions?: DefinitionsToml;
  readonly elements: readonly ElementToml[];
}

export interface CanvasToml {
  readonly width: number;
  readonly height: number;
  readonly view_box: string;
  readonly shape_rendering?:
    | "auto"
    | "optimizeSpeed"
    | "crispEdges"
    | "geometricPrecision";
}

export interface AccessibilityToml {
  readonly title: string;
  readonly title_id: string;
  readonly description: string;
  readonly description_id: string;
}

export interface DefinitionsToml {
  readonly linear_gradients?: readonly LinearGradientToml[];
  readonly paths?: readonly PathSpecToml[];
  readonly groups?: readonly DefinitionGroupToml[];
}

export interface LinearGradientToml {
  readonly id: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly units?: "userSpaceOnUse" | "objectBoundingBox";
  readonly stops: readonly GradientStopToml[];
}

export interface GradientStopToml {
  readonly offset: number;
  readonly color: string;
  readonly opacity?: number;
}

export interface PresentationToml {
  readonly fill?: string;
  readonly fill_fallback?: string;
  readonly stroke?: string;
  readonly stroke_fallback?: string;
  readonly stroke_width?: number;
  readonly stroke_linecap?: "butt" | "round" | "square";
  readonly stroke_linejoin?: "miter" | "round" | "bevel";
  readonly stroke_miterlimit?: number;
}

export interface PathSpecToml extends PresentationToml {
  readonly id?: string;
  readonly d: string;
  readonly transform?: string;
}

export interface UseSpecToml extends PresentationToml {
  readonly id?: string;
  readonly href: string;
  readonly x?: number;
  readonly y?: number;
  readonly transform?: string;
}

export type GroupBodyToml =
  | {
      readonly paths: readonly PathSpecToml[];
      readonly uses?: never;
    }
  | {
      readonly paths?: never;
      readonly uses: readonly UseSpecToml[];
    };

export type DefinitionGroupToml = {
  readonly id: string;
  readonly paths: readonly PathSpecToml[];
} & PresentationToml;

export type PathElementToml = {
  readonly type: "path";
} & PathSpecToml;

export type UseElementToml = {
  readonly type: "use";
} & UseSpecToml;

export type GroupElementToml = {
  readonly type: "group";
  readonly id?: string;
  readonly transform?: string;
} & PresentationToml &
  GroupBodyToml;

export type ElementToml = PathElementToml | UseElementToml | GroupElementToml;

/** Normalized values produced only by validators; brands prevent unchecked strings. */
declare const validated: unique symbol;

export type AssetId = string & { readonly [validated]: "AssetId" };
export type LocalId = string & { readonly [validated]: "LocalId" };
export type ProjectRelativePath = string & {
  readonly [validated]: "ProjectRelativePath";
};
export type PathData = string & { readonly [validated]: "PathData" };
export type HexColor = string & { readonly [validated]: "HexColor" };

export type Paint =
  | { readonly type: "none" }
  | { readonly type: "solid"; readonly color: HexColor }
  | {
      readonly type: "linear-gradient";
      readonly reference: LocalId;
      readonly fallback?: HexColor;
    };

export type TransformOperation =
  | {
      readonly type: "translate";
      readonly x: number;
      readonly y?: number;
    }
  | {
      readonly type: "scale";
      readonly x: number;
      readonly y?: number;
    };

export interface Diagnostic {
  readonly code: string;
  readonly operation: "import" | "parse" | "build" | "install" | "check";
  readonly source?: string;
  readonly location?: string;
  readonly message: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };
