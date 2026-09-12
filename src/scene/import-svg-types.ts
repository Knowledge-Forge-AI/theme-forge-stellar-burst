import type { VectorScene } from "./types.js";

/**
 * Alias for VectorScene to match public scene API contract.
 */
export type Scene = VectorScene;

/**
 * Terminal classification set for SVG import.
 */
export type SceneImportClassification =
  | "SUPPORTED_IMPORT"
  | "SUPPORTED_ANALYZE_ONLY"
  | "DEFERRED_TIER2"
  | "REJECTED_UNSAFE"
  | "REJECTED_OUT_OF_SCOPE"
  | "INVALID_INPUT";

/**
 * Observed features during SVG import inspection.
 */
export interface SceneImportFeatures {
  readonly tags: readonly string[];
  readonly attributes: readonly string[];
  readonly patterns: readonly string[];
  readonly complete: boolean;
}

/**
 * Result of importing an SVG byte buffer into the scene domain.
 */
export interface SceneImportResult {
  readonly classification: SceneImportClassification;
  readonly reasonCodes: readonly string[];
  readonly features: SceneImportFeatures;
  readonly scene?: VectorScene;
  readonly canonicalScene?: string;
  readonly normalizations: readonly string[];
  readonly sourceSha256: string;
}
