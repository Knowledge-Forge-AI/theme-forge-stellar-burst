import { describe, expect, it } from "vitest";

import { classifyCompanionRecord, classifyPairedCheckpoint, type PairedCheckpointInput } from "../src/classifier.js";
import type { Sha256Digest } from "../src/digests.js";

const A = `sha256:${"a".repeat(64)}` as Sha256Digest;
const B = `sha256:${"b".repeat(64)}` as Sha256Digest;
const C = `sha256:${"c".repeat(64)}` as Sha256Digest;

const aligned = { canonicalState: "present", canonicalDigest: A, archiveDigest: A, resolution: "aligned" } as const;
const canonical = { canonicalState: "present", canonicalDigest: B, archiveDigest: A, resolution: "canonical" } as const;

describe("paired-checkpoint classifier", () => {
  it.each<[string, PairedCheckpointInput, string]>([
    ["aligned unchanged", { recorded: aligned, currentCanonicalDigest: A, candidateArchiveDigest: A }, "UNCHANGED"],
    ["accepted divergence unchanged", { recorded: canonical, currentCanonicalDigest: B, candidateArchiveDigest: A }, "UNCHANGED_ACCEPTED_DIVERGENCE"],
    ["aligned archive changed", { recorded: aligned, currentCanonicalDigest: A, candidateArchiveDigest: B }, "ARCHIVE_CHANGED"],
    ["archive changes after canonical ownership", { recorded: canonical, currentCanonicalDigest: B, candidateArchiveDigest: C }, "CONFLICT"],
    ["canonical edited", { recorded: aligned, currentCanonicalDigest: B, candidateArchiveDigest: A }, "CANONICAL_EDITED"],
    ["both converge", { recorded: aligned, currentCanonicalDigest: B, candidateArchiveDigest: B }, "CONVERGED"],
    ["both diverge", { recorded: aligned, currentCanonicalDigest: B, candidateArchiveDigest: C }, "CONFLICT"],
    ["archive omission", { recorded: aligned, currentCanonicalDigest: A }, "ARCHIVE_OMISSION"],
    ["edited plus omission", { recorded: aligned, currentCanonicalDigest: B }, "ARCHIVE_OMISSION_CANONICAL_EDITED"],
    ["accepted absence stable", { recorded: { canonicalState: "absent", archiveDigest: A, resolution: "canonical" }, candidateArchiveDigest: A }, "UNCHANGED_ACCEPTED_ABSENCE"],
    ["accepted absence converges", { recorded: { canonicalState: "absent", archiveDigest: A, resolution: "canonical" } }, "CONVERGED_ABSENCE"],
    ["canonical unexpectedly missing", { recorded: aligned, candidateArchiveDigest: A }, "CANONICAL_MISSING"],
    ["untracked match", { currentCanonicalDigest: A, candidateArchiveDigest: A }, "UNTRACKED_MATCH"],
    ["untracked conflict", { currentCanonicalDigest: A, candidateArchiveDigest: B }, "UNTRACKED_CONFLICT"],
    ["new asset", { candidateArchiveDigest: A }, "NEW_ASSET"],
    ["untracked omission", { currentCanonicalDigest: A }, "ARCHIVE_OMISSION"],
  ])("classifies %s", (_name, input, expected) => {
    expect(classifyPairedCheckpoint(input)).toBe(expected);
  });

  it("applies the same paired checkpoints to opaque companion byte digests", () => {
    expect(classifyCompanionRecord({ recorded: aligned, currentCanonicalDigest: B, candidateArchiveDigest: C })).toBe("CONFLICT");
    expect(classifyCompanionRecord({ recorded: canonical, currentCanonicalDigest: B, candidateArchiveDigest: A })).toBe("UNCHANGED_ACCEPTED_DIVERGENCE");
  });
});
