import { DiagnosticError, diagnostic } from "../diagnostics.js";
import { canonicalizeSceneRevision } from "./compile.js";
import type { Result, SceneElement, VectorScene } from "./types.js";

function invalidEdits(message: string): never {
  throw new DiagnosticError(diagnostic({ operation: "build", domain: "scene" }, "SCENE_INVALID_PATH_EDITS", message));
}

export function reviseScene(source: unknown, edits: unknown): Result<string> {
  return canonicalizeSceneRevision(source, (scene, metrics) => applyEdits(scene, edits, metrics.authoredElementCount));
}

function applyEdits(scene: VectorScene, edits: unknown, authoredElementCount: number): unknown {
  if (edits !== null && typeof edits === "object" && !Array.isArray(edits)) {
    const request = edits as Record<string, unknown>;
    const operations = ["removeGroup", "replaceGroup", "appendGroup"] as const;
    const operation = operations.find(key => Object.hasOwn(request, key));
    if (operation !== undefined) {
      const hasParent = Object.hasOwn(request, "parentGroupId");
      const parentId = request["parentGroupId"];
      if (Object.keys(request).length !== (hasParent ? 2 : 1) || (hasParent && typeof parentId !== "string")) {
        invalidEdits("Provide exactly one group operation with an optional parentGroupId.");
      }
      if (!hasParent) {
        return { ...scene, elements: reviseGroups(scene.elements, operation, request[operation], "top-level") };
      }
      const parentIndex = scene.elements.findIndex(element => element.type === "group" && element.id === parentId);
      const parent = scene.elements[parentIndex];
      if (parent?.type !== "group") invalidEdits("The parentGroupId must name an existing top-level group.");
      const elements: unknown[] = [...scene.elements];
      elements[parentIndex] = { ...parent, children: reviseGroups(parent.children, operation, request[operation], "child") };
      return { ...scene, elements };
    }
  }

  if (!Array.isArray(edits) || edits.length === 0 || edits.length > authoredElementCount) {
    invalidEdits("Provide a nonempty array of path edits for this scene.");
  }
  const remaining = new Map<string, string>();
  for (const edit of edits as unknown[]) {
    if (edit === null || typeof edit !== "object" || Array.isArray(edit)) {
      invalidEdits("Each path edit must contain only id and d.");
    }
    const record = edit as Record<string, unknown>;
    const id = record["id"];
    const path = record["d"];
    if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "id") || !Object.hasOwn(record, "d") ||
        typeof id !== "string" || typeof path !== "string" || remaining.has(id)) {
      invalidEdits("Each path edit must supply a unique id and string d.");
    }
    remaining.set(id, path);
  }

  function revise(elements: readonly SceneElement[]): readonly SceneElement[] {
    return elements.map((element) => {
      if (element.type === "group") return { ...element, children: revise(element.children) };
      if (element.type !== "path" || element.id === undefined) return element;
      const path = remaining.get(element.id);
      if (path === undefined) return element;
      remaining.delete(element.id);
      return { ...element, d: path };
    });
  }

  const elements = revise(scene.elements);
  const definitions = scene.definitions?.symbols === undefined
    ? scene.definitions
    : {
        ...scene.definitions,
        symbols: scene.definitions.symbols.map((symbol) => ({ ...symbol, elements: revise(symbol.elements) })),
      };
  if (remaining.size !== 0) invalidEdits("Every edit must name an existing path element.");
  return { ...scene, elements, ...(definitions === undefined ? {} : { definitions }) };
}

function reviseGroups(
  siblings: readonly SceneElement[],
  operation: "removeGroup" | "replaceGroup" | "appendGroup",
  value: unknown,
  level: "top-level" | "child",
): unknown[] {
  if (operation === "removeGroup") {
    if (typeof value !== "string") invalidEdits("Provide removeGroup with the id of an existing group.");
    const index = siblings.findIndex(element => element.type === "group" && element.id === value);
    if (index === -1) invalidEdits(`A group removal must name an existing ${level} group.`);
    return [...siblings.slice(0, index), ...siblings.slice(index + 1)];
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidEdits(`Provide exactly one ${operation} object.`);
  }
  const group = value as Record<string, unknown>;
  if (group["type"] !== "group" || typeof group["id"] !== "string" ||
      !Array.isArray(group["children"]) || group["children"].length === 0) {
    invalidEdits(operation === "appendGroup"
      ? "An appended group must have an id and nonempty children."
      : "A replacement group must have an id and nonempty children.");
  }
  if (operation === "appendGroup") return [...siblings, value];
  const index = siblings.findIndex(element => element.type === "group" && element.id === group["id"]);
  if (index === -1) invalidEdits(`A replacement group must name an existing ${level} group.`);
  const revised: unknown[] = [...siblings];
  revised[index] = value;
  return revised;
}
