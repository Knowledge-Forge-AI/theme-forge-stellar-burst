import type {
  Diagnostic,
  DiagnosticDomain,
  DiagnosticOperation,
  Result,
} from "./types.js";

export interface DiagnosticContext {
  readonly operation: DiagnosticOperation;
  readonly domain: DiagnosticDomain;
  readonly source?: string;
}

export function diagnostic(
  context: DiagnosticContext,
  code: string,
  message: string,
  location?: string,
): Diagnostic {
  return {
    code,
    operation: context.operation,
    domain: context.domain,
    message,
    ...(context.source === undefined ? {} : { source: context.source }),
    ...(location === undefined ? {} : { location }),
  };
}

export class DiagnosticError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(value: Diagnostic) {
    super(value.message);
    this.name = "DiagnosticError";
    this.diagnostic = value;
  }
}

export function fail(
  context: DiagnosticContext,
  code: string,
  message: string,
  location?: string,
): never {
  throw new DiagnosticError(diagnostic(context, code, message, location));
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fromCaught<T>(
  error: unknown,
  context: DiagnosticContext,
  fallbackCode: string,
  fallbackMessage: string,
  isExpectedInputError?: (error: unknown) => boolean,
): Result<T> {
  if (error instanceof DiagnosticError) {
    return { ok: false, diagnostics: [error.diagnostic] };
  }
  if (isExpectedInputError === undefined || !isExpectedInputError(error)) {
    throw error;
  }
  return {
    ok: false,
    diagnostics: [diagnostic(context, fallbackCode, fallbackMessage)],
  };
}
