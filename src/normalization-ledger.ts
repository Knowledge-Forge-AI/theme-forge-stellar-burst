import type { AnalyzeNormalization, CommonV03Classification, Schema1Classification } from "./analyze-contract.js";
import type { Sha256Digest } from "./digests.js";
import type { UnlabelledAccessibilityAuthority } from "./normalization-map.js";

export const NORMALIZATION_LEDGER_SCHEMA_VERSION = 1 as const;

/** Ledger-only parser canonicalization fact; this does not revise analyze/details schema 1. */
export type NormalizationOperationCode = AnalyzeNormalization | "canonicalize_parser_whitespace";
export type NormalizationDisposition = "direct" | "normalized" | "rejected_unsupported" | "rejected_unsafe" | "missing_authority";

export interface NormalizationLedgerEntryV1 {
  readonly source: string;
  readonly sourceDigest: Sha256Digest;
  readonly schema1Classification: Schema1Classification;
  readonly commonV03Classification: CommonV03Classification;
  readonly consumedAccessibilityAuthority: UnlabelledAccessibilityAuthority | null;
  readonly operations: readonly NormalizationOperationCode[];
  readonly beforeSemanticDigest: Sha256Digest | null;
  readonly afterCanonicalDigest: Sha256Digest | null;
  readonly policyDigest: Sha256Digest;
  readonly disposition: NormalizationDisposition;
}

export interface NormalizationLedgerV1 {
  readonly schemaVersion: typeof NORMALIZATION_LEDGER_SCHEMA_VERSION;
  readonly entries: readonly NormalizationLedgerEntryV1[];
}
