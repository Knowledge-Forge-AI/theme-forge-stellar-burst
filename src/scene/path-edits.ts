import { DiagnosticError, diagnostic } from "../diagnostics.js";
import { canonicalizeScene } from "./compile.js";
import type { Result, SceneElement } from "./types.js";
import { validateScene } from "./validate.js";

function invalidEdits(message: string): never {
  throw new DiagnosticError(diagnostic({ operation: "build", domain: "scene" }, "SCENE_INVALID_PATH_EDITS", message));
}

export function reviseScene(source: unknown, edits: unknown): Result<string> {
  const validated = validateScene(source);
  if (!validated.ok) return validated;

  if (edits !== null && typeof edits === "object" && !Array.isArray(edits) && Object.hasOwn(edits, "appendGroup")) {
    const request = edits as Record<string, unknown>;
    const group = request["appendGroup"];
    if (Object.keys(request).length !== 1 || group === null || typeof group !== "object" || Array.isArray(group)) {
      invalidEdits("Provide exactly one appendGroup object.");
    }
    const record = group as Record<string, unknown>;
    if (record["type"] !== "group" || typeof record["id"] !== "string" ||
        !Array.isArray(record["children"]) || record["children"].length === 0) {
      invalidEdits("An appended group must have an id and nonempty children.");
    }
    const scene = validated.value.scene;
    return canonicalizeScene({ ...scene, elements: [...scene.elements, group] }, { fitInput: true });
  }

  if (!Array.isArray(edits) || edits.length === 0 || edits.length > validated.value.metrics.authoredElementCount) {
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

  const scene = validated.value.scene;
  const elements = revise(scene.elements);
  const definitions = scene.definitions?.symbols === undefined
    ? scene.definitions
    : {
        ...scene.definitions,
        symbols: scene.definitions.symbols.map((symbol) => ({ ...symbol, elements: revise(symbol.elements) })),
      };
  if (remaining.size !== 0) invalidEdits("Every edit must name an existing path element.");
  return canonicalizeScene({ ...scene, elements, ...(definitions === undefined ? {} : { definitions }) }, { fitInput: true });
}
