import type { CanonicalState, ProvenanceResolution } from "./provenance.js";
import type { Sha256Digest } from "./digests.js";

export type PairedCheckpointClassification =
  | "UNCHANGED"
  | "UNCHANGED_ACCEPTED_DIVERGENCE"
  | "ARCHIVE_CHANGED"
  | "CANONICAL_EDITED"
  | "CONVERGED"
  | "CONFLICT"
  | "ARCHIVE_OMISSION"
  | "ARCHIVE_OMISSION_CANONICAL_EDITED"
  | "UNCHANGED_ACCEPTED_ABSENCE"
  | "CONVERGED_ABSENCE"
  | "CANONICAL_MISSING"
  | "UNTRACKED_MATCH"
  | "UNTRACKED_CONFLICT"
  | "NEW_ASSET";

export interface RecordedCheckpoint {
  readonly canonicalState: CanonicalState;
  readonly canonicalDigest?: Sha256Digest;
  readonly archiveDigest: Sha256Digest;
  readonly resolution: ProvenanceResolution;
}

export interface PairedCheckpointInput {
  readonly recorded?: RecordedCheckpoint;
  readonly currentCanonicalDigest?: Sha256Digest;
  readonly candidateArchiveDigest?: Sha256Digest;
}

export function classifyPairedCheckpoint(input: PairedCheckpointInput): PairedCheckpointClassification {
  const { recorded, currentCanonicalDigest: canonical, candidateArchiveDigest: candidate } = input;
  if (recorded === undefined) {
    if (canonical === undefined) return candidate === undefined ? "UNCHANGED" : "NEW_ASSET";
    if (candidate === undefined) return "ARCHIVE_OMISSION";
    return canonical === candidate ? "UNTRACKED_MATCH" : "UNTRACKED_CONFLICT";
  }
  if (canonical === undefined) {
    if (recorded.canonicalState === "absent") {
      if (candidate === undefined) return "CONVERGED_ABSENCE";
      if (candidate === recorded.archiveDigest && recorded.resolution === "canonical") {
        return "UNCHANGED_ACCEPTED_ABSENCE";
      }
      return "CONFLICT";
    }
    return "CANONICAL_MISSING";
  }
  const canonicalChanged = canonical !== recorded.canonicalDigest;
  if (candidate === undefined) {
    return canonicalChanged ? "ARCHIVE_OMISSION_CANONICAL_EDITED" : "ARCHIVE_OMISSION";
  }
  const archiveChanged = candidate !== recorded.archiveDigest;
  if (!canonicalChanged && !archiveChanged) {
    return recorded.resolution === "aligned" ? "UNCHANGED" : "UNCHANGED_ACCEPTED_DIVERGENCE";
  }
  if (!canonicalChanged && archiveChanged) {
    return recorded.resolution === "aligned" ? "ARCHIVE_CHANGED" : "CONFLICT";
  }
  if (canonicalChanged && !archiveChanged) return "CANONICAL_EDITED";
  return canonical === candidate ? "CONVERGED" : "CONFLICT";
}

export const classifyAssetRecord = classifyPairedCheckpoint;
export const classifyCompanionRecord = classifyPairedCheckpoint;
