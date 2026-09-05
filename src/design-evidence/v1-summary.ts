import { designEvidencePacketKind } from "./v1-canonical.js";
import type { DesignEvidencePacketV1, DesignEvidenceSummaryV1 } from "./v1-types.js";

export function summarizeDesignEvidencePacket(packet: DesignEvidencePacketV1): DesignEvidenceSummaryV1 {
  const kind = designEvidencePacketKind(packet);
  const visual = packet.schema === "tfsb.design-review" ? [] : packet.visualEvidence;
  const materials = packet.schema === "tfsb.design-review" ? [] : packet.materials;
  const provenanceKinds = [...new Set(materials.map((entry) => entry.kind))].sort();
  const common = {
    kind,
    schemaVersion: 1 as const,
    packetDigest: packet.schema === "tfsb.design-brief" ? packet.briefDigest : packet.schema === "tfsb.design-candidate" ? packet.candidateDigest : packet.reviewDigest,
    candidateCount: packet.schema === "tfsb.design-review" ? packet.candidateDigests.length : packet.schema === "tfsb.design-candidate" ? 1 : 0,
    visualEvidenceCount: visual.length,
    visualByteTotal: visual.reduce((total, evidence) => total + evidence.artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0), 0),
    annotationCount: packet.schema === "tfsb.design-review" ? packet.annotations.length : 0,
    dispositionCount: packet.schema === "tfsb.design-review" ? packet.dispositions.length : 0,
    provenanceKinds,
  };
  if (packet.schema === "tfsb.design-brief") return { ...common, context: packet.context };
  if (packet.schema === "tfsb.design-candidate") return { ...common, briefDigest: packet.briefDigest, proposalKind: packet.proposal.kind };
  return { ...common, briefDigest: packet.briefDigest };
}
