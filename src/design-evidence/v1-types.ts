import type { BrandVisualEvidenceResult, Sha256Digest } from "../service-protocol/v1-types.js";

export type DesignEvidenceDigest = Sha256Digest;
export type ProposalKind = "evidence-only" | "derive" | "qa-baseline" | "consumer-install" | "consumer-sync" | "export";
export type PacketTrustState = "local-current" | "context-matched-external" | "self-consistent-external" | "context-stale" | "context-mismatch" | "invalid";

export interface DesignEvidenceContextV1 {
  readonly corePackageVersion: "0.4.0";
  readonly studioVersion: "0.1.0";
  readonly studioProtocolVersion: "1.2";
  readonly project: { readonly label?: string; readonly canonicalDigest: Sha256Digest; readonly brandSystemDigest: Sha256Digest };
  readonly source?: { readonly packageId: string; readonly brandVersion: string; readonly brandSystemDigest: Sha256Digest };
}

export type DesignEvidenceTargetSelectorV1 =
  | { readonly kind: "asset"; readonly assetId: string }
  | { readonly kind: "binding"; readonly family: string; readonly role: string; readonly variant: string };

export interface DesignEvidenceTargetV1 {
  readonly targetId: string;
  readonly selector: DesignEvidenceTargetSelectorV1;
  readonly canonicalAssetDigest: Sha256Digest;
  readonly svgDigest: Sha256Digest;
  readonly purpose: string;
}

export interface DesignEvidenceRenderTupleV1 { readonly width: number; readonly height: number; readonly background: string }
export interface DesignEvidenceConstraintsV1 {
  readonly allowedProposalKinds: readonly ProposalKind[];
  readonly requiredTokenIds: readonly string[];
  readonly requiredRecipeIds: readonly string[];
  readonly qaProfileIds: readonly string[];
  readonly renderTuples: readonly DesignEvidenceRenderTupleV1[];
  readonly acceptanceCriteria: readonly string[];
  readonly prohibitedChanges: readonly string[];
}

export interface DesignEvidenceMaterialV1 {
  readonly kind: "user-supplied" | "tfsb-rendered" | "third-party" | "external-claim";
  readonly identifier: string;
  readonly digest: Sha256Digest;
  readonly licenseExpression?: string;
  readonly noticeDigest?: Sha256Digest;
}

export interface DesignBriefPacketV1 {
  readonly schema: "tfsb.design-brief";
  readonly schemaVersion: 1;
  readonly briefId: string;
  readonly revision: number;
  readonly title: string;
  readonly objective: string;
  readonly context: DesignEvidenceContextV1;
  readonly targets: readonly DesignEvidenceTargetV1[];
  readonly constraints: DesignEvidenceConstraintsV1;
  readonly materials: readonly DesignEvidenceMaterialV1[];
  readonly visualEvidence: readonly BrandVisualEvidenceResult[];
  readonly briefDigest: DesignEvidenceDigest;
}

export interface CandidateAuthorV1 {
  readonly kind: "human" | "agent" | "tool";
  readonly label: string;
  readonly toolName?: string;
  readonly toolVersion?: string;
}

export interface SourcePackageIntentV1 { readonly packageId: string; readonly brandVersion: string; readonly brandSystemDigest: Sha256Digest }
export interface ConsumerParameterIntentV1 { readonly profileId: string; readonly values: readonly { readonly parameter: string; readonly value: string }[] }
export type CandidateProposalIntentV1 =
  | { readonly kind: "evidence-only" }
  | { readonly kind: "derive"; readonly selection: { readonly kind: "all" } | { readonly kind: "recipes"; readonly recipeIds: readonly string[] } }
  | { readonly kind: "qa-baseline"; readonly profileId: string; readonly caseId: string }
  | { readonly kind: "consumer-install"; readonly sourcePackages: readonly SourcePackageIntentV1[]; readonly profileIds: readonly string[]; readonly parameters: readonly ConsumerParameterIntentV1[] }
  | { readonly kind: "consumer-sync"; readonly sourcePackages: readonly SourcePackageIntentV1[]; readonly profileIds?: readonly string[]; readonly parameters?: readonly ConsumerParameterIntentV1[] }
  | { readonly kind: "export"; readonly profileId: string; readonly outputIds?: readonly string[] };

