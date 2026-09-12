import { fail, type DiagnosticContext } from "../diagnostics.js";
import { SCENE_LIMITS } from "./constants.js";

/** Bound plain JSON structure and its exact compact UTF-8 spelling before parsing. */
export function guardSceneInput(raw: unknown, ctx: DiagnosticContext): void {
  const active = new Set<object>();
  let bytes = 0, nodes = 0;
  const add = (n: number): void => {
    bytes += n;
    if (bytes > SCENE_LIMITS.maxInputBytes) fail(ctx, "SCENE_LIMIT_EXCEEDED", "Input exceeds 8 MiB.", "$");
  };
  const stringBytes = (value: string): void => {
    // Reject XML-invalid controls and lone surrogates, including metadata/title.
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(value) || /[\uD800-\uDFFF]/u.test(value)) fail(ctx, "SCENE_INVALID_STRUCTURE", "Strings must contain valid Unicode/XML characters.", "$");
    add(2);
    for (const char of value) {
      add(char === '"' || char === "\\" || char === "\n" || char === "\r" || char === "\t" ? 2 : Buffer.byteLength(char));
    }
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > SCENE_LIMITS.maxInputNodes || depth > SCENE_LIMITS.maxStructuralDepth) fail(ctx, "SCENE_LIMIT_EXCEEDED", "Input structure exceeds production limits.", "$");
    if (value === null) { add(4); return; }
    if (typeof value === "string") { stringBytes(value); return; }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail(ctx, "SCENE_INVALID_NUMBER", "Numbers must be finite.", "$");
      add(String(value).length); return;
    }
    if (typeof value === "boolean") { add(value ? 4 : 5); return; }
    if (typeof value !== "object") fail(ctx, "SCENE_INVALID_STRUCTURE", "Only plain JSON data is accepted.", "$");
    if (active.has(value)) fail(ctx, "SCENE_CYCLIC_INPUT", "Cyclic input is not JSON.", "$");
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail(ctx, "SCENE_INVALID_STRUCTURE", "Custom prototypes are not accepted.", "$");
    const keys = Reflect.ownKeys(value);
    if (keys.length > SCENE_LIMITS.maxInputNodes) fail(ctx, "SCENE_LIMIT_EXCEEDED", "Too many input properties.", "$");
    if (array && value.length > 10_000) fail(ctx, "SCENE_LIMIT_EXCEEDED", "Array length exceeds 10000.", "$");
    if (array && keys.length !== value.length + 1) fail(ctx, "SCENE_INVALID_STRUCTURE", "Sparse or extended arrays are not accepted.", "$");
    active.add(value); add(2);
    let count = 0;
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || (array && !/^(0|[1-9][0-9]*)$/.test(key))) fail(ctx, "SCENE_INVALID_STRUCTURE", "Non-JSON property key.", "$");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) fail(ctx, "SCENE_INVALID_STRUCTURE", "Accessors and hidden properties are not accepted.", "$");
      if (count++) add(1);
      if (!array) { stringBytes(key); add(1); }
      visit(descriptor.value, depth + 1);
    }
    active.delete(value);
  };
  visit(raw, 1);
}
