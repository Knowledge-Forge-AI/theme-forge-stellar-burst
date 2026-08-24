import { fail, type DiagnosticContext } from "./diagnostics.js";
import type {
  ArtworkElementV2,
  DefinitionsV2,
  ElementPresentationV2,
  NormalizedAssetV2,
  PaintV2,
  SvgDocumentV2,
} from "./schema2-types.js";

export const MAX_SCHEMA2_GROUP_DEPTH = 8;
export const MAX_SCHEMA2_MODELED_ELEMENTS = 1_024;

interface Reference {
  readonly id: string;
  readonly location: string;
}

export function validateSvgDocumentV2(svg: SvgDocumentV2, ctx: DiagnosticContext): void {
  const ids = new Map<string, string>();
  const useTargets = new Map<string, ArtworkElementV2>();
  const gradientTargets = new Set<string>();
  const references: Reference[] = [];
  const gradientReferences: Reference[] = [];
  let elementCount = 0;

  const addId = (id: string | undefined, location: string): void => {
    if (id === undefined) return;
    const previous = ids.get(id);
    if (previous !== undefined) {
      fail(ctx, "REFERENCE_DUPLICATE_ID", `Duplicate local id '${id}' (first declared at ${previous}).`, location);
    }
    ids.set(id, location);
  };

  const inspectPaint = (paint: PaintV2 | undefined, location: string): void => {
    if (paint?.type === "linear-gradient") {
      gradientReferences.push({ id: paint.reference, location });
    }
  };

  const inspectPresentation = (value: ElementPresentationV2, location: string): void => {
    inspectPaint(value.fill, `${location}.fill`);
    inspectPaint(value.stroke, `${location}.stroke`);
  };

  const inspectElement = (element: ArtworkElementV2, location: string, depth: number): void => {
    elementCount += 1;
    if (elementCount > MAX_SCHEMA2_MODELED_ELEMENTS) {
      fail(
        ctx,
        "SCHEMA_MODEL_LIMIT_EXCEEDED",
        `An asset may contain at most ${MAX_SCHEMA2_MODELED_ELEMENTS} modeled elements.`,
        location,
      );
    }
    addId(element.id, `${location}.id`);
    inspectPresentation(element, location);
    if (element.type === "use") references.push({ id: element.reference, location: `${location}.reference` });
    if (element.type === "group") {
      if (depth > MAX_SCHEMA2_GROUP_DEPTH) {
        fail(
          ctx,
          "SCHEMA_GROUP_DEPTH_EXCEEDED",
          `Group nesting may not exceed ${MAX_SCHEMA2_GROUP_DEPTH}.`,
          location,
        );
      }
      if (element.children.length === 0) {
        fail(ctx, "SCHEMA_INVALID_RANGE", "Groups cannot be empty.", `${location}.children`);
      }
      element.children.forEach((child, index) => inspectElement(child, `${location}.children[${index}]`, depth + 1));
    }
  };

  const definitions: DefinitionsV2 = svg.definitions;
  definitions.linearGradients.forEach((gradient, index) => {
    addId(gradient.id, `definitions.linear_gradients[${index}].id`);
    gradientTargets.add(gradient.id);
  });
  const definitionCollections: readonly (readonly ArtworkElementV2[])[] = [
    definitions.groups,
    definitions.paths,
    definitions.circles,
    definitions.ellipses,
    definitions.rects,
    definitions.lines,
    definitions.polylines,
    definitions.polygons,
  ];
  let definitionIndex = 0;
  for (const collection of definitionCollections) {
    for (const definition of collection) {
      const location = `definitions.elements[${definitionIndex}]`;
      inspectElement(definition, location, definition.type === "group" ? 1 : 0);
      if (definition.id === undefined) throw new Error("Validated definitions require ids.");
      useTargets.set(definition.id, definition);
      definitionIndex += 1;
    }
  }
  svg.elements.forEach((element, index) => inspectElement(element, `elements[${index}]`, element.type === "group" ? 1 : 0));

  if (svg.accessibility.mode === "labelled") {
    addId(svg.accessibility.titleId, "accessibility.title_id");
    addId(svg.accessibility.descriptionId, "accessibility.description_id");
  }
  inspectPaint(svg.presentation.fill, "presentation.fill");
  inspectPaint(svg.presentation.stroke, "presentation.stroke");

  for (const reference of references) {
    if (!useTargets.has(reference.id)) {
      fail(ctx, "REFERENCE_UNRESOLVED", `Local use '#${reference.id}' does not resolve to a typed definition.`, reference.location);
    }
  }
  for (const reference of gradientReferences) {
    if (!gradientTargets.has(reference.id)) {
      fail(ctx, "REFERENCE_UNRESOLVED", `Gradient '#${reference.id}' does not resolve to a linear gradient.`, reference.location);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) fail(ctx, "REFERENCE_CYCLE", `Definition reference cycle includes '${id}'.`, `definitions.${id}`);
    visiting.add(id);
    const target = useTargets.get(id);
    if (target?.type === "group") {
      const scan = (child: ArtworkElementV2): void => {
        if (child.type === "use") visit(child.reference);
        if (child.type === "group") child.children.forEach(scan);
      };
      target.children.forEach(scan);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of useTargets.keys()) visit(id);
}

export function validateAssetV2(asset: NormalizedAssetV2, ctx: DiagnosticContext): void {
  validateSvgDocumentV2(asset.svg, ctx);
}
