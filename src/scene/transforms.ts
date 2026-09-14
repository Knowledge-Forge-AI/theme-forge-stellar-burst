import { DiagnosticError, fail, type DiagnosticContext } from "../diagnostics.js";
import { formatCanonicalNumber } from "./canonical.js";
import type { TransformOperation } from "./types.js";

/**
 * 2D affine transform matrix represented as a 6-element tuple:
 * [a, b, c, d, e, f] corresponding to column-major:
 *   [ a  c  e ]
 *   [ b  d  f ]
 *   [ 0  0  1 ]
 */
export type Matrix2D = readonly [number, number, number, number, number, number];

export const IDENTITY_MATRIX: Matrix2D = Object.freeze([1, 0, 0, 1, 0, 0]);

function norm(n: number): number {
  if (Object.is(n, -0) || n === 0) return 0;
  return n;
}

/**
 * Multiply two 2D affine matrices: M1 * M2
 * Applying to a point: (M1 * M2) * point = M1 * (M2 * point)
 */
export function multiplyMatrices(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;

  const a = a1 * a2 + c1 * b2;
  const b = b1 * a2 + d1 * b2;
  const c = a1 * c2 + c1 * d2;
  const d = b1 * c2 + d1 * d2;
  const e = a1 * e2 + c1 * f2 + e1;
  const f = b1 * e2 + d1 * f2 + f1;

  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    !Number.isFinite(c) ||
    !Number.isFinite(d) ||
    !Number.isFinite(e) ||
    !Number.isFinite(f)
  ) {
    throw new DiagnosticError({
      code: "SCENE_NON_FINITE_TRANSFORM",
      operation: "build",
      domain: "scene" as any,
      message: "Intermediate transform matrix produced non-finite values.",
    });
  }

  return [norm(a), norm(b), norm(c), norm(d), norm(e), norm(f)];
}

/**
 * Convert a single transform operation to its 2D affine matrix.
 * Rotation centers are lowered explicitly:
 *   T(cx, cy) * R(angle) * T(-cx, -cy)
 */
export function operationToMatrix(op: TransformOperation): Matrix2D {
  switch (op.type) {
    case "translate": {
      const tx = op.x;
      const ty = op.y ?? 0;
      return [1, 0, 0, 1, norm(tx), norm(ty)];
    }
    case "scale": {
      const sx = op.x;
      const sy = op.y ?? sx;
      return [norm(sx), 0, 0, norm(sy), 0, 0];
    }
    case "rotate": {
      // Compiler-level-1 trigonometry: binary64 remainder reduction to the
      // nearest quadrant, then 12 fixed Taylor recurrence steps on [-pi/4,pi/4].
      // Do not replace with host sin/cos: their approximation is engine-specific.
      const angle = op.angle % 360;
      const quadrant = Math.round(angle / 90);
      const reduced = angle - quadrant * 90;
      const x = reduced * (3.141592653589793 / 180);
      const x2 = x * x;
      let sinTerm = x, cosTerm = 1, sinBase = x, cosBase = 1;
      for (let n = 1; n <= 12; n++) {
        sinTerm *= -x2 / ((2 * n) * (2 * n + 1));
        cosTerm *= -x2 / ((2 * n - 1) * (2 * n));
        sinBase += sinTerm;
        cosBase += cosTerm;
      }
      let cos: number, sin: number;
      switch (((quadrant % 4) + 4) % 4) {
        case 0: cos = cosBase; sin = sinBase; break;
        case 1: cos = -sinBase; sin = cosBase; break;
        case 2: cos = -cosBase; sin = -sinBase; break;
        default: cos = sinBase; sin = -cosBase; break;
      }
      const rotMat: Matrix2D = [norm(cos), norm(sin), norm(-sin), norm(cos), 0, 0];
      if (op.cx === undefined || op.cy === undefined || (op.cx === 0 && op.cy === 0)) {
        return rotMat;
      }
      const toOrigin: Matrix2D = [1, 0, 0, 1, norm(-op.cx), norm(-op.cy)];
      const backFromOrigin: Matrix2D = [1, 0, 0, 1, norm(op.cx), norm(op.cy)];
      // T(cx, cy) * R(angle) * T(-cx, -cy)
      return multiplyMatrices(backFromOrigin, multiplyMatrices(rotMat, toOrigin));
    }
    case "matrix": {
      return [
        norm(op.a),
        norm(op.b),
        norm(op.c),
        norm(op.d),
        norm(op.e),
        norm(op.f),
      ];
    }
  }
}