export interface CandidateClaimV1 {
  readonly category: "composition" | "alignment" | "spacing" | "legibility" | "contrast" | "color" | "brand-fit" | "accessibility" | "small-size" | "technical" | "other";
  readonly severity: "note" | "minor" | "substantive" | "blocking";
  readonly message: string;
}
export interface CandidateQaSummaryV1 { readonly status: "pass" | "fail" | "skipped" | "unavailable" | "error"; readonly qaResultDigest?: Sha256Digest }

export interface DesignCandidatePacketV1 {
  readonly schema: "tfsb.design-candidate";
  readonly schemaVersion: 1;
  readonly briefDigest: DesignEvidenceDigest;
  readonly candidateId: string;
  readonly revision: number;
  readonly revisionOf?: DesignEvidenceDigest;
  readonly author: CandidateAuthorV1;
  readonly title: string;
  readonly rationale: string;
  readonly proposal: CandidateProposalIntentV1;
  readonly claims: readonly CandidateClaimV1[];
  readonly qaSummary: CandidateQaSummaryV1;
  readonly materials: readonly DesignEvidenceMaterialV1[];
  readonly visualEvidence: readonly BrandVisualEvidenceResult[];
  readonly candidateDigest: DesignEvidenceDigest;
}

export type ReviewAnnotationScopeV1 =
  | { readonly kind: "artifact" }
  | { readonly kind: "region"; readonly xMillionths: number; readonly yMillionths: number; readonly widthMillionths: number; readonly heightMillionths: number };
export interface ReviewAnnotationV1 {
  readonly annotationId: string;
  readonly candidateDigest: DesignEvidenceDigest;
  readonly visualEvidenceDigest: Sha256Digest;
  readonly artifactRole: "current" | "baseline" | "before" | "after";
  readonly pngDigest: Sha256Digest;
  readonly scope: ReviewAnnotationScopeV1;
  readonly category: CandidateClaimV1["category"];
  readonly severity: CandidateClaimV1["severity"];
  readonly comment: string;
  readonly elementId?: string;
}
export type CandidateDispositionValueV1 = "unreviewed" | "preferred" | "approved" | "rejected" | "needs-revision" | "deferred";
export interface CandidateDispositionV1 { readonly candidateDigest: DesignEvidenceDigest; readonly disposition: CandidateDispositionValueV1 }
export type ReviewOverallDispositionV1 =
  | { readonly kind: "no-decision" }
  | { readonly kind: "preferred" | "approved" | "needs-revision"; readonly candidateDigest: DesignEvidenceDigest }
  | { readonly kind: "rejected-all" };

export interface DesignReviewPacketV1 {
  readonly schema: "tfsb.design-review";
  readonly schemaVersion: 1;
  readonly briefDigest: DesignEvidenceDigest;
  readonly candidateDigests: readonly DesignEvidenceDigest[];
  readonly previousReviewDigest?: DesignEvidenceDigest;
  readonly annotations: readonly ReviewAnnotationV1[];
  readonly dispositions: readonly CandidateDispositionV1[];
  readonly overallDisposition: ReviewOverallDispositionV1;
  readonly summary: string;
  readonly reviewDigest: DesignEvidenceDigest;
}

export type DesignEvidencePacketV1 = DesignBriefPacketV1 | DesignCandidatePacketV1 | DesignReviewPacketV1;
export type DesignEvidencePacketKindV1 = "brief" | "candidate" | "review";
export interface DesignEvidenceSummaryV1 {
  readonly kind: DesignEvidencePacketKindV1;
  readonly schemaVersion: 1;
  readonly packetDigest: DesignEvidenceDigest;
  readonly briefDigest?: DesignEvidenceDigest;
  readonly candidateCount: number;
  readonly context?: DesignEvidenceContextV1;
  readonly proposalKind?: ProposalKind;
  readonly visualEvidenceCount: number;
  readonly visualByteTotal: number;
  readonly annotationCount: number;
  readonly dispositionCount: number;
  readonly provenanceKinds: readonly DesignEvidenceMaterialV1["kind"][];
}
