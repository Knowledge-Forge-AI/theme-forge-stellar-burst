import { fail, type DiagnosticContext } from "./diagnostics.js";
import type {
  ArtworkElement,
  Paint,
  PathSpec,
  Presentation,
  SvgDocument,
  UseSpec,
} from "./types.js";

interface Reference {
  readonly id: string;
  readonly location: string;
}

export function validateSvgDocument(
  svg: SvgDocument,
  context: DiagnosticContext,
): void {
  const allIds = new Map<string, string>();
  const useTargets = new Set<string>();
  const gradientTargets = new Set<string>();
  const hrefs: Reference[] = [];
  const gradientReferences: Reference[] = [];

  const addId = (id: string | undefined, location: string): void => {
    if (id === undefined) return;
    const previous = allIds.get(id);
    if (previous !== undefined) {
      fail(
        context,
        "REFERENCE_DUPLICATE_ID",
        `Duplicate local id '${id}' (first declared at ${previous}).`,
        location,
      );
    }
    allIds.set(id, location);
  };

  const inspectPaint = (paint: Paint | undefined, location: string): void => {
    if (paint?.type === "linear-gradient") {
      gradientReferences.push({ id: paint.reference, location });
    }
  };

  const inspectPresentation = (value: Presentation, location: string): void => {
    inspectPaint(value.fill, `${location}.fill`);
    inspectPaint(value.stroke, `${location}.stroke`);
  };

  const inspectPath = (path: PathSpec, location: string): void => {
    addId(path.id, `${location}.id`);
    inspectPresentation(path, location);
  };

  const inspectUse = (use: UseSpec, location: string): void => {
    addId(use.id, `${location}.id`);
    inspectPresentation(use, location);
    hrefs.push({ id: use.href, location: `${location}.href` });
  };

  addId(svg.accessibility.titleId, "accessibility.title_id");
  addId(svg.accessibility.descriptionId, "accessibility.description_id");

  svg.definitions.linearGradients.forEach((gradient, index) => {
    const location = `definitions.linear_gradients[${index}]`;
    addId(gradient.id, `${location}.id`);
    gradientTargets.add(gradient.id);
  });
  svg.definitions.groups.forEach((group, index) => {
    const location = `definitions.groups[${index}]`;
    addId(group.id, `${location}.id`);
    useTargets.add(group.id);
    inspectPresentation(group, location);
    group.paths.forEach((path, pathIndex) =>
      inspectPath(path, `${location}.paths[${pathIndex}]`),
    );
  });
  svg.definitions.paths.forEach((path, index) => {
    const location = `definitions.paths[${index}]`;
    addId(path.id, `${location}.id`);
    if (path.id !== undefined) useTargets.add(path.id);
    inspectPresentation(path, location);
  });

  const inspectArtwork = (element: ArtworkElement, index: number): void => {
    const location = `elements[${index}]`;
    if (element.type === "path") {
      inspectPath(element, location);
      return;
    }
    if (element.type === "use") {
      inspectUse(element, location);
      return;
    }
    addId(element.id, `${location}.id`);
    inspectPresentation(element, location);
    if (element.body.type === "paths") {
      element.body.paths.forEach((path, pathIndex) =>
        inspectPath(path, `${location}.paths[${pathIndex}]`),
      );
    } else {
      element.body.uses.forEach((use, useIndex) =>
        inspectUse(use, `${location}.uses[${useIndex}]`),
      );
    }
  };
  svg.elements.forEach(inspectArtwork);

  for (const reference of hrefs) {
    if (!useTargets.has(reference.id)) {
      fail(
        context,
        "REFERENCE_UNRESOLVED",
        `Local href '#${reference.id}' does not resolve to a path or group definition.`,
        reference.location,
      );
    }
  }
  for (const reference of gradientReferences) {
    if (!gradientTargets.has(reference.id)) {
      fail(
        context,
        "REFERENCE_UNRESOLVED",
        `Paint reference 'url(#${reference.id})' does not resolve to a linear gradient.`,
        reference.location,
      );
    }
  }
}