/**
 * Compose an ordered list of transforms into a single composite Matrix2D.
 * List [A, B] means A x B x point, matching emitted SVG transform order.
 */
export function composeTransforms(
  operations: readonly TransformOperation[],
): Matrix2D {
  let current: Matrix2D = IDENTITY_MATRIX;
  for (const op of operations) {
    const mat = operationToMatrix(op);
    current = multiplyMatrices(current, mat);
  }
  return current;
}

/**
 * Apply a 2D affine matrix to a point [x, y] -> [x', y'].
 */
export function transformPoint(
  mat: Matrix2D,
  point: readonly [number, number],
): readonly [number, number] {
  const [a, b, c, d, e, f] = mat;
  const [x, y] = point;
  const nx = a * x + c * y + e;
  const ny = b * x + d * y + f;
  return [norm(nx), norm(ny)];
}

/**
 * Explicitly lower rotation centers: if a rotate operation has (cx, cy),
 * decompose into [translate(cx, cy), rotate(angle), translate(-cx, -cy)].
 */
export function lowerTransformOperations(
  operations: readonly TransformOperation[],
): readonly TransformOperation[] {
  const lowered: TransformOperation[] = [];
  for (const op of operations) {
    if (
      op.type === "rotate" &&
      op.cx !== undefined &&
      op.cy !== undefined &&
      (op.cx !== 0 || op.cy !== 0)
    ) {
      lowered.push(
        { type: "translate", x: op.cx, y: op.cy },
        { type: "rotate", angle: op.angle },
        { type: "translate", x: norm(-op.cx), y: norm(-op.cy) },
      );
    } else {
      lowered.push(op);
    }
  }
  return lowered;
}

/**
 * Validate that transform numbers are finite and operations are supported.
 */
