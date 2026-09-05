import { isAbsolute } from "node:path";

import { DiagnosticError } from "../diagnostics.js";
import { ERROR_REGISTRY } from "./v1-registry.js";
import type { JsonRpcId, StudioErrorCode, StudioErrorResponse } from "./v1-types.js";

export class ProtocolError extends Error {
  constructor(
    readonly symbolicCode: StudioErrorCode,
    readonly safeLocation?: string,
  ) {
    super(symbolicCode);
    this.name = "ProtocolError";
  }
}

function location(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > 256 || isAbsolute(value) || value.includes("\\") || value.includes("\0")) return undefined;
  const pieces = value.split("/");
  if (pieces.some((piece) => piece === ".." || piece === ".")) return undefined;
  return value;
}

export function toProtocolError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error;
  if (error instanceof DiagnosticError) return new ProtocolError("DOMAIN_OPERATION_FAILED", location(error.diagnostic.location));
  return new ProtocolError("INTERNAL_ERROR");
}

export function errorResponse(id: JsonRpcId | null, error: ProtocolError): StudioErrorResponse {
  const entry = ERROR_REGISTRY[error.symbolicCode];
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: entry.numeric,
      message: entry.message,
      data: {
        code: error.symbolicCode,
        message: entry.message,
        retryable: entry.retryable,
        ...(error.safeLocation === undefined ? {} : { location: error.safeLocation }),
      },
    },
  };
}
