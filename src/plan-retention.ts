/**
 * Internal plan-retention accounting shared by domain adapters.
 *
 * This module is intentionally not re-exported from the package root.  Domain
 * inspectors pass their authentic public plan together with the private
 * WeakMap-owned state so callers cannot estimate retention from a DTO alone.
 */

export type PlanNativeSnapshot = "none" | "directory";

export interface PlanRetentionInspection {
  /** Each distinct retained Uint8Array/Buffer instance, including copies. */
  readonly byteArrays: readonly Uint8Array[];
  /** UTF-8 byte lengths, one entry for every retained string occurrence. */
  readonly stringByteLengths: readonly number[];
  readonly nativeSnapshot: PlanNativeSnapshot;
  readonly byteArrayBytes: number;
  readonly stringBytes: number;
  readonly retainedBytes: number;
}

interface MutableInspection {
  readonly seen: Set<object>;
  readonly byteArrays: Uint8Array[];
  readonly stringByteLengths: number[];
}

function visit(value: unknown, state: MutableInspection): void {
  if (typeof value === "string") {
    state.stringByteLengths.push(Buffer.byteLength(value, "utf8"));
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (state.seen.has(value)) return;
  state.seen.add(value);
  if (value instanceof Uint8Array) {
    state.byteArrays.push(value);
    return;
  }
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      visit(key, state);
      visit(entry, state);
    }
    return;
  }
  if (value instanceof Set) {
    for (const entry of value) visit(entry, state);
    return;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) visit(descriptor.value, state);
  }
}

function finish(state: MutableInspection, nativeSnapshot: PlanNativeSnapshot): PlanRetentionInspection {
  const byteArrays = Object.freeze([...state.byteArrays]);
  const stringByteLengths = Object.freeze([...state.stringByteLengths]);
  const byteArrayBytes = byteArrays.reduce((sum, bytes) => sum + bytes.byteLength, 0);
  const stringBytes = stringByteLengths.reduce((sum, length) => sum + length, 0);
  return Object.freeze({
    byteArrays,
    stringByteLengths,
    nativeSnapshot,
    byteArrayBytes,
    stringBytes,
    retainedBytes: byteArrayBytes + stringBytes,
  });
}

/** Inspect all data properties, including non-enumerable and symbol-owned values. */
export function inspectPlanRetention(
  roots: readonly unknown[],
  nativeSnapshot: PlanNativeSnapshot = "none",
): PlanRetentionInspection {
  const state: MutableInspection = { seen: new Set(), byteArrays: [], stringByteLengths: [] };
  for (const root of roots) visit(root, state);
  return finish(state, nativeSnapshot);
}

/** Merge separately inspected roots while preserving byte-array identity. */
export function mergePlanRetention(...inspections: readonly PlanRetentionInspection[]): PlanRetentionInspection {
  const byteArrays: Uint8Array[] = [];
  const seen = new Set<Uint8Array>();
  const stringByteLengths: number[] = [];
  let nativeSnapshot: PlanNativeSnapshot = "none";
  for (const inspection of inspections) {
    for (const bytes of inspection.byteArrays) {
      if (!seen.has(bytes)) {
        seen.add(bytes);
        byteArrays.push(bytes);
      }
    }
    stringByteLengths.push(...inspection.stringByteLengths);
    if (inspection.nativeSnapshot === "directory") nativeSnapshot = "directory";
  }
  return finish({ seen: new Set(), byteArrays, stringByteLengths }, nativeSnapshot);
}