export function validateTransformOperations(
  operations: readonly unknown[],
  ctx: DiagnosticContext,
  location: string,
): readonly TransformOperation[] {
  if (operations.length > 32) fail(ctx, "SCENE_LIMIT_EXCEEDED", "Transform lists are limited to 32 operations.", location);
  const result: TransformOperation[] = [];
  for (let i = 0; i < operations.length; i += 1) {
    const raw = operations[i];
    const loc = `${location}[${i}]`;
    if (typeof raw !== "object" || raw === null) {
      fail(ctx, "SCENE_INVALID_TRANSFORM", "Transform operation must be an object.", loc);
    }
    const op = raw as Record<string, unknown>;
    const type = op["type"];
    const allowed = type === "matrix" ? ["type", "a", "b", "c", "d", "e", "f"] : type === "rotate" ? ["type", "angle", "cx", "cy"] : ["type", "x", "y"];
    if (Object.keys(op).some((key) => !allowed.includes(key))) fail(ctx, "SCENE_UNKNOWN_PROPERTY", "Unknown transform property.", loc);
    if (type === "translate") {
      const x = op["x"];
      const y = op["y"];
      if (typeof x !== "number" || !Number.isFinite(x)) {
        fail(ctx, "SCENE_INVALID_NUMBER", "translate x must be a finite number.", `${loc}.x`);
      }
      if (y !== undefined && (typeof y !== "number" || !Number.isFinite(y))) {
        fail(ctx, "SCENE_INVALID_NUMBER", "translate y must be a finite number.", `${loc}.y`);
      }
      result.push({
        type: "translate",
        x: norm(x),
        ...(y !== undefined ? { y: norm(y) } : {}),
      });
    } else if (type === "scale") {
      const x = op["x"];
      const y = op["y"];
      if (typeof x !== "number" || !Number.isFinite(x)) {
        fail(ctx, "SCENE_INVALID_NUMBER", "scale x must be a finite number.", `${loc}.x`);
      }
      if (y !== undefined && (typeof y !== "number" || !Number.isFinite(y))) {
        fail(ctx, "SCENE_INVALID_NUMBER", "scale y must be a finite number.", `${loc}.y`);
      }
      result.push({
        type: "scale",
        x: norm(x),
        ...(y !== undefined ? { y: norm(y) } : {}),
      });
    } else if (type === "rotate") {
      const angle = op["angle"];
      const cx = op["cx"];
      const cy = op["cy"];
      if (typeof angle !== "number" || !Number.isFinite(angle)) {
        fail(ctx, "SCENE_INVALID_NUMBER", "rotate angle must be a finite number.", `${loc}.angle`);
      }
      if (cx !== undefined && (typeof cx !== "number" || !Number.isFinite(cx))) {
        fail(ctx, "SCENE_INVALID_NUMBER", "rotate cx must be a finite number.", `${loc}.cx`);
      }
      if (cy !== undefined && (typeof cy !== "number" || !Number.isFinite(cy))) {
        fail(ctx, "SCENE_INVALID_NUMBER", "rotate cy must be a finite number.", `${loc}.cy`);
      }
      if ((cx !== undefined && cy === undefined) || (cx === undefined && cy !== undefined)) {
        fail(ctx, "SCENE_INVALID_TRANSFORM", "rotate requires both cx and cy if rotation center is specified.", loc);
      }
      result.push({
        type: "rotate",
        angle: norm(angle),
        ...(cx !== undefined && cy !== undefined ? { cx: norm(cx), cy: norm(cy) } : {}),
      });
    } else if (type === "matrix") {
      const keys = ["a", "b", "c", "d", "e", "f"] as const;
      const values: number[] = [];
      for (const k of keys) {
        const val = op[k];
        if (typeof val !== "number" || !Number.isFinite(val)) {
          fail(ctx, "SCENE_INVALID_NUMBER", `matrix ${k} must be a finite number.`, `${loc}.${k}`);
        }
        values.push(norm(val));
      }
      result.push({
        type: "matrix",
        a: values[0]!,
        b: values[1]!,
        c: values[2]!,
        d: values[3]!,
        e: values[4]!,
        f: values[5]!,
      });
    } else {
      fail(
        ctx,
        "SCENE_INVALID_TRANSFORM",
        `Unsupported transform type '${String(type)}'. Only translate, scale, rotate, and matrix are allowed.`,
        loc,
      );
    }
  }
  return result;
}

/**
 * Serialize transform operations into an SVG transform attribute string.
 * Emits in exact authored order.
 */
export function serializeTransforms(
  operations: readonly TransformOperation[] | undefined,
): string | undefined {
  if (operations === undefined || operations.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  for (const op of operations) {
    switch (op.type) {
      case "translate": {
        const yPart = op.y !== undefined ? ` ${formatCanonicalNumber(op.y)}` : "";
        parts.push(`translate(${formatCanonicalNumber(op.x)}${yPart})`);
        break;
      }
      case "scale": {
        const yPart = op.y !== undefined ? ` ${formatCanonicalNumber(op.y)}` : "";
        parts.push(`scale(${formatCanonicalNumber(op.x)}${yPart})`);
        break;
      }
      case "rotate": {
        if (op.cx !== undefined && op.cy !== undefined) {
          parts.push(
            `rotate(${formatCanonicalNumber(op.angle)} ${formatCanonicalNumber(op.cx)} ${formatCanonicalNumber(op.cy)})`,
          );
        } else {
          parts.push(`rotate(${formatCanonicalNumber(op.angle)})`);
        }
        break;
      }
      case "matrix": {
        parts.push(
          `matrix(${formatCanonicalNumber(op.a)} ${formatCanonicalNumber(op.b)} ${formatCanonicalNumber(op.c)} ${formatCanonicalNumber(op.d)} ${formatCanonicalNumber(op.e)} ${formatCanonicalNumber(op.f)})`,
        );
        break;
      }
    }
  }
  return parts.join(" ");
}
